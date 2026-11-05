/** Desktop notifications and synthesized sounds (no audio assets needed). */

let ctx: AudioContext | null = null;
function audio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freqs: number[], dur = 0.12, gap = 0.06, vol = 0.12, type: OscillatorType = 'sine') {
  try {
    const a = audio();
    let t = a.currentTime + 0.01;
    for (const f of freqs) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  } catch {
    /* audio blocked until user gesture */
  }
}

export const sounds = {
  message: () => tone([880, 1320], 0.09, 0.03, 0.08),
  mention: () => tone([660, 990, 1320], 0.1, 0.03, 0.1),
  join: () => tone([520, 780], 0.1, 0.02, 0.09, 'triangle'),
  leave: () => tone([780, 520], 0.1, 0.02, 0.09, 'triangle'),
  mute: () => tone([400], 0.07, 0, 0.08, 'triangle'),
  unmute: () => tone([600], 0.07, 0, 0.08, 'triangle'),
  friend: () => tone([700, 900, 1100], 0.08, 0.03, 0.08),
};

let ringTimer: ReturnType<typeof setInterval> | null = null;
export function startRinging(outgoing = false) {
  stopRinging();
  const ring = () => (outgoing ? tone([440, 440], 0.35, 0.2, 0.05) : tone([784, 988, 784, 988], 0.16, 0.04, 0.1));
  ring();
  ringTimer = setInterval(ring, outgoing ? 3000 : 2200);
}
export function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

export async function askNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function desktopNotify(title: string, body: string, icon: string | null, onClick: () => void, tag?: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 200), icon: icon ?? './icon.svg', tag, silent: true });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* some browsers require a service worker */
  }
}

/** Update tab title + favicon badge with unread counts. */
export function setBadge(mentions: number, unread: boolean) {
  window.celDesktop?.setBadge(mentions, unread);
  document.title = `${mentions ? `(${mentions}) ` : unread ? '• ' : ''}CelChat`;
}
