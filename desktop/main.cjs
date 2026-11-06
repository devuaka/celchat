// CelChat desktop app (Electron). Loads the same web build from a private app:// origin and adds
// what a browser tab cannot do: tray, taskbar badge, global hotkeys, celchat:// links, autostart.
const { app, BrowserWindow, Tray, Menu, nativeImage, protocol, net, shell, ipcMain, globalShortcut, session, desktopCapturer, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'celchat';
const DIST = app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'dist') : path.join(__dirname, '..', 'dist');
const ICON = path.join(__dirname, 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let tray = null;
let quitting = false;
let unread = { mentions: 0, any: false };
const settingsFile = () => path.join(app.getPath('userData'), 'desktop.json');
function prefs() {
  try {
    return { closeToTray: true, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { closeToTray: true };
  }
}
function savePrefs(p) {
  fs.writeFileSync(settingsFile(), JSON.stringify(p));
}

// one instance only; a second launch (or a celchat:// link) focuses the first
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    show();
    const link = argv.find((a) => a.startsWith('celchat://'));
    if (link) sendLink(link);
  });
}
app.setAsDefaultProtocolClient('celchat');

function sendLink(link) {
  // celchat://oauth#... : Google sign-in finished in the system browser (see client/src/core/google.ts)
  if (link.startsWith('celchat://oauth') && win) {
    const hash = link.slice(link.indexOf('#') + 1);
    if (hash && hash.length < 8192) win.webContents.send('cel:command', { type: 'oauth', hash });
    return;
  }
  // celchat://join/<community>/<code>
  const m = /celchat:\/\/join\/([0-9a-f]{64})\/([A-Za-z0-9]{6,16})/.exec(link);
  if (m && win) win.webContents.send('cel:command', { type: 'join', link: `${m[1]}/${m[2]}` });
}

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b1016',
    title: 'CelChat',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} CelChatDesktop/${app.getVersion()}`);
  win.loadURL(`${SCHEME}://${HOST}/index.html`);
  win.once('ready-to-show', () => win.show());

  // links open in the real browser; the app never navigates away from itself
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (!quitting && prefs().closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => (win = null));
}

function badgeIcon(count) {
  // a small red dot with the mention count for the Windows taskbar overlay
  const label = count > 99 ? '99+' : String(count || '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#ff5c6c"/><text x="16" y="21.5" font-family="Segoe UI,Arial" font-size="${label.length > 2 ? 12 : 16}" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function updateBadge() {
  if (!win) return;
  if (process.platform === 'win32') {
    win.setOverlayIcon(unread.mentions ? badgeIcon(unread.mentions) : null, unread.mentions ? `${unread.mentions} mentions` : '');
  } else app.setBadgeCount(unread.mentions);
  tray?.setToolTip(unread.mentions ? `CelChat: ${unread.mentions} unread mentions` : 'CelChat');
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('CelChat');
  tray.on('click', show);
  const refresh = () => {
    const p = prefs();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open CelChat', click: show },
        { type: 'separator' },
        { label: 'Toggle mute', accelerator: 'CommandOrControl+Shift+Alt+M', click: () => win?.webContents.send('cel:command', { type: 'mute' }) },
        { label: 'Toggle deafen', accelerator: 'CommandOrControl+Shift+Alt+D', click: () => win?.webContents.send('cel:command', { type: 'deafen' }) },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (it) => app.setLoginItemSettings({ openAtLogin: it.checked, args: ['--hidden'] }),
        },
        { label: 'Keep running in the tray when closed', type: 'checkbox', checked: p.closeToTray, click: (it) => (savePrefs({ ...p, closeToTray: it.checked }), refresh()) },
        { type: 'separator' },
        { label: 'Quit CelChat', click: () => ((quitting = true), app.quit()) },
      ]),
    );
  };
  refresh();
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return net.fetch(pathToFileURL(path.join(DIST, 'index.html')).toString());
    return net.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;
  // microphone, camera, screen capture and notifications are what CelChat asks for
  const allowed = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen', 'persistent-storage']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      // Windows/Linux: share the primary screen (with system audio on Windows). macOS uses the system picker.
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      cb(sources[0] ? { video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined } : {});
    },
    { useSystemPicker: true },
  );

  createWindow();
  buildTray();

  globalShortcut.register('CommandOrControl+Shift+Alt+M', () => win?.webContents.send('cel:command', { type: 'mute' }));
  globalShortcut.register('CommandOrControl+Shift+Alt+D', () => win?.webContents.send('cel:command', { type: 'deafen' }));

  const link = process.argv.find((a) => a.startsWith('celchat://'));
  if (link) win.webContents.once('did-finish-load', () => sendLink(link));
  if (process.argv.includes('--hidden')) win.once('ready-to-show', () => win.hide());
});

ipcMain.on('cel:badge', (_e, mentions, any) => {
  const grew = mentions > unread.mentions;
  unread = { mentions: Math.max(0, Number(mentions) || 0), any: !!any };
  updateBadge();
  if (grew && win && !win.isFocused()) win.flashFrame(true);
});
ipcMain.handle('cel:info', () => ({ version: app.getVersion(), platform: process.platform, notifications: Notification.isSupported() }));

app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', show);
