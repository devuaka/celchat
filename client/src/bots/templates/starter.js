// Starter bot: classic commands, an embed, and a button that remembers its count.
// Change anything, then press "Save & run". Try it in the Test tab before adding it to a community.

bot.command('ping', 'Check that the bot is alive', async (ctx) => {
  await ctx.reply('Pong! 🏓');
});

bot.command('roll', 'Roll a die', ['sides:integer?'], async (ctx, { sides = 6 }) => {
  sides = Math.min(Math.max(sides, 2), 1000);
  const n = 1 + Math.floor(Math.random() * sides);
  await ctx.reply(`🎲 ${ctx.author.mention} rolled **${n}** (d${sides})`);
});

const answers = ['It is certain.', 'Without a doubt.', 'Ask again later.', 'Very doubtful.', 'Signs point to yes.', 'My sources say no.', 'Better not tell you now.'];
bot.command('8ball', 'Ask the magic 8-ball', ['question:text'], async (ctx, { question }) => {
  await ctx.reply({
    embeds: [{ title: '🎱 ' + question, description: answers[Math.floor(Math.random() * answers.length)], color: '#5fd3b3' }],
  });
});

// A button whose count survives restarts (bot.storage is saved on your device).
bot.command('counter', 'Post a click counter', async (ctx) => {
  const count = await bot.storage.get('clicks', 0);
  await ctx.send({
    text: `Clicked **${count}** times`,
    buttons: [{ id: 'count', label: 'Click me', style: 'primary', emoji: '👆' }],
  });
});

bot.button('count', async (press) => {
  const count = (await bot.storage.get('clicks', 0)) + 1;
  await bot.storage.set('clicks', count);
  await press.update({ text: `Clicked **${count}** times (last: ${press.user.mention})` });
});

bot.command('help', 'List my commands', async (ctx) => {
  const lines = bot.commands.map((c) => `**/${c.name}** ${c.args.map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ')} - ${c.desc}`);
  await ctx.reply({ embeds: [{ title: `${bot.name} commands`, description: lines.join('\n'), color: '#8b7cf6' }] });
});

// Wave back when someone mentions the bot.
bot.on('message', async (msg) => {
  if (!msg.author.bot && msg.mentionsMe) await msg.react('👋');
});
