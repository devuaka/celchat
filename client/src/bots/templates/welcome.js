// Welcome bot: greets new members and says goodbye.
// Moderators can change the text with /setwelcome and the channel with /welcomehere.

const DEFAULT_TEXT = 'Welcome to **{community}**, {user}! 🎉 Say hi and read the pinned messages.';

async function welcomeChannel(community) {
  const saved = await bot.storage.get('channel:' + community.id);
  const channels = (await community.channels()).filter((c) => c.type === 'text');
  return channels.find((c) => c.id === saved) || channels.find((c) => /welcome|general|lobby/.test(c.name)) || channels[0];
}

bot.on('memberJoin', async ({ user, community }) => {
  if (user.bot) return;
  const ch = await welcomeChannel(community);
  const template = await bot.storage.get('text:' + community.id, DEFAULT_TEXT);
  const text = template.replaceAll('{user}', user.mention).replaceAll('{community}', community.name).replaceAll('{name}', user.name);
  await ch?.send({ embeds: [{ description: text, color: '#5fd3b3', footer: `Member #${community.memberCount}` }] });
});

bot.on('memberLeave', async ({ user, community, reason }) => {
  if (reason !== 'leave' || user.bot) return;
  const ch = await welcomeChannel(community);
  await ch?.send(`👋 **${user.name}** left. See you around!`);
});

bot.command('setwelcome', 'Set the welcome text ({user}, {name} and {community} get filled in)', ['text:text'], async (ctx, { text }) => {
  if (!ctx.author.can('MANAGE_COMMUNITY')) return ctx.reply('Only people who can manage the community can change this.');
  await bot.storage.set('text:' + ctx.community.id, text);
  await ctx.reply('Saved. New members will see:\n> ' + text.replaceAll('{user}', ctx.author.mention).replaceAll('{community}', ctx.community.name).replaceAll('{name}', ctx.author.name));
});

bot.command('welcomehere', 'Post welcome messages in this channel', async (ctx) => {
  if (!ctx.author.can('MANAGE_COMMUNITY')) return ctx.reply('Only people who can manage the community can change this.');
  await bot.storage.set('channel:' + ctx.community.id, ctx.channel.id);
  await ctx.reply(`Welcome messages will go to ${ctx.channel.mention}.`);
});
