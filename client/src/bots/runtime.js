// CelChat bot runtime. This file is prepended to every bot's code and runs in a Web Worker inside a
// sandboxed iframe: no DOM, no access to CelChat's storage or keys, and no network unless the bot's
// owner allowed it. Everything a bot does goes through `bot.*` calls that CelChat checks and signs.
'use strict';
const __cel = (() => {
  const post = (m) => {
    try {
      self.postMessage(m);
    } catch (e) {
      self.postMessage({ t: 'log', level: 'error', args: ['Could not send to CelChat: ' + (e && e.message)] });
    }
  };
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    try {
      return JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const log = (level, args) => post({ t: 'log', level, args: args.map(fmt) });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...a) => log(level === 'debug' ? 'log' : level, a);
  }
  self.addEventListener('error', (e) => {
    e.preventDefault();
    log('error', [e.error || e.message]);
  });
  self.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    log('error', [e.reason]);
  });

  const me = typeof __CEL_ME === 'object' && __CEL_ME ? __CEL_ME : {};
  if (!me.network) {
    const blocked = () => Promise.reject(new Error('This bot is not allowed to use the internet. Its owner can turn that on in the bot settings.'));
    self.fetch = blocked;
  }

  // ---- calls into CelChat --------------------------------------------------------------------
  let seq = 0;
  const pending = new Map();
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try {
        self.postMessage({ t: 'call', id, method, args });
      } catch (e) {
        pending.delete(id);
        reject(new Error(method + ': the arguments cannot be sent to CelChat (' + e.message + ')'));
      }
    });

  // ---- registries ------------------------------------------------------------------------------
  const EVENTS = ['ready', 'message', 'button', 'reaction', 'memberJoin', 'memberLeave'];
  const ARG_TYPES = ['text', 'word', 'number', 'integer', 'user', 'channel', 'role', 'boolean'];
  const commands = new Map();
  const listeners = new Map();
  const buttons = [];
  let announced = 0;
  let isLoaded = false;
  const announce = () => {
    if (!isLoaded) return;
    clearTimeout(announced);
    announced = setTimeout(() => post({ t: 'commands', list: [...commands.values()].map((c) => c.spec) }), 50);
  };

  const run = async (what, fn, ...a) => {
    try {
      await fn(...a);
    } catch (e) {
      log('error', ['Error in ' + what + ':', e]);
    }
  };

  // ---- wrappers around plain data CelChat sends --------------------------------------------------
  const user = (u, c) =>
    u && {
      ...u,
      mention: '<@' + u.id + '>',
      toString: () => '<@' + u.id + '>',
      kick: (reason) => call('kick', c, u.id, reason),
      ban: (reason, opts) => call('ban', c, u.id, reason, opts || {}),
      timeout: (seconds, reason) => call('timeout', c, u.id, seconds, reason),
      addRole: (role) => call('role', c, u.id, String(role && role.id ? role.id : role), true),
      removeRole: (role) => call('role', c, u.id, String(role && role.id ? role.id : role), false),
      hasRole: (role) => !!(u.roles || []).find((r) => r.id === role || r.name.toLowerCase() === String(role).toLowerCase()),
      /** permission names: ADMIN, MANAGE_COMMUNITY, MANAGE_ROLES, MANAGE_MESSAGES, KICK, BAN, TIMEOUT, ... */
      can: (perm) => !!u.owner || (u.permissions || []).includes('ADMIN') || (u.permissions || []).includes(String(perm).toUpperCase()),
      setNickname: (nick) => call('nick', c, u.id, nick == null ? null : String(nick)),
    };
  const ref = (r) =>
    r && {
      id: r.id,
      c: r.c,
      ch: r.ch,
      edit: (content) => call('edit', r.c, r.id, content).then(ref),
      delete: () => call('delete', r.c, r.id),
      react: (emoji) => call('react', r.c, r.id, String(emoji), true),
      unreact: (emoji) => call('react', r.c, r.id, String(emoji), false),
      pin: () => call('pin', r.c, r.id, true),
      unpin: () => call('pin', r.c, r.id, false),
    };
  const channel = (ch, c) =>
    ch && {
      ...ch,
      mention: '<#' + ch.id + '>',
      toString: () => '<#' + ch.id + '>',
      send: (content) => call('send', c, ch.id, content).then(ref),
      messages: (limit) => call('history', c, ch.id, limit || 20).then((l) => l.map(message)),
    };
  const community = (x) =>
    x && {
      ...x,
      channel: (nameOrId) => call('channel', x.id, String(nameOrId)).then((ch) => channel(ch, x.id)),
      channels: () => call('channels', x.id).then((l) => l.map((ch) => channel(ch, x.id))),
      members: () => call('members', x.id).then((l) => l.map((u) => user(u, x.id))),
      member: (id) => call('member', x.id, String(id && id.id ? id.id : id)).then((u) => user(u, x.id)),
      roles: () => call('roles', x.id),
    };
  const message = (d) =>
    d && {
      ...d,
      ...ref(d),
      content: d.text,
      author: user(d.author, d.c),
      channel: channel(d.channel, d.c),
      community: community(d.community),
      reply: (content) => call('send', d.c, d.ch, content, d.id).then(ref),
      send: (content) => call('send', d.c, d.ch, content).then(ref),
    };

  const dispatch = async (name, d) => {
    if (name === 'command') {
      const c = commands.get(d.name);
      if (!c) return;
      const ctx = message(d.message);
      const args = {};
      for (const [k, v] of Object.entries(d.args || {})) {
        const type = (d.types || {})[k];
        args[k] = v == null ? v : type === 'user' ? user(v, d.message.c) : type === 'channel' ? channel(v, d.message.c) : v;
      }
      d.args = args;
      ctx.args = args;
      ctx.command = d.name;
      ctx.user = ctx.author;
      await run('/' + d.name, c.fn, ctx, d.args);
      return;
    }
    if (name === 'button') {
      const ctx = {
        id: d.buttonId,
        buttonId: d.buttonId,
        user: user(d.user, d.c),
        message: { ...ref(d.message), text: d.message.text, embeds: d.message.embeds, buttons: d.message.buttons },
        channel: channel(d.channel, d.c),
        community: community(d.community),
        reply: (content) => call('send', d.c, d.ch, content, d.message.id).then(ref),
        send: (content) => call('send', d.c, d.ch, content).then(ref),
        update: (content) => call('edit', d.c, d.message.id, content).then(ref),
      };
      for (const [match, fn] of buttons) {
        if (match === d.buttonId || (match.endsWith(':') && d.buttonId.startsWith(match))) await run('button "' + d.buttonId + '"', fn, ctx);
      }
      for (const fn of listeners.get('button') || []) await run('button', fn, ctx);
      return;
    }
    let data = d;
    if (name === 'message') data = message(d);
    else if (name === 'reaction') data = { ...d, user: user(d.user, d.c), message: ref(d.message), channel: channel(d.channel, d.c), community: community(d.community) };
    else if (name === 'memberJoin' || name === 'memberLeave') data = { ...d, user: user(d.user, d.community.id), community: community(d.community) };
    for (const fn of listeners.get(name) || []) await run(name, fn, data);
  };

  self.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    } else if (m.t === 'ping') post({ t: 'pong', n: m.n });
    else if (m.t === 'event') void dispatch(m.name, m.data);
  });

  // ---- the `bot` global --------------------------------------------------------------------------
  const normArg = (a, i, all, cmd) => {
    if (typeof a === 'string') {
      const m = /^([a-z0-9_-]{1,32})(?::([a-z]+))?(\?)?$/.exec(a.trim().toLowerCase());
      if (!m) throw new Error('Bad argument "' + a + '" for /' + cmd + '. Write it as "name", "name:type" or "name:type?" (? = optional).');
      a = { name: m[1], type: m[2] || 'word', optional: !!m[3] };
    }
    if (!a || typeof a !== 'object' || !a.name) throw new Error('Arguments of /' + cmd + ' need a name.');
    const type = a.type || 'word';
    if (!ARG_TYPES.includes(type)) throw new Error('Unknown argument type "' + type + '" in /' + cmd + '. Use one of: ' + ARG_TYPES.join(', '));
    if (type === 'text' && i !== all.length - 1) throw new Error('In /' + cmd + ', a "text" argument takes the rest of the message, so it must come last.');
    const out = { name: String(a.name).toLowerCase(), type };
    const desc = a.desc || a.description;
    if (desc) out.desc = String(desc).slice(0, 100);
    if (a.optional) out.optional = true;
    if (Array.isArray(a.choices) && a.choices.length) out.choices = a.choices.map(String).slice(0, 25);
    return out;
  };

  const bot = {
    get id() {
      return me.id;
    },
    get name() {
      return me.name;
    },
    get username() {
      return me.username;
    },
    get mention() {
      return '<@' + me.id + '>';
    },
    get canUseInternet() {
      return !!me.network;
    },
    /** the commands registered so far: [{ name, desc, args }] */
    get commands() {
      return [...commands.values()].map((c) => c.spec);
    },
    /**
     * bot.command('roll', 'Roll a die', ['sides:integer?'], async (ctx, args) => ctx.reply('...'))
     * Forms: (name, fn) | (name, description, fn) | (name, description, args, fn) | (name, { description, args }, fn)
     */
    command(name, ...rest) {
      const fn = rest.pop();
      if (typeof fn !== 'function') throw new TypeError('bot.command(name, ..., handler): the last argument must be a function.');
      let desc = '';
      let args = [];
      for (const r of rest) {
        if (typeof r === 'string') desc = r;
        else if (Array.isArray(r)) args = r;
        else if (r && typeof r === 'object') {
          if (typeof r.description === 'string') desc = r.description;
          if (typeof r.desc === 'string') desc = r.desc;
          if (Array.isArray(r.args)) args = r.args;
        }
      }
      name = String(name).toLowerCase().replace(/^\//, '');
      if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('Command names are 1 to 32 characters of a-z, 0-9, _ and -. Got "' + name + '".');
      if (commands.size >= 50 && !commands.has(name)) throw new Error('A bot can have at most 50 commands.');
      commands.set(name, { spec: { name, desc: String(desc).slice(0, 100), args: args.map((a, i, all) => normArg(a, i, all, name)) }, fn });
      announce();
      return bot;
    },
    on(event, fn) {
      if (!EVENTS.includes(event)) throw new Error('Unknown event "' + event + '". Events: ' + EVENTS.join(', '));
      if (typeof fn !== 'function') throw new TypeError('bot.on(event, handler): handler must be a function.');
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return bot;
    },
    /** handle presses of a button id, or of every id starting with a prefix that ends in ":" */
    button(idOrPrefix, fn) {
      if (typeof fn !== 'function') throw new TypeError('bot.button(id, handler): handler must be a function.');
      buttons.push([String(idOrPrefix), fn]);
      return bot;
    },
    every(seconds, fn) {
      const ms = Math.max(5, Number(seconds) || 0) * 1000;
      return setInterval(() => run('timer', fn), ms);
    },
    after(seconds, fn) {
      return setTimeout(() => run('timer', fn), Math.max(0, Number(seconds) || 0) * 1000);
    },
    cancel(id) {
      clearInterval(id);
      clearTimeout(id);
    },
    communities: () => call('communities').then((l) => l.map(community)),
    community: (id) => call('community', String(id)).then(community),
    /** send to a channel object, or bot.send(communityId, channelNameOrId, content) */
    send(target, a, b) {
      if (target && typeof target === 'object' && target.id && target.community) return call('send', target.community, target.id, a).then(ref);
      return call('channel', String(target), String(a)).then((ch) => call('send', String(target), ch.id, b).then(ref));
    },
    setStatus: (text, emoji) => call('status', text == null ? null : String(text), emoji == null ? null : String(emoji)),
    storage: {
      // missing keys come back as null over postMessage, so null means "not set" too
      get: (key, fallback) => call('storage', 'get', String(key)).then((v) => (v === undefined || v === null ? fallback : v)),
      set: (key, value) => call('storage', 'set', String(key), value),
      delete: (key) => call('storage', 'delete', String(key)),
      keys: () => call('storage', 'keys'),
    },
    log: (...a) => log('log', a),
  };
  Object.freeze(bot.storage);
  self.bot = Object.freeze(bot);

  return {
    loaded() {
      if (isLoaded) return;
      isLoaded = true;
      post({ t: 'loaded', commands: [...commands.values()].map((c) => c.spec) });
    },
    fail(e) {
      log('error', ['Your code threw an error while starting:', e]);
    },
  };
})();
setTimeout(() => __cel.loaded(), 3000);
