import { z } from 'zod';
import { zAsset, zPub } from './ops';
import { signObject, verifyObject, type Keys } from './crypto';
import { LIMITS } from './limits';

const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

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
  /** an automated always-on archive peer, not a person */
  bot: z.boolean().optional(),
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

export const displayNameOf = (p: Pick<ProfileCard, 'displayName' | 'username'> | null | undefined, fallback = 'Unknown') =>
  p ? p.displayName.trim() || p.username : fallback;
