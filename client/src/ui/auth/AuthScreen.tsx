import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { Button, Field, I, Toggle, pickFile, cls } from '../common';
import {
  createAccount, unlockWithPassword, importFromRecoveryKey, restoreBackup, listAccounts, removeAccountFromDevice,
  validatePassword, validateUsername, normalizeUsername, type Session, type BackupFile,
} from '../../core/identity';
import type { AccountRecord } from '../../core/db';

type Mode = 'pick' | 'unlock' | 'create' | 'import';

export function AuthScreen({ onSession }: { onSession: (s: Session, restore?: unknown) => void }) {
  const accounts = useStore((s) => s.accounts);
  const [mode, setMode] = useState<Mode>(accounts.length ? 'pick' : 'create');
  const [picked, setPicked] = useState<AccountRecord | null>(null);
  useEffect(() => {
    if (!accounts.length && mode === 'pick') setMode('create');
  }, [accounts.length, mode]);

  return (
    <div className="auth">
      <div className="auth-art" aria-hidden>
        <div className="orb o1" />
        <div className="orb o2" />
        <div className="orb o3" />
      </div>
      <div className="auth-card">
        <div className="auth-brand">
          <img src="./icon.svg" alt="" />
          <div>
            <div className="auth-title">CelChat</div>
            <div className="auth-tag">Peer-to-peer communities. Free, forever, no strings.</div>
          </div>
        </div>
        {mode === 'pick' && (
          <AccountPicker
            accounts={accounts}
            onPick={(a) => {
              setPicked(a);
              setMode('unlock');
            }}
            onCreate={() => setMode('create')}
            onImport={() => setMode('import')}
          />
        )}
        {mode === 'unlock' && picked && <Unlock account={picked} onBack={() => setMode('pick')} onSession={onSession} />}
        {mode === 'create' && <Create onBack={accounts.length ? () => setMode('pick') : undefined} onImport={() => setMode('import')} onSession={onSession} />}
        {mode === 'import' && <Import onBack={() => setMode(accounts.length ? 'pick' : 'create')} onSession={onSession} />}
      </div>
      <div className="auth-foot">
        Your identity is a key pair that lives in this browser. Your password never leaves this device.
      </div>
    </div>
  );
}

function AccountPicker({ accounts, onPick, onCreate, onImport }: { accounts: AccountRecord[]; onPick: (a: AccountRecord) => void; onCreate: () => void; onImport: () => void }) {
  return (
    <div className="auth-body">
      <h2>Welcome back</h2>
      <div className="acct-list">
        {accounts.map((a) => (
          <div key={a.pub} className="acct">
            <button type="button" className="acct-main" onClick={() => onPick(a)}>
              <span className="acct-avatar" style={{ ['--hue' as string]: parseInt(a.pub.slice(0, 4), 16) % 360 }}>
                {(a.displayName || a.username).slice(0, 1).toUpperCase()}
              </span>
              <span className="acct-names">
                <b>{a.displayName || a.username}</b>
                <span>@{a.username}</span>
              </span>
              <I.right size={18} />
            </button>
            <button
              type="button"
              className="acct-remove"
              title="Remove from this device"
              onClick={async () => {
                if (!confirm(`Remove @${a.username} from this browser? Messages and files stored here are deleted. You can sign back in later with your recovery key or a backup file.`)) return;
                await removeAccountFromDevice(a.pub);
                useStore.setState({ accounts: await listAccounts() });
              }}
            >
              <I.x size={16} />
            </button>
          </div>
        ))}
      </div>
      <div className="auth-row">
        <Button kind="ghost" onClick={onCreate}>
          <I.plus size={16} /> New account
        </Button>
        <Button kind="ghost" onClick={onImport}>
          <I.key size={16} /> Restore account
        </Button>
      </div>
    </div>
  );
}

function Unlock({ account, onBack, onSession }: { account: AccountRecord; onBack: () => void; onSession: (s: Session) => void }) {
  const [pw, setPw] = useState('');
  const [stay, setStay] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="auth-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          onSession(await unlockWithPassword(account.pub, pw, stay));
        } catch (e2) {
          setErr((e2 as Error).message);
          setBusy(false);
        }
      }}
    >
      <button type="button" className="link-back" onClick={onBack}>
        <I.back size={16} /> Accounts
      </button>
      <h2>Unlock @{account.username}</h2>
      <Field label="Password" error={err}>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
      </Field>
      <Toggle on={stay} onChange={setStay} label="Stay signed in on this device" />
      <Button type="submit" busy={busy} disabled={!pw}>
        Unlock
      </Button>
    </form>
  );
}

function Create({ onBack, onImport, onSession }: { onBack?: () => void; onImport: () => void; onSession: (s: Session) => void }) {
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [stay, setStay] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const u = normalizeUsername(username);
  const uErr = username ? validateUsername(u) : null;
  const pErr = pw ? validatePassword(pw) : null;
  return (
    <form
      className="auth-body"
      onSubmit={async (e) => {
        e.preventDefault();
        const ue = validateUsername(u);
        const pe = validatePassword(pw);
        if (ue || pe) return setErr(ue ?? pe);
        if (pw !== pw2) return setErr("Passwords don't match.");
        setBusy(true);
        setErr(null);
        try {
          onSession(await createAccount(u, display.trim().slice(0, 32), pw, stay));
        } catch (e2) {
          setErr((e2 as Error).message);
          setBusy(false);
        }
      }}
    >
      {onBack && (
        <button type="button" className="link-back" onClick={onBack}>
          <I.back size={16} /> Accounts
        </button>
      )}
      <h2>Create your account</h2>
      <div className="grid2">
        <Field label="Username" error={uErr} hint="Lowercase, unique on your hub">
          <div className="input-prefix">
            <span>@</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" spellCheck={false} maxLength={32} />
          </div>
        </Field>
        <Field label="Display name" hint="Anything you like">
          <input value={display} onChange={(e) => setDisplay(e.target.value)} maxLength={32} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Password" error={pErr} hint="Encrypts your key on this device">
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <Toggle on={stay} onChange={setStay} label="Stay signed in on this device" />
      {err && <div className="field-error">{err}</div>}
      <Button type="submit" busy={busy}>
        Create account
      </Button>
      <div className="auth-note">
        There is no server that can reset your password. After signing up, save your recovery key from Settings, then Account.{' '}
        <button type="button" className="link" onClick={onImport}>
          Already have an account?
        </button>
      </div>
    </form>
  );
}

function Import({ onBack, onSession }: { onBack: () => void; onSession: (s: Session, restore?: unknown) => void }) {
  const [tab, setTab] = useState<'key' | 'file'>('key');
  const [key, setKey] = useState('');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [file, setFile] = useState<BackupFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="auth-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setBusy(true);
        try {
          if (tab === 'key') {
            const u = normalizeUsername(username);
            const ue = validateUsername(u);
            const pe = validatePassword(pw);
            if (ue || pe) throw new Error(ue ?? pe!);
            onSession(await importFromRecoveryKey(key, u, pw, true));
          } else {
            if (!file) throw new Error('Choose a backup file first.');
            const { session, data } = await restoreBackup(file, pw, true);
            onSession(session, data);
          }
        } catch (e2) {
          setErr((e2 as Error).message);
          setBusy(false);
        }
      }}
    >
      <button type="button" className="link-back" onClick={onBack}>
        <I.back size={16} /> Back
      </button>
      <h2>Restore an account</h2>
      <div className="tabs">
        <button type="button" className={cls(tab === 'key' && 'on')} onClick={() => setTab('key')}>
          Recovery key
        </button>
        <button type="button" className={cls(tab === 'file' && 'on')} onClick={() => setTab('file')}>
          Backup file
        </button>
      </div>
      {tab === 'key' ? (
        <>
          <Field label="Recovery key" hint="The XXXX-XXXX-... key from Settings, then Account">
            <textarea value={key} onChange={(e) => setKey(e.target.value)} rows={3} spellCheck={false} className="mono" />
          </Field>
          <div className="grid2">
            <Field label="Username" hint="Your profile is refreshed from the hub once online">
              <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="New password for this device">
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Backup file" hint="A .celchat-backup.json file you exported">
            <Button
              kind="ghost"
              onClick={async () => {
                const [f] = await pickFile('.json,application/json');
                if (!f) return;
                try {
                  setFile(JSON.parse(await f.text()));
                  setFileName(f.name);
                } catch {
                  setErr('That file is not valid JSON.');
                }
              }}
            >
              <I.upload size={16} /> {fileName || 'Choose file'}
            </Button>
          </Field>
          <Field label="Backup password">
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
        </>
      )}
      {err && <div className="field-error">{err}</div>}
      <Button type="submit" busy={busy}>
        Restore
      </Button>
      <div className="auth-note">
        Messages are not in backups: they sync back from other members once you are online. Communities, friends, settings and themes come back from the backup or your encrypted hub vault.
      </div>
    </form>
  );
}
