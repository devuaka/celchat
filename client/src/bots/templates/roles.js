// Role buttons: members click buttons to give themselves roles.
// The bot needs "Manage roles", and its highest role must be above the roles it hands out.

bot.command('rolemenu', 'Post role buttons, e.g. /rolemenu Gamer, Artist, Night owl', ['roles:text'], async (ctx, { roles }) => {
  if (!ctx.author.can('MANAGE_ROLES')) return ctx.reply('You need Manage roles to post a role menu.');
  const all = await ctx.community.roles();
  const wanted = roles.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = wanted.map((n) => all.find((r) => r.name.toLowerCase() === n)).filter(Boolean).slice(0, 15);
  if (!picked.length) return ctx.reply('None of those roles exist. Roles here: ' + all.map((r) => r.name).join(', '));
  await ctx.send({
    embeds: [{ title: 'Pick your roles', description: 'Click a button to add the role. Click again to remove it.', color: '#8b7cf6' }],
    buttons: picked.map((r) => ({ id: 'role:' + r.id, label: r.name, style: 'secondary' })),
  });
});

bot.button('role:', async (press) => {
  const roleId = press.id.slice('role:'.length);
  const role = (await press.community.roles()).find((r) => r.id === roleId);
  if (!role) return;
  const has = press.user.hasRole(roleId);
  try {
    if (has) await press.user.removeRole(roleId);
    else await press.user.addRole(roleId);
  } catch (e) {
    const note = await press.reply(`I could not change that role: ${e.message}`);
    bot.after(8, () => note.delete());
    return;
  }
  const note = await press.reply(`${press.user.mention} ${has ? 'no longer has' : 'now has'} **${role.name}**`);
  bot.after(5, () => note.delete());
});
