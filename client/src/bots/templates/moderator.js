// Moderator bot: deletes messages with blocked words, gives strikes, and times out repeat offenders.
// Give the bot a role with "Manage messages" and "Timeout members", placed above the members it moderates.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsKey = (c) => 'words:' + c;
const strikesKey = (c, u) => 'strikes:' + c + ':' + u;

bot.on('message', async (msg) => {
  if (msg.author.bot || msg.author.can('MANAGE_MESSAGES')) return;
  const words = await bot.storage.get(wordsKey(msg.community.id), []);
  const text = msg.text.toLowerCase();
  const hit = words.find((w) => new RegExp('(^|\\W)' + escape(w) + '($|\\W)').test(text));
  if (!hit) return;
  await msg.delete();
  const strikes = (await bot.storage.get(strikesKey(msg.community.id, msg.author.id), 0)) + 1;
  await bot.storage.set(strikesKey(msg.community.id, msg.author.id), strikes);
  if (strikes >= 3) {
    await msg.author.timeout(10 * 60, 'Blocked words (3 strikes)');
    await bot.storage.set(strikesKey(msg.community.id, msg.author.id), 0);
    await msg.channel.send(`🔇 ${msg.author.mention} was timed out for 10 minutes (3 strikes).`);
  } else {
    await msg.channel.send(`⚠️ ${msg.author.mention}, that word is not allowed here. Strike ${strikes} of 3.`);
  }
});

bot.command('blockword', 'Block a word (moderators)', ['word'], async (ctx, { word }) => {
  if (!ctx.author.can('MANAGE_MESSAGES')) return ctx.reply('You need Manage messages.');
  const words = new Set(await bot.storage.get(wordsKey(ctx.community.id), []));
  words.add(word.toLowerCase());
  await bot.storage.set(wordsKey(ctx.community.id), [...words]);
  await ctx.reply(`Blocked. ${words.size} word(s) on the list.`);
});

bot.command('unblockword', 'Remove a word from the list (moderators)', ['word'], async (ctx, { word }) => {
  if (!ctx.author.can('MANAGE_MESSAGES')) return ctx.reply('You need Manage messages.');
  const words = (await bot.storage.get(wordsKey(ctx.community.id), [])).filter((w) => w !== word.toLowerCase());
  await bot.storage.set(wordsKey(ctx.community.id), words);
  await ctx.reply(`Removed. ${words.length} word(s) on the list.`);
});

bot.command('timeout', 'Time a member out', ['member:user', 'minutes:integer?', 'reason:text?'], async (ctx, { member, minutes = 10, reason }) => {
  if (!ctx.author.can('TIMEOUT')) return ctx.reply('You need Timeout members.');
  await member.timeout(Math.min(minutes, 40320) * 60, reason || `by ${ctx.author.name}`);
  await ctx.reply(`🔇 ${member.mention} is timed out for ${minutes} minute(s).`);
});

bot.command('strikes', 'Show strikes for a member', ['member:user'], async (ctx, { member }) => {
  const n = await bot.storage.get(strikesKey(ctx.community.id, member.id), 0);
  await ctx.reply(`${member.name} has ${n} strike(s).`);
});
