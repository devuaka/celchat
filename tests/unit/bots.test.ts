import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { keysFromSeed, newSeed, type Keys } from '@shared/crypto';
import { createOp, verifyOp, groupOrCommunityId, parsePayload, type Op } from '@shared/ops';
import { Engine, type CommunityState } from '@shared/engine';
import { signProfile, verifyProfile, defaultProfile, isAppBot, isArchivePeer, isRelayOnly } from '@shared/profile';
import { randomHex } from '@shared/bytes';
// @ts-expect-error plain .mjs build script
import { buildSandbox } from '../../scripts/sandbox-csp.mjs';

class Actor {
  keys: Keys = keysFromSeed(newSeed());
  dv = randomHex(8);
  seq = new Map<string, number>();
  get pub() {
    return this.keys.pub;
  }
  op(c: string, k: string, p: unknown, l: number): Op {
    const s = (this.seq.get(c) ?? 0) + 1;
    this.seq.set(c, s);
    return createOp(this.keys, this.dv, { c, s, l, k, p });
  }
}

let clock = 10;
const L = () => ++clock;

function setup() {
  const owner = new Actor();
  const bob = new Actor();
  const bot = new Actor();
  const eve = new Actor();
  const nonce = randomHex(16);
  const c = groupOrCommunityId(owner.pub, nonce);
  const eng = new Engine('community', c);
  const ops = [
    owner.op(c, 'genesis', { name: 'T', nonce, channels: [{ id: 'general01', type: 'text', name: 'general', pos: 0 }] }, 1),
    owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()),
  ];
  ops.push(bob.op(c, 'join', { code: 'abc123' }, L()), bot.op(c, 'join', { code: 'abc123' }, L()));
  for (const op of ops) {
    expect(verifyOp(op)).toBe(true);
    eng.noteKey(op);
    eng.addGov(op);
  }
  eng.recompute();
  return { owner, bob, bot, eve, c, eng };
}

const embed = { title: 'Weather', description: 'Sunny', color: '#4aa8ff', fields: [{ name: 'Temp', value: '21 °C', inline: true }], footer: 'by a bot' };

describe('bot messages: embeds, buttons, interactions', () => {
  it('validates embeds and buttons', () => {
    expect(parsePayload('msg', { ch: 'x', text: '', embeds: [embed] })).toBeTruthy();
    // remote image URLs are not allowed (they would leak every viewer's IP): only attachments
    expect(parsePayload('msg', { ch: 'x', text: '', embeds: [{ title: 't', image: 'https://evil.example/pixel.gif' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', embeds: [{ title: 't', url: 'javascript:alert(1)' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', buttons: [{ id: 'go', label: 'Go', style: 'link', url: 'https://example.com' }] })).toBeTruthy();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', buttons: [{ id: 'go', label: 'Go', style: 'link' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', buttons: [{ id: 'go', label: 'Go', style: 'primary', url: 'https://example.com' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', buttons: [{ id: 'bad id!', label: 'Go', style: 'primary' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', buttons: [{ id: 'x', label: '', style: 'primary' }] })).toBeNull();
    expect(parsePayload('msg', { ch: 'x', text: 'hi', embeds: [{ ...embed, extra: 1 }] })).toBeNull();
  });

  it('an embed-only message is valid; edits replace embeds and buttons', () => {
    const { bot, c, eng } = setup();
    const m = bot.op(c, 'msg', { ch: 'general01', text: '', embeds: [embed], buttons: [{ id: 'more', label: 'More', style: 'primary' }] }, L());
    expect(eng.checkMessageOp(m).ok).toBe(true);
    const keepEmbeds = bot.op(c, 'edit', { id: m.id, text: 'updated' }, L());
    let out = eng.materialize(m, [keepEmbeds])!;
    expect(out.text).toBe('updated');
    expect(out.embeds).toHaveLength(1);
    expect(out.buttons).toHaveLength(1);
    const swap = bot.op(c, 'edit', { id: m.id, text: 'done', embeds: [], buttons: [{ id: 'more', label: 'More', style: 'primary', disabled: true }] }, L());
    out = eng.materialize(m, [keepEmbeds, swap])!;
    expect(out.embeds).toHaveLength(0);
    expect(out.buttons[0].disabled).toBe(true);
  });

  it('only real presses of real buttons by members count', () => {
    const { bob, bot, eve, c, eng } = setup();
    const m = bot.op(c, 'msg', { ch: 'general01', text: 'pick', buttons: [{ id: 'a', label: 'A', style: 'success' }, { id: 'off', label: 'Off', style: 'secondary', disabled: true }, { id: 'web', label: 'Web', style: 'link', url: 'https://example.com' }] }, L());
    const msg = eng.materialize(m, [])!;
    const press = bob.op(c, 'interact', { id: m.id, b: 'a' }, L());
    expect(verifyOp(press)).toBe(true);
    const ok = eng.checkInteraction(press, msg);
    expect(ok.ok && ok.button.id).toBe('a');
    expect(eng.checkInteraction(bob.op(c, 'interact', { id: m.id, b: 'nope' }, L()), msg).ok).toBe(false);
    expect(eng.checkInteraction(bob.op(c, 'interact', { id: m.id, b: 'off' }, L()), msg).ok).toBe(false);
    expect(eng.checkInteraction(bob.op(c, 'interact', { id: m.id, b: 'web' }, L()), msg).ok).toBe(false);
    expect(eng.checkInteraction(eve.op(c, 'interact', { id: m.id, b: 'a' }, L()), msg).ok).toBe(false);
    const other = bob.op(c, 'msg', { ch: 'general01', text: 'x' }, L());
    expect(eng.checkInteraction(bob.op(c, 'interact', { id: other.id, b: 'a' }, L()), msg).ok).toBe(false);
  });
});

describe('bot profiles', () => {
  it('signs commands into the card and tells bot kinds apart', () => {
    const k = keysFromSeed(newSeed());
    const card = signProfile(k, {
      ...defaultProfile('rollbot', Date.now()),
      bot: true,
      botInfo: { kind: 'app', hosted: true, commands: [{ name: 'roll', desc: 'Roll a die', args: [{ name: 'sides', type: 'integer', optional: true }] }] },
    });
    const v = verifyProfile(JSON.parse(JSON.stringify(card)))!;
    expect(v.botInfo?.commands?.[0].name).toBe('roll');
    expect(isAppBot(v)).toBe(true);
    expect(isArchivePeer(v)).toBe(false);
    expect(isRelayOnly(v)).toBe(false); // runs inside a member's app, has no network presence of its own
    // tampering with the command list breaks the signature
    expect(verifyProfile({ ...card, botInfo: { ...card.botInfo, commands: [] } })).toBeNull();
    const archive = signProfile(k, { ...defaultProfile('archive', Date.now()), bot: true });
    expect(isArchivePeer(archive) && isRelayOnly(archive)).toBe(true);
    expect(verifyProfile({ ...card, botInfo: { kind: 'app', commands: [{ name: 'Bad Name', desc: '' }] } })).toBeNull();
  });
});

describe('bot sandbox', () => {
  it('the generated sandbox matches its source and allows exactly its own script', () => {
    const { ts, hash } = buildSandbox();
    expect(readFileSync('shared/botSandbox.ts', 'utf8').replace(/\r\n/g, '\n')).toBe(ts);
    expect(ts).toContain(`script-src '${hash}'`);
    expect(ts).toContain("connect-src 'none'");
  });
});
