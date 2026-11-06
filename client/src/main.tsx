import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts';
import './styles/app.css';
import { Root } from './ui/Root';
import { useStore } from './state/store';
import { app, hasApp } from './core/app';

// Dev/test handle (used by the e2e test). Not present in production builds.
if (import.meta.env.DEV) Object.assign(window, { __cel: { store: useStore, app: () => (hasApp() ? app() : null) } });

// Installable app: service worker for the offline shell (production only, not inside the desktop app)
const isDesktopApp = navigator.userAgent.includes('CelChatDesktop');
if (import.meta.env.PROD && 'serviceWorker' in navigator && !isDesktopApp && location.protocol === 'https:') {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  useStore.setState({ installPrompt: e as unknown as { prompt: () => Promise<void> } });
});
window.addEventListener('appinstalled', () => useStore.setState({ installPrompt: null }));

// Desktop app: tray menu / global hotkeys / celchat:// links arrive as commands
window.celDesktop?.onCommand((cmd) => {
  if (!hasApp()) return;
  if (cmd.type === 'mute') app().setMuted(!app().voice.muted);
  else if (cmd.type === 'deafen') app().setDeafened(!app().voice.deafened);
  else if (cmd.type === 'join' && cmd.link) useStore.setState({ modal: { kind: 'join', props: { initial: cmd.link } } });
});

declare global {
  interface Window {
    celDesktop?: {
      setBadge: (mentions: number, any: boolean) => void;
      onCommand: (cb: (cmd: { type: string; link?: string; hash?: string }) => void) => () => void;
      info: () => Promise<{ version: string; platform: string }>;
    };
  }
}

/** A render bug should never leave people staring at a blank window. */
class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  override componentDidCatch(err: Error) {
    console.error('[celchat] render error', err);
  }
  override render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="boot">
        <img src="./icon.svg" alt="" width={56} />
        <h2>Something in the interface broke</h2>
        <p>Your data is safe on this device. Reloading usually fixes it.</p>
        <p className="muted small mono">{this.state.err.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          Reload CelChat
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <Root />
    </Boundary>
  </StrictMode>,
);
