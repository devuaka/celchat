export const P = {
  ADMIN: 1 << 0,
  MANAGE_COMMUNITY: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  KICK: 1 << 4,
  BAN: 1 << 5,
  TIMEOUT: 1 << 6,
  CREATE_INVITE: 1 << 7,
  CHANGE_NICK: 1 << 8,
  MANAGE_NICKS: 1 << 9,
  SEND: 1 << 10,
  MANAGE_MESSAGES: 1 << 11,
  ATTACH: 1 << 12,
  REACT: 1 << 13,
  MENTION_EVERYONE: 1 << 14,
  CONNECT: 1 << 15,
  SPEAK: 1 << 16,
  MUTE_MEMBERS: 1 << 17,
  VIEW_CHANNEL: 1 << 18,
  MANAGE_EMOJI: 1 << 19,
} as const;

export type PermName = keyof typeof P;

export const ALL_PERMS = Object.values(P).reduce((a, b) => a | b, 0);

export const DEFAULT_EVERYONE =
  P.VIEW_CHANNEL | P.CREATE_INVITE | P.CHANGE_NICK | P.SEND | P.ATTACH | P.REACT | P.CONNECT | P.SPEAK;

/** Bits that channel overwrites may change. */
export const CHANNEL_PERMS =
  P.VIEW_CHANNEL | P.SEND | P.ATTACH | P.REACT | P.MENTION_EVERYONE | P.MANAGE_MESSAGES | P.CONNECT | P.SPEAK | P.MUTE_MEMBERS;

/** Removed while a member is timed out. */
export const TIMEOUT_STRIP = P.SEND | P.REACT | P.CONNECT | P.SPEAK | P.CREATE_INVITE | P.CHANGE_NICK;

export const PERM_INFO: { key: PermName; label: string; desc: string; channel?: boolean }[] = [
  { key: 'ADMIN', label: 'Administrator', desc: 'Every permission and bypasses channel overwrites. Grant carefully.' },
  { key: 'MANAGE_COMMUNITY', label: 'Manage community', desc: 'Change name, icon, banner, description, theme and join policy.' },
  { key: 'MANAGE_EMOJI', label: 'Manage emoji', desc: 'Add and remove custom emoji. Members can use them in any conversation, free.' },
  { key: 'MANAGE_CHANNELS', label: 'Manage channels', desc: 'Create, edit, reorder and delete channels and categories.' },
  { key: 'MANAGE_ROLES', label: 'Manage roles', desc: 'Create and edit roles below their highest role, and channel overwrites.' },
  { key: 'KICK', label: 'Kick members', desc: 'Remove members (they can rejoin with an invite).' },
  { key: 'BAN', label: 'Ban members', desc: 'Ban and unban members.' },
  { key: 'TIMEOUT', label: 'Timeout members', desc: 'Temporarily stop members from chatting, reacting and speaking.' },
  { key: 'CREATE_INVITE', label: 'Create invites', desc: 'Create invite links.' },
  { key: 'CHANGE_NICK', label: 'Change nickname', desc: 'Change their own nickname in this community.' },
  { key: 'MANAGE_NICKS', label: 'Manage nicknames', desc: "Change other members' nicknames." },
  { key: 'VIEW_CHANNEL', label: 'View channels', desc: 'See channels in the sidebar. Hidden channels are NOT encrypted: members still sync them.', channel: true },
  { key: 'SEND', label: 'Send messages', desc: 'Post messages in text channels.', channel: true },
  { key: 'MANAGE_MESSAGES', label: 'Manage messages', desc: "Delete others' messages and pin messages.", channel: true },
  { key: 'ATTACH', label: 'Attach files', desc: 'Share images, videos and files.', channel: true },
  { key: 'REACT', label: 'Add reactions', desc: 'React to messages.', channel: true },
  { key: 'MENTION_EVERYONE', label: 'Mention @everyone', desc: 'Make @everyone and @here notify people.', channel: true },
  { key: 'CONNECT', label: 'Connect to voice', desc: 'Join voice channels.', channel: true },
  { key: 'SPEAK', label: 'Speak', desc: 'Talk in voice channels.', channel: true },
  { key: 'MUTE_MEMBERS', label: 'Mute members in voice', desc: 'Server-mute others (enforced by every listener).', channel: true },
];

export const has = (perms: number, bit: number) => (perms & P.ADMIN) !== 0 || (perms & bit) === bit;
