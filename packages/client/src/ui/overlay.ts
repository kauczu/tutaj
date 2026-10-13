import type { Grid, Tile } from './grid';
import { icon } from './icons';

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
`;

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
  private lastSize = '';

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
    this.render();
    return true;
  }

  close(): void {
    const win = this.win;
    this.offGrid?.();
    this.offGrid = null;
    for (const t of this.tiles.values()) t.video.srcObject = null;
    this.tiles.clear();
    this.win = null;
    if (win && !win.closed) win.close();
  }

  update(settings: OverlaySettings): void {
    this.settings = settings;
    this.render();
  }

  private build(doc: Document): void {
    doc.title = 'Tutaj — nakładka';
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.append(style);
    const root = doc.createElement('div');
    root.id = 'root';
    const badge = doc.createElement('div');
    badge.className = 'badge';
    badge.id = 'muted-badge';
    badge.innerHTML = `${icon('micOff')}<span>Mikrofon wyciszony</span>`;
    root.append(badge);
    doc.body.replaceChildren(root);
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
    if (this.settings.corner.startsWith('bottom')) root.replaceChildren(...ordered, badge);
    else root.replaceChildren(badge, ...ordered);
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
    const empty = root.querySelectorAll('.tile').length === 0 && (root.querySelector('#muted-badge') as HTMLElement).hidden;
    const width = empty ? 1 : Math.ceil(r.width);
    const height = empty ? 1 : Math.ceil(r.height);
    const key = `${width}x${height}`;
    if (key === this.lastSize) return;
    this.lastSize = key;
    this.resize(width, height);
  }
}
