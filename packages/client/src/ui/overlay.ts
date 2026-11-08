import type { Grid, Tile } from './grid';
import { icon } from './icons';
import { REACTION_CSS, floatReaction } from './reactions';
import { t } from '../i18n';

/** Popup name: the desktop app turns it into a transparent, click-through, always-on-top window. */
export const OVERLAY_WINDOW_NAME = 'tutaj-overlay';

export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type OverlaySize = 's' | 'm' | 'l';

export interface OverlaySettings {
  enabled: boolean;
  corner: OverlayCorner;
  size: OverlaySize;
  opacity: number;
  /** Monitor (Electron display id); null = primary. */
  display: number | null;
  /** Showing the overlay by hand minimizes the call window; hiding it restores the window (done by the app). */
  minimizeCall: boolean;
}

/** Width of a camera tile in the overlay, CSS px. */
const TILE_WIDTH: Record<OverlaySize, number> = { s: 200, m: 280, l: 380 };

const CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: transparent; overflow: hidden; color: #e8f1fa; user-select: none; }
#root { display: inline-flex; flex-direction: column; gap: 8px; padding: 4px; }
body.right #root { align-items: flex-end; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 10px; font-size: 14px; font-weight: 600;
  background: rgba(229, 72, 77, 0.92); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); }
.badge svg { width: 18px; height: 18px; }
.tile { position: relative; opacity: var(--opacity, 1); width: var(--w); aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #000e29;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55); }
.tile::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(168, 196, 216, 0.25); }
.tile.speaking::after { box-shadow: inset 0 0 0 3px #4fd1a5; }
video { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Camera off: a slim row instead of a black box. */
.tile.no-video { aspect-ratio: auto; height: 40px; display: flex; align-items: center; }
.tile.no-video video { display: none; }
.avatar { display: none; width: 28px; height: 28px; margin-left: 6px; border-radius: 50%; place-items: center; flex: none;
  font-size: 14px; font-weight: 700; background: linear-gradient(135deg, #63b6e6, #295887); }
.tile.no-video .avatar { display: grid; }
.label { position: absolute; left: 6px; bottom: 6px; display: flex; align-items: center; gap: 5px; max-width: calc(100% - 12px);
  padding: 2px 8px; border-radius: 7px; background: rgba(4, 11, 28, 0.75); font-size: 13px; }
.tile.no-video .label { position: static; background: none; }
.label .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label .mic { display: none; color: #ff6b70; }
.label .mic svg { width: 15px; height: 15px; }
.tile.muted .label .mic { display: inline-flex; }
${REACTION_CSS}
.tile.no-video .reaction { bottom: -10%; font-size: 26px; }
/* Chat over the game: the latest messages for a while, and a field to write (shortcut). */
.chat { display: flex; flex-direction: column; gap: 4px; width: var(--w); }
.chat:empty { display: none; }
.msg { padding: 5px 9px; border-radius: 9px; font-size: 14px; line-height: 1.35; background: rgba(4, 11, 28, 0.82);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); word-wrap: break-word; animation: msg-in 0.2s ease-out; }
.msg b { color: #a8c4d8; font-weight: 600; margin-right: 4px; }
.msg.self b { color: #4fd1a5; }
.msg.fading { opacity: 0; transition: opacity 0.6s; }
@keyframes msg-in { from { opacity: 0; transform: translateY(4px); } }
.chat-input { display: flex; flex-direction: column; gap: 3px; padding: 6px; border-radius: 10px; background: rgba(4, 11, 28, 0.92);
  box-shadow: 0 0 0 2px #4d9aca, 0 2px 10px rgba(0, 0, 0, 0.6); }
.chat-input input { font: inherit; font-size: 14px; color: #e8f1fa; background: rgba(16, 31, 72, 0.9); border: 0; border-radius: 7px;
  padding: 7px 9px; outline: none; user-select: text; }
.chat-input small { font-size: 11px; color: #93aec9; padding: 0 2px; }
`;

/** How long a chat message stays over the game. */
const MESSAGE_MS = 15_000;
/** At most this many messages at once. */
const MAX_MESSAGES = 4;

interface OverlayTile {
  el: HTMLDivElement;
  video: HTMLVideoElement;
  avatar: HTMLDivElement;
  name: HTMLSpanElement;
}

/**
 * Game overlay (desktop app): small cameras of the other participants over the game.
 *
 * Like the call window it is a same-origin popup scripted from here — the same MediaStreams,
 * no extra decoding. The desktop app makes it transparent, always on top, click-through and
 * unfocusable, and places it in the chosen corner; we only report the size of the content.
 * It plays no audio (the call window does).
 */
export class GameOverlay {
  private win: Window | null = null;
  private tiles = new Map<string, OverlayTile>();
  private offGrid: (() => void) | null = null;
  private offReactions: (() => void) | null = null;
  private lastSize = '';
  /** Chat over the game: recent messages and, while writing, the input field. */
  private chatBox: HTMLDivElement | null = null;
  private writing: (() => void) | null = null;

  constructor(
    private readonly grid: Grid,
    private settings: OverlaySettings,
    private readonly resize: (width: number, height: number) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  open(): boolean {
    if (this.isOpen) return true;
    const win = window.open('', OVERLAY_WINDOW_NAME, 'popup,width=300,height=200');
    if (!win) return false;
    this.win = win;
    this.lastSize = '';
    this.build(win.document);
    this.offGrid = this.grid.onChange(() => this.render());
    // Others' reactions float over their tiles here too.
    this.offReactions = this.grid.onReaction((id, emoji) => {
      const t = this.tiles.get(id);
      if (t) floatReaction(t.el, emoji);
    });
    this.render();
    return true;
  }

  close(): void {
    const win = this.win;
    this.offGrid?.();
    this.offGrid = null;
    this.offReactions?.();
    this.offReactions = null;
    for (const t of this.tiles.values()) t.video.srcObject = null;
    this.tiles.clear();
    this.writing?.();
    this.chatBox = null;
    this.win = null;
    if (win && !win.closed) win.close();
  }

  update(settings: OverlaySettings): void {
    this.settings = settings;
    this.render();
  }

  private build(doc: Document): void {
    doc.title = t('ov.windowTitle');
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.append(style);
    const root = doc.createElement('div');
    root.id = 'root';
    const badge = doc.createElement('div');
    badge.className = 'badge';
    badge.id = 'muted-badge';
    badge.innerHTML = icon('micOff');
    badge.append(doc.createElement('span'));
    badge.lastElementChild!.textContent = t('ov.micMuted');
    root.append(badge);
    this.chatBox = doc.createElement('div');
    this.chatBox.className = 'chat';
    doc.body.replaceChildren(root);
  }

  /** A chat message shows over the game for a while (ours too, so the conversation reads in order). */
  chatMessage(from: string, text: string, self: boolean): void {
    const doc = this.win && !this.win.closed ? this.win.document : null;
    if (!doc || !this.chatBox) return;
    const el = doc.createElement('div');
    el.className = `msg${self ? ' self' : ''}`;
    const name = doc.createElement('b');
    name.textContent = `${from}:`;
    el.append(name, text.length > 200 ? `${text.slice(0, 197)}…` : text);
    const input = this.chatBox.querySelector('.chat-input');
    this.chatBox.insertBefore(el, input);
    const msgs = this.chatBox.querySelectorAll('.msg');
    if (msgs.length > MAX_MESSAGES) msgs[0].remove();
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => {
        el.remove();
        this.render();
      }, 600);
    }, MESSAGE_MS);
    this.render();
  }

  get isWriting(): boolean {
    return !!this.writing;
  }

  /**
   * A field to write in, over the game (the app gives the overlay the keyboard for that moment).
   * Enter sends, Esc or an empty Enter cancels; `onDone` runs either way.
   */
  writeMessage(send: (text: string) => void, onDone: () => void): void {
    const doc = this.win && !this.win.closed ? this.win.document : null;
    if (!doc || !this.chatBox || this.writing) return;
    const box = doc.createElement('div');
    box.className = 'chat-input';
    const input = doc.createElement('input');
    input.maxLength = 2000;
    input.placeholder = t('ov.chatPlaceholder');
    const hint = doc.createElement('small');
    hint.textContent = t('ov.chatHint');
    box.append(input, hint);
    this.chatBox.append(box);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.writing = null;
      box.remove();
      this.render();
      onDone();
    };
    this.writing = finish;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return finish();
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (text) send(text);
      finish();
    });
    input.addEventListener('blur', () => setTimeout(finish, 50));
    this.render();
    input.focus();
  }

  private render(): void {
    const doc = this.win && !this.win.closed ? this.win.document : null;
    if (!doc) return;
    const root = doc.getElementById('root')!;
    // Tiles only: the muted badge always stays fully visible.
    root.style.setProperty('--opacity', String(this.settings.opacity));
    root.style.setProperty('--w', `${TILE_WIDTH[this.settings.size]}px`);
    doc.body.classList.toggle('right', this.settings.corner.endsWith('right'));
    doc.body.classList.toggle('bottom', this.settings.corner.startsWith('bottom'));

    const all = this.grid.all();
    const self = all.find((t) => t.local);
    // Our own mic state matters most mid-game: a muted mic shows as a red badge.
    (doc.getElementById('muted-badge') as HTMLElement).hidden = !self || self.state.audio;

    const others = all.filter((t) => !t.local);
    const ids = new Set(others.map((t) => t.id));
    for (const [id, t] of this.tiles) {
      if (ids.has(id)) continue;
      t.video.srcObject = null;
      t.el.remove();
      this.tiles.delete(id);
    }
    for (const tile of others) this.update1(doc, tile);
    const badge = doc.getElementById('muted-badge')!;
    const ordered = others.map((t) => this.tiles.get(t.id)!.el);
    // Badge on the screen edge side: top corners above the tiles, bottom corners below.
    const chat = this.chatBox ? [this.chatBox] : [];
    if (this.settings.corner.startsWith('bottom')) root.replaceChildren(...chat, ...ordered, badge);
    else root.replaceChildren(badge, ...ordered, ...chat);
    this.reportSize(root);
  }

  private update1(doc: Document, tile: Tile): void {
    let t = this.tiles.get(tile.id);
    if (!t) {
      const el = doc.createElement('div');
      el.className = 'tile';
      el.dataset.id = tile.id;
      const video = doc.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // audio plays in the call window
      const avatar = doc.createElement('div');
      avatar.className = 'avatar';
      const label = doc.createElement('div');
      label.className = 'label';
      const mic = doc.createElement('span');
      mic.className = 'mic';
      mic.innerHTML = icon('micOff');
      const name = doc.createElement('span');
      name.className = 'name';
      label.append(mic, name);
      el.append(video, avatar, label);
      t = { el, video, avatar, name };
      this.tiles.set(tile.id, t);
    }
    const stream = tile.stream;
    if (t.video.srcObject !== stream) t.video.srcObject = stream;
    if (stream && t.video.paused) void t.video.play().catch(() => {});
    const s = tile.state;
    t.name.textContent = s.name;
    t.avatar.textContent = (s.name.trim()[0] ?? '?').toUpperCase();
    t.el.classList.toggle('no-video', !s.video);
    t.el.classList.toggle('muted', !s.audio);
    t.el.classList.toggle('speaking', tile.speaking);
  }

  /** The window is exactly as big as its content, so it covers no more of the game than needed. */
  private reportSize(root: HTMLElement): void {
    const r = root.getBoundingClientRect();
    const empty =
      root.querySelectorAll('.tile, .msg, .chat-input').length === 0 && (root.querySelector('#muted-badge') as HTMLElement).hidden;
    const width = empty ? 1 : Math.ceil(r.width);
    const height = empty ? 1 : Math.ceil(r.height);
    const key = `${width}x${height}`;
    if (key === this.lastSize) return;
    this.lastSize = key;
    this.resize(width, height);
  }
}
