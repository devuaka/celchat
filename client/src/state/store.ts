import { create } from 'zustand';
import type { AccountRecord, ConvoRecord, FriendRecord } from '../core/db';
import type { HubState } from '../core/hub';
import type { HubInfo, Presence } from '@shared/protocol';
import type { ProfileCard } from '@shared/profile';
import type { ConvoState, Message } from '@shared/engine';
import type { VoicePeer, VoiceRoom } from '../core/voice';
import type { Transfer } from '../core/files';
import type { Settings } from '../core/settings';
import { defaultSettings } from '../core/settings';
import { defaultTheme, type Theme } from '../core/theme';

export type View =
  | { kind: 'home'; tab: 'online' | 'all' | 'pending' | 'blocked' | 'add' }
  | { kind: 'dm'; c: string }
  | { kind: 'community'; c: string; ch: string | null }
  | { kind: 'voice'; c: string; ch: string };

export interface Bookmark {
  id: string;
  c: string;
  ch: string;
  a: string;
  text: string;
  savedAt: number;
  remindAt: number | null;
}

export interface Scheduled {
  id: string;
  c: string;
  ch: string;
  text: string;
  at: number;
  reply: string | null;
}

export interface ChanState {
  list: Message[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'success';
  action?: { label: string; fn: () => void };
}

export interface ModalState {
  kind: string;
  props?: Record<string, unknown>;
}

export interface LinkInfo {
  addr: string;
  pub: string;
  state: string;
  rtt: number | null;
  purposes: string[];
}

export interface VoiceMemberState {
  muted: boolean;
  deaf: boolean;
  at: number;
}

export interface CallInfo {
  c: string;
  callId: string;
  from: string;
  ctype: 'dm' | 'group';
  at: number;
}

export interface S {
  phase: 'boot' | 'locked' | 'auth' | 'loading' | 'ready';
  accounts: AccountRecord[];
  me: string;
  hub: { state: HubState; info: HubInfo | null };
  myCard: ProfileCard | null;
  profiles: Record<string, ProfileCard>;
  presence: Record<string, Presence>;
  friends: Record<string, FriendRecord>;
  convos: Record<string, ConvoRecord>;
  states: Record<string, ConvoState | null>;
  view: View;
  lastChannel: Record<string, string>;
  chans: Record<string, ChanState>;
  typing: Record<string, Record<string, number>>;
  unread: Record<string, { u: boolean; m: number }>;
  voice: {
    room: VoiceRoom | null;
    state: 'idle' | 'connecting' | 'connected';
    muted: boolean;
    deafened: boolean;
    speaking: boolean;
    transmitting: boolean;
    peers: VoicePeer[];
    cam: MediaStream | null;
    screen: MediaStream | null;
  };
  bookmarks: Bookmark[];
  scheduled: Scheduled[];
  voiceRooms: Record<string, Record<string, VoiceMemberState>>;
  transfers: Record<string, Transfer>;
  blobUrls: Record<string, string>;
  links: LinkInfo[];
  settings: Settings;
  theme: Theme;
  savedThemes: Theme[];
  modal: ModalState | null;
  toasts: Toast[];
  incomingCall: CallInfo | null;
  outgoingCall: CallInfo | null;
  showMembers: boolean;
  panel: null | 'pins' | 'search' | 'inbox';
  searchQuery: string;
  replyTo: Record<string, Message | null>;
  editing: string | null;
  receipts: Record<string, number>;
  pendingJoin: { link: string } | null;
  customFonts: { key: string; label: string; hash: string }[];
  previewTheme: Theme | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  popout: { x: number; y: number; pub: string; c?: string } | null;
  lightbox: { hash: string; name: string; mime: string } | null;
  jumpTo: string | null;
  /** browser offered to install the PWA */
  installPrompt: { prompt: () => Promise<void> } | null;
  /** mobile: sidebar drawer open */
  navOpen: boolean;
}

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  sep?: boolean;
  hint?: string;
  onClick?: () => void;
  sub?: MenuItem[];
}

export const useStore = create<S>(() => ({
  phase: 'boot',
  accounts: [],
  me: '',
  hub: { state: 'offline', info: null },
  myCard: null,
  profiles: {},
  presence: {},
  friends: {},
  convos: {},
  states: {},
  view: { kind: 'home', tab: 'online' },
  lastChannel: {},
  chans: {},
  typing: {},
  unread: {},
  voice: { room: null, state: 'idle', muted: false, deafened: false, speaking: false, transmitting: false, peers: [], cam: null, screen: null },
  bookmarks: [],
  scheduled: [],
  voiceRooms: {},
  transfers: {},
  blobUrls: {},
  links: [],
  settings: defaultSettings(),
  theme: defaultTheme(),
  savedThemes: [],
  modal: null,
  toasts: [],
  incomingCall: null,
  outgoingCall: null,
  showMembers: typeof window === 'undefined' || window.innerWidth > 1100,
  panel: null,
  searchQuery: '',
  replyTo: {},
  editing: null,
  receipts: {},
  pendingJoin: null,
  customFonts: [],
  previewTheme: null,
  menu: null,
  popout: null,
  lightbox: null,
  jumpTo: null,
  installPrompt: null,
  navOpen: false,
}));

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  set({ menu: { x: e.clientX, y: e.clientY, items } });
}

export function openProfile(e: { clientX: number; clientY: number; stopPropagation?: () => void }, pub: string, c?: string) {
  e.stopPropagation?.();
  set({ popout: { x: e.clientX, y: e.clientY, pub, c } });
}

export const set = useStore.setState;
export const get = useStore.getState;

export const chanKey = (c: string, ch: string) => `${c}|${ch}`;

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = String(++toastSeq);
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, kind, action }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4200);
}

export function openModal(kind: string, props?: Record<string, unknown>) {
  set({ modal: { kind, props } });
}
export function closeModal() {
  set({ modal: null });
}
