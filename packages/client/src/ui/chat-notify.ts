import { t } from '../i18n';
import { toast } from './toast';

const SOUND_KEY = 'tutaj:chat-sound';

/** Whether a new chat message plays a short sound (Settings → Devices; on by default). */
export function chatSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setChatSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* no storage */
  }
}

let audio: AudioContext | null = null;

/** A soft two-note chime, made on the spot (no sound files). */
export function playChatSound(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const now = audio.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.11;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    /* no WebAudio */
  }
}

const preview = (text: string) => (text.length > 90 ? `${text.slice(0, 87)}…` : text);

/**
 * Someone wrote in the chat. Nothing if you are reading the chat right now; otherwise a chime (unless
 * turned off) and a bubble with the message — inside the window, or as a system notification when the
 * window is in the background (desktop app; in a browser only if notifications were already allowed).
 */
export function notifyChat(from: string, text: string, chatOpen: boolean, openChat: () => void): void {
  const watching = document.visibilityState === 'visible' && document.hasFocus();
  if (chatOpen && watching) return;
  if (chatSoundOn()) playChatSound();
  if (watching) {
    toast(t('chat.newFrom', { name: from, text: preview(text) }), 'info', 5000);
    return;
  }
  void systemNotification(from, preview(text), openChat);
}

async function systemNotification(from: string, text: string, openChat: () => void): Promise<void> {
  if (!('Notification' in window)) return;
  // The desktop app allows notifications without asking; a browser page never asks out of the blue.
  if (Notification.permission === 'default' && window.tutaj) await Notification.requestPermission().catch(() => {});
  if (Notification.permission !== 'granted') {
    toast(t('chat.newFrom', { name: from, text }), 'info', 5000);
    return;
  }
  const n = new Notification(t('chat.notifyTitle', { name: from }), { body: text, tag: 'tutaj-chat', silent: true });
  n.onclick = () => {
    window.focus();
    openChat();
    n.close();
  };
}
