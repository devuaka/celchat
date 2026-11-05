// A new bot. The Docs tab lists everything `bot` can do.

bot.command('hello', 'Say hello', async (ctx) => {
  await ctx.reply(`Hello, ${ctx.author.mention}!`);
});
