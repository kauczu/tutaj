import type { Grid, Tile } from './grid';
import { icon } from './icons';

/** Popup name: the desktop app recognises it and places the window on the chosen monitor. */
export const STAGE_WINDOW_NAME = 'tutaj-stage';

const CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #02060c; color: #e8f1fa; overflow: hidden; }
body.idle { cursor: none; }
#grid { position: fixed; inset: 0; display: grid; gap: 10px; padding: 10px; grid-template: 1fr / 1fr; }
#grid[data-count="2"] { grid-template: 1fr / 1fr 1fr; }
#grid[data-count="3"], #grid[data-count="4"] { grid-template: 1fr 1fr / 1fr 1fr; }
#grid[data-count="3"] .tile:nth-child(3) { grid-column: 1 / span 2; justify-self: center; width: 50%; }
@media (max-aspect-ratio: 1/1) {
  #grid[data-count="2"] { grid-template: 1fr 1fr / 1fr; }
}
.tile { position: relative; min-width: 0; min-height: 0; border-radius: 14px; overflow: hidden; background: #000e29; }
.tile::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(108, 158, 202, 0.2); transition: box-shadow 0.15s; }
.tile.speaking::after { box-shadow: inset 0 0 0 4px #4fd1a5, 0 0 24px rgba(79, 209, 165, 0.35); }
video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
.tile.mirror video { transform: scaleX(-1); }
.tile.no-video video { visibility: hidden; }
.avatar { position: absolute; inset: 0; margin: auto; width: 22vmin; height: 22vmin; border-radius: 50%; display: none;
  place-items: center; font-size: 10vmin; font-weight: 600; background: linear-gradient(135deg, #63b6e6, #295887); }
.tile.no-video .avatar { display: grid; }
.label { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px);
  padding: 6px 12px; border-radius: 10px; background: rgba(4, 11, 28, 0.72); font-size: clamp(14px, 1.6vw, 22px); }
.label .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label .mic { display: none; color: #e5484d; }
.tile.muted .label .mic { display: inline-flex; }
.empty { position: fixed; inset: 0; display: grid; place-items: center; color: #93aec9; font-size: 20px; }
.toolbar { position: fixed; top: 14px; right: 14px; display: flex; gap: 8px; opacity: 0; transition: opacity 0.2s; }
body:not(.idle) .toolbar { opacity: 1; }
.toolbar button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  color: #e8f1fa; background: rgba(4, 11, 28, 0.82); border: 1px solid rgba(168, 196, 216, 0.32); font: inherit; font-size: 14px; }
.toolbar button:hover { background: rgba(41, 88, 135, 0.8); }
.toolbar button[aria-pressed="true"] { border-color: #7fc4f0; }
`;

interface StageTile {
  el: HTMLDivElement;
  video: HTMLVideoElement;
  avatar: HTMLDivElement;
  name: HTMLSpanElement;
}

/**
 * Camera view in a separate window, meant for a second monitor while gaming.
 *
 * The window is a same-origin popup scripted from here, so it shows the very same MediaStreams
 * as the call window — no extra decoding, no extra network traffic. It plays no audio (the call
 * window does). In the desktop app it opens fullscreen on the chosen monitor.
 */
export class StageWindow {
  private win: Window | null = null;
  private tiles = new Map<string, StageTile>();
  private showSelf = false;
  private offGrid: (() => void) | null = null;
  private closedTimer = 0;
  private idleTimer = 0;

  constructor(
    private readonly grid: Grid,
    private readonly onToggle: (open: boolean) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Opens the window (must be called from a user gesture), or focuses it if already open. */
  open(): boolean {
    if (this.isOpen) {
      this.win!.focus();
      return true;
    }
    const w = Math.round(screen.availWidth * 0.6);
    const h = Math.round(screen.availHeight * 0.6);
    const win = window.open('', STAGE_WINDOW_NAME, `popup,width=${w},height=${h}`);
    if (!win) return false;
    this.win = win;
    this.build(win.document);
    this.offGrid = this.grid.onChange(() => this.render());
    this.render();
    // Closed by the user (window ✕, Alt+F4): no reliable event across browsers, so poll.
    this.closedTimer = window.setInterval(() => {
      if (this.win?.closed) this.cleanup();
    }, 500);
    this.onToggle(true);
    return true;
  }

  close(): void {
    const win = this.win;
    this.cleanup();
    win?.close();
  }

  toggle(): boolean {
    if (this.isOpen) {
      this.close();
      return true;
    }
    return this.open();
  }

  private cleanup(): void {
    if (!this.win) return;
    clearInterval(this.closedTimer);
    clearTimeout(this.idleTimer);
    this.offGrid?.();
    this.offGrid = null;
    for (const t of this.tiles.values()) t.video.srcObject = null;
    this.tiles.clear();
    this.win = null;
    this.onToggle(false);
  }

  private build(doc: Document): void {
    doc.title = 'Tutaj — kamery';
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.append(style);
    doc.body.replaceChildren();

    const grid = doc.createElement('div');
    grid.id = 'grid';
    const empty = doc.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Czekam na innych uczestników…';

    const button = (text: string, onClick: (b: HTMLButtonElement) => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.onclick = () => onClick(b);
      return b;
    };
    const self = button('Pokaż mnie', (b) => {
      this.showSelf = !this.showSelf;
      b.setAttribute('aria-pressed', String(this.showSelf));
      this.render();
    });
    self.id = 'stage-self';
    self.setAttribute('aria-pressed', String(this.showSelf));
    const full = button('Pełny ekran', () => {
      if (doc.fullscreenElement) void doc.exitFullscreen();
      else void doc.documentElement.requestFullscreen?.().catch(() => {});
    });
    const close = button('Zamknij', () => this.close());
    const toolbar = doc.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.append(self, full, close);
    doc.body.append(grid, empty, toolbar);

    // Toolbar and cursor only while the mouse moves.
    const wake = () => {
      doc.body.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => doc.body.classList.add('idle'), 2500);
    };
    doc.addEventListener('mousemove', wake);
    doc.addEventListener('dblclick', () => full.click());
    doc.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'f') full.click();
    });
    wake();
  }

  private render(): void {
    const doc = this.win && !this.win.closed ? this.win.document : null;
    if (!doc) return;
    const grid = doc.getElementById('grid')!;
    const shown = this.grid.all().filter((t) => this.showSelf || !t.local);
    const ids = new Set(shown.map((t) => t.id));
    for (const [id, t] of this.tiles) {
      if (ids.has(id)) continue;
      t.video.srcObject = null;
      t.el.remove();
      this.tiles.delete(id);
    }
    for (const tile of shown) this.update(doc, grid, tile);
    // Keep the call window's order (remote peers in join order).
    for (const tile of shown) grid.append(this.tiles.get(tile.id)!.el);
    grid.dataset.count = String(shown.length);
    (doc.querySelector('.empty') as HTMLElement).hidden = shown.length > 0;
  }

  private update(doc: Document, grid: HTMLElement, tile: Tile): void {
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
      grid.append(el);
      t = { el, video, avatar, name };
      this.tiles.set(tile.id, t);
    }
    const stream = tile.stream;
    if (t.video.srcObject !== stream) {
      t.video.srcObject = stream;
      void t.video.play().catch(() => {});
    }
    const s = tile.state;
    t.name.textContent = tile.local ? `${s.name} (Ty)` : s.name;
    t.avatar.textContent = (s.name.trim()[0] ?? '?').toUpperCase();
    t.el.classList.toggle('no-video', !s.video);
    t.el.classList.toggle('muted', !s.audio);
    t.el.classList.toggle('speaking', tile.speaking);
    t.el.classList.toggle('mirror', tile.local && !s.screen);
  }
}
