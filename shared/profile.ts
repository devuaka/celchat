import { z } from 'zod';
import { zAsset, zPub } from './ops';
import { signObject, verifyObject, type Keys } from './crypto';
import { LIMITS } from './limits';

const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

export const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const ARG_TYPES = ['text', 'word', 'number', 'integer', 'user', 'channel', 'role', 'boolean'] as const;
export const zCommandArg = z
  .object({
    name: z.string().regex(COMMAND_NAME_RE),
    type: z.enum(ARG_TYPES),
    desc: z.string().max(100).optional(),
    optional: z.boolean().optional(),
    choices: z.array(z.string().min(1).max(50)).max(25).optional(),
  })
  .strict();
export const zCommand = z
  .object({
    name: z.string().regex(COMMAND_NAME_RE),
    desc: z.string().max(100),
    args: z.array(zCommandArg).max(10).optional(),
  })
  .strict();
export type BotCommand = z.infer<typeof zCommand>;
export type BotCommandArg = z.infer<typeof zCommandArg>;

export const zProfile = z.object({
  v: z.literal(1),
  pub: zPub,
  username: z.string().regex(USERNAME_RE),
  displayName: z.string().max(LIMITS.displayNameChars),
  about: z.string().max(LIMITS.aboutChars),
  pronouns: z.string().max(40),
  avatar: zAsset.nullable(),
  banner: zAsset.nullable(),
  /** profile theme: card gradient from primary to accent */
  colors: z.object({ primary: zColor, accent: zColor }),
  font: z.string().max(40),
  nameStyle: z.enum(['plain', 'gradient', 'glow', 'shadow']),
  status: z
    .object({
      emoji: z.string().max(64).optional(),
      text: z.string().max(128).optional(),
      until: z.number().int().nullable().optional(),
    })
    .nullable(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  /** an automated account (archive peer or bot), not a person */
  bot: z.boolean().optional(),
  /** what kind of automated account; absent on a bot card = archive peer */
  botInfo: z
    .object({
      kind: z.enum(['archive', 'app']),
      /** runs inside a member's CelChat (no network presence of its own) */
      hosted: z.boolean().optional(),
      commands: z.array(zCommand).max(LIMITS.botCommands).optional(),
    })
    .strict()
    .optional(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

export type ProfileCard = z.infer<typeof zProfile>;
export type ProfileDraft = Omit<ProfileCard, 'sig' | 'pub' | 'v' | 'updatedAt'>;

export function signProfile(keys: Keys, draft: ProfileDraft): ProfileCard {
  return signObject(keys, { ...draft, v: 1 as const, pub: keys.pub, updatedAt: Date.now() });
}

export function verifyProfile(raw: unknown): ProfileCard | null {
  const r = zProfile.safeParse(raw);
  if (!r.success) return null;
  return verifyObject(r.data.pub, r.data) ? r.data : null;
}

export function defaultProfile(username: string, createdAt: number): ProfileDraft {
  return {
    username,
    displayName: '',
    about: '',
    pronouns: '',
    avatar: null,
    banner: null,
    colors: { primary: '#2b6f62', accent: '#5fd3b3' },
    font: 'default',
    nameStyle: 'plain',
    status: null,
    createdAt,
  };
}

type BotFields = Pick<ProfileCard, 'bot' | 'botInfo'> | null | undefined;
/** always-on archive peer (keeps history) */
export const isArchivePeer = (p: BotFields) => !!p?.bot && (p.botInfo?.kind ?? 'archive') === 'archive';
/** a bot account that responds to commands */
export const isAppBot = (p: BotFields) => !!p?.bot && p.botInfo?.kind === 'app';
/** headless automated peers that are only reachable through the encrypted relay */
export const isRelayOnly = (p: BotFields) => !!p?.bot && !p.botInfo?.hosted;

export const displayNameOf =(p: Pick<ProfileCard, 'displayName' | 'username'> | null | undefined, fallback = 'Unknown') =>
  p ? p.displayName.trim() || p.username : fallback;
