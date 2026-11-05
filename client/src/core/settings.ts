import type { DirectPolicy } from './peers';
import type { VoiceSettings } from './voice';
import type { NotifyLevel } from './db';
import type { Presence } from '@shared/protocol';

export interface Settings {
  hubUrl: string;
  status: Presence;
  privacy: {
    direct: DirectPolicy;
    relay: boolean;
    dmsFrom: 'all' | 'members' | 'friends';
    friendReqFrom: 'all' | 'members' | 'none';
    shareFriends: boolean;
    readReceipts: boolean;
    typing: boolean;
  };
  media: {
    autoDownloadMB: number;
    maxFileMB: number;
    autoplayGifs: boolean;
    publicAssetCache: boolean;
  };
  voice: VoiceSettings;
  notify: {
    desktop: boolean;
    sounds: boolean;
    level: NotifyLevel;
    calls: boolean;
  };
  chat: {
    clock24: boolean;
    enterSends: boolean;
    spoilers: 'click' | 'always';
    communityThemes: boolean;
    reduceMotionGifs: boolean;
    /** read incoming messages aloud in the open conversation */
    tts: 'off' | 'mentions' | 'all';
  };
  vaultSync: boolean;
  favoriteGifs: { hash: string; name: string; mime: string; size: number; w?: number; h?: number; thumb?: string }[];
  recentEmoji: string[];
  /** soundboard clips (stored locally, played into calls) */
  sounds: { hash: string; name: string; emoji: string; mime: string; size: number; volume: number }[];
  /** community folders in the rail */
  folders: { id: string; name: string; color: string; items: string[]; open: boolean }[];
  /** GIF search: through the hub (operator's key) or straight to the provider with your own key */
  gifs: { useHub: boolean; provider: 'klipy' | 'giphy' | 'tenor-compatible'; key: string; base: string; filter: 'off' | 'low' | 'medium' | 'high' };
}

export const defaultSettings = (): Settings => ({
  hubUrl: '',
  status: 'online',
  privacy: { direct: 'all', relay: true, dmsFrom: 'members', friendReqFrom: 'all', shareFriends: true, readReceipts: true, typing: true },
  media: { autoDownloadMB: 15, maxFileMB: 200, autoplayGifs: true, publicAssetCache: true },
  voice: {
    inputId: 'default',
    outputId: 'default',
    cameraId: 'default',
    noiseSuppression: true,
    echoCancellation: true,
    autoGain: true,
    sensitivity: 0.018,
    mode: 'vad',
    pttKey: 'Backquote',
    pttReleaseMs: 200,
    screenQuality: '1080p30',
  },
  notify: { desktop: true, sounds: true, level: 'all', calls: true },
  chat: { clock24: false, enterSends: true, spoilers: 'click', communityThemes: true, reduceMotionGifs: false, tts: 'off' },
  vaultSync: true,
  favoriteGifs: [],
  recentEmoji: ['👍', '😂', '❤️', '🔥', '🎉', '😮', '😢', '🙏'],
  sounds: [],
  folders: [],
  gifs: { useHub: true, provider: 'giphy', key: '', base: '', filter: 'medium' },
});

/** Deep-merge stored settings over defaults so new fields get sane values. */
export function mergeSettings(stored: unknown): Settings {
  const d = defaultSettings();
  if (!stored || typeof stored !== 'object') return d;
  const s = stored as Partial<Settings>;
  return {
    ...d,
    ...s,
    privacy: { ...d.privacy, ...(s.privacy ?? {}) },
    media: { ...d.media, ...(s.media ?? {}) },
    voice: { ...d.voice, ...(s.voice ?? {}) },
    notify: { ...d.notify, ...(s.notify ?? {}) },
    chat: { ...d.chat, ...(s.chat ?? {}) },
    favoriteGifs: Array.isArray(s.favoriteGifs) ? s.favoriteGifs.slice(0, 200) : [],
    recentEmoji: Array.isArray(s.recentEmoji) ? s.recentEmoji.slice(0, 32) : d.recentEmoji,
    sounds: Array.isArray(s.sounds) ? s.sounds.slice(0, 100) : [],
    folders: Array.isArray(s.folders) ? s.folders.slice(0, 50) : [],
    gifs: { ...d.gifs, ...(s.gifs ?? {}) },
  };
}
