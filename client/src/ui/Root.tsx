import { useEffect, useState } from 'react';
import { useStore, set, openModal } from '../state/store';
import { listAccounts, tryAutoUnlock, type Session } from '../core/identity';
import { startApp, app } from '../core/app';
import { AuthScreen } from './auth/AuthScreen';
import { Shell } from './Shell';
import { Button, Spinner } from './common';

/** Only one tab may run an account at a time (one device id = one hub connection). */
async function acquireTabLock(pub: string): Promise<boolean> {
  if (!navigator.locks) return true;
  return new Promise((res) => {
    void navigator.locks.request(`celchat-account-${pub}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        res(false);
        return;
      }
      res(true);
      return new Promise(() => undefined); // hold for the life of the tab
    });
  });
}

let booted = false;

export function Root() {
  const phase = useStore((s) => s.phase);
  const [busyTab, setBusyTab] = useState<Session | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const begin = async (session: Session, restore?: unknown) => {
    set({ phase: 'loading' });
    if (!(await acquireTabLock(session.keys.pub))) {
      setBusyTab(session);
      set({ phase: 'locked' });
      return;
    }
    try {
      await startApp(session);
      if (restore) await app().applyAccountData(restore);
      set({ phase: 'ready' });
      const m = /#\/join\/(.+)$/.exec(location.hash);
      if (m) {
        openModal('join', { initial: decodeURIComponent(m[1]) });
        history.replaceState(null, '', location.pathname);
      }
    } catch (e) {
      console.error(e);
      setFatal((e as Error).message || String(e));
    }
  };

  useEffect(() => {
    if (booted) return;
    booted = true;
    void (async () => {
      if (!window.isSecureContext || !crypto.subtle) {
        setFatal('CelChat needs a secure context (https:// or http://localhost) for its cryptography.');
        return;
      }
      if (!window.indexedDB) {
        setFatal('This browser has no IndexedDB storage (private mode?). CelChat stores your identity locally and cannot run without it.');
        return;
      }
      const accounts = await listAccounts();
      set({ accounts });
      for (const a of accounts) {
        if (!a.wrapped) continue;
        const s = await tryAutoUnlock(a.pub);
        if (s) return begin(s);
        break;
      }
      set({ phase: 'auth' });
    })();
  }, []);

  if (fatal)
    return (
      <div className="boot">
        <img src="./icon.svg" alt="" width={56} />
        <h2>CelChat could not start</h2>
        <p>{fatal}</p>
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    );
  if (phase === 'locked' && busyTab)
    return (
      <div className="boot">
        <img src="./icon.svg" alt="" width={56} />
        <h2>CelChat is open in another tab</h2>
        <p>One account can run in one tab at a time. Close the other tab, then try again.</p>
        <Button onClick={() => void begin(busyTab)}>Try again</Button>
      </div>
    );
  if (phase === 'auth') return <AuthScreen onSession={(s, r) => void begin(s, r)} />;
  if (phase === 'ready') return <Shell />;
  return (
    <div className="boot">
      <img src="./icon.svg" alt="" width={56} className="pulse" />
      <Spinner size={22} />
    </div>
  );
}
