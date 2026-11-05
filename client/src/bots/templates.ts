import starter from './templates/starter.js?raw';
import welcome from './templates/welcome.js?raw';
import moderator from './templates/moderator.js?raw';
import roles from './templates/roles.js?raw';
import weather from './templates/weather.js?raw';
import blank from './templates/blank.js?raw';

export interface BotTemplate {
  id: string;
  name: string;
  username: string;
  emoji: string;
  desc: string;
  code: string;
  network: boolean;
  colors: { primary: string; accent: string };
}

export const BOT_TEMPLATES: BotTemplate[] = [
  { id: 'starter', name: 'Starter Bot', username: 'starterbot', emoji: '🤖', desc: 'Ping, dice, a magic 8-ball, a click counter that remembers, and /help.', code: starter, network: false, colors: { primary: '#2b6f62', accent: '#5fd3b3' } },
  { id: 'welcome', name: 'Welcomer', username: 'welcomer', emoji: '👋', desc: 'Greets new members in a channel you pick, with a message you write.', code: welcome, network: false, colors: { primary: '#3b5bdb', accent: '#74c0fc' } },
  { id: 'moderator', name: 'Moderator', username: 'modbot', emoji: '🛡️', desc: 'Blocked words, strikes, automatic timeouts and a /timeout command.', code: moderator, network: false, colors: { primary: '#862e2e', accent: '#ff8787' } },
  { id: 'roles', name: 'Role Buttons', username: 'rolebot', emoji: '🎭', desc: 'Post buttons that let members give themselves roles.', code: roles, network: false, colors: { primary: '#5f3dc4', accent: '#b197fc' } },
  { id: 'weather', name: 'Weather', username: 'weatherbot', emoji: '🌦️', desc: 'Live weather for any city from Open-Meteo. Uses the internet.', code: weather, network: true, colors: { primary: '#1864ab', accent: '#4dabf7' } },
  { id: 'blank', name: 'Blank Bot', username: 'mybot', emoji: '✨', desc: 'An empty bot with one command. Write your own.', code: blank, network: false, colors: { primary: '#495057', accent: '#adb5bd' } },
];
