import { t } from '../i18n';
import type { Grid, Tile } from './grid';
import { icon, type IconName } from './icons';
import { REACTION_CSS, floatReaction } from './reactions';

/** Document Picture-in-Picture (Chrome, Edge). */
interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPip;
  }
}

const CSS = `
:root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: #02060c; color: #e8f1fa; overflow: hidden; }
body { display: grid; grid-template-rows: 1fr auto; }
#grid { min-height: 0; display: grid; gap: 6px; padding: 6px; grid-template: 1fr / 1fr; }
#grid[data-count="2"] { grid-template: 1fr / 1fr 1fr; }
#grid[data-count="3"], #grid[data-count="4"] { grid-template: 1fr 1fr / 1fr 1fr; }
@media (max-aspect-ratio: 1/1) { #grid[data-count="2"] { grid-template: 1fr 1fr / 1fr; } }
.tile { position: relative; min-width: 0; min-height: 0; border-radius: 10px; overflow: hidden; background: #000e29; }
.tile::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(108, 158, 202, 0.2); }
.tile.speaking::after { box-shadow: inset 0 0 0 3px #4fd1a5; }
video { width: 100%; height: 100%; object-fit: cover; display: block; background: #000; }
.tile.no-video video { visibility: hidden; }
.avatar { position: absolute; inset: 0; margin: auto; width: 34%; aspect-ratio: 1; height: auto; max-height: 60%; border-radius: 50%;
  display: none; place-items: center; font-size: 22px; font-weight: 600; background: linear-gradient(135deg, #63b6e6, #295887); }
.tile.no-video .avatar { display: grid; }
.label { position: absolute; left: 6px; bottom: 6px; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 12px);
  padding: 2px 8px; border-radius: 7px; background: rgba(4, 11, 28, 0.75); font-size: 12px; }
.label .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label .mic { display: none; color: #ff6b70; }
.label .mic svg { width: 14px; height: 14px; }
.tile.muted .label .mic { display: inline-flex; }
.empty { display: grid; place-items: center; text-align: center; padding: 16px; color: #93aec9; font-size: 14px; }
.bar { display: flex; justify-content: center; gap: 8px; padding: 6px 8px 8px; }
.bar button { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  color: #e8f1fa; background: rgba(16, 31, 72, 0.8); border: 1px solid rgba(168, 196, 216, 0.3); }
.bar button:hover { background: rgba(41, 88, 135, 0.85); }
.bar button svg { width: 20px; height: 20px; }
.bar button.off { background: rgba(229, 72, 77, 0.25); border-color: rgba(229, 72, 77, 0.6); color: #ff9a9d; }
.bar button.danger { background: #e5484d; border-color: #e5484d; color: #fff; }
${REACTION_CSS}
`;

/** What the mini window can do in the call, and the state its buttons show. */
export interface PipControls {
  toggleMic(): void;
  toggleCam(): void;
  leave(): void;
  micOn(): boolean;
  camOn(): boolean;
}

interface PipTile {
  el: HTMLDivElement;
  video: HTMLVideoElement;
  avatar: HTMLDivElement;
  name: HTMLSpanElement;
}

/**
 * Picture-in-picture for the browser: an always-on-top mini window with the others' cameras and
 * the basic buttons, so the call stays in sight while you work in another tab or program. (The
 * desktop app has the game overlay instead.) Uses Document Picture-in-Picture — the same
 * MediaStreams as the call, no extra decoding; it plays no audio (the call tab does).
 */
export class PipWindow {
  static supported(): boolean {
    return !!window.documentPictureInPicture && !window.tutaj;
  }

  private win: Window | null = null;
  private tiles = new Map<string, PipTile>();
  private offGrid: (() => void) | null = null;
  private offReactions: (() => void) | null = null;
  private closedTimer = 0;
  private buttons: { mic: HTMLButtonElement; cam: HTMLButtonElement } | null = null;

  constructor(
    private readonly grid: Grid,
    private readonly controls: PipControls,
    private readonly onToggle: (open: boolean) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Must run in a user gesture (button, key) or the browser's own "enter picture-in-picture" action. */
  async open(): Promise<void> {
    if (this.isOpen || !window.documentPictureInPicture) return;
    const others = this.grid.all().filter((t) => !t.local).length;
    const win = await window.documentPictureInPicture.requestWindow({ width: others > 1 ? 480 : 360, height: others > 2 ? 380 : 270 });
    this.win = win;
    this.build(win.document);
    this.offGrid = this.grid.onChange(() => this.render());
    this.offReactions = this.grid.onReaction((id, emoji) => {
      const tile = this.tiles.get(id);
      if (tile) floatReaction(tile.el, emoji);
    });
    win.addEventListener('pagehide', () => this.cleanup());
    // Fallback for browsers that close it without 'pagehide'.
    this.closedTimer = window.setInterval(() => {
      if (this.win?.closed) this.cleanup();
    }, 1000);
    this.render();
    this.onToggle(true);
  }

  close(): void {
    const win = this.win;
    this.cleanup();
    if (win && !win.closed) win.close();
  }

  async toggle(): Promise<void> {
    if (this.isOpen) this.close();
    else await this.open();
  }

  /** Mic/camera state changed in the call. */
  refreshControls(): void {
    if (!this.buttons) return;
    this.setButton(this.buttons.mic, this.controls.micOn(), 'mic', 'micOff');
    this.setButton(this.buttons.cam, this.controls.camOn(), 'cam', 'camOff');
  }

  private cleanup(): void {
    if (!this.win) return;
    clearInterval(this.closedTimer);
    this.offGrid?.();
    this.offReactions?.();
    this.offGrid = this.offReactions = null;
    for (const tile of this.tiles.values()) tile.video.srcObject = null;
    this.tiles.clear();
    this.buttons = null;
    this.win = null;
    this.onToggle(false);
  }

  private setButton(button: HTMLButtonElement, on: boolean, iconOn: IconName, iconOff: IconName): void {
    button.innerHTML = icon(on ? iconOn : iconOff);
    button.classList.toggle('off', !on);
    button.setAttribute('aria-pressed', String(on));
  }

  private build(doc: Document): void {
    doc.title = t('pip.title');
    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.append(style);
    const grid = doc.createElement('div');
    grid.id = 'grid';
    const empty = doc.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('pip.waiting');
    grid.append(empty);
    const button = (id: string, title: string, onClick: () => void, cls = '') => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.id = id;
      b.title = title;
      b.className = cls;
      b.onclick = onClick;
      return b;
    };
    const mic = button('pip-mic', t('ctl.mic'), () => this.controls.toggleMic());
    const cam = button('pip-cam', t('ctl.cam'), () => this.controls.toggleCam());
    const leave = button('pip-leave', t('ctl.leave'), () => this.controls.leave(), 'danger');
    leave.innerHTML = icon('leave');
    const bar = doc.createElement('div');
    bar.className = 'bar';
    bar.append(mic, cam, leave);
    doc.body.replaceChildren(grid, bar);
    this.buttons = { mic, cam };
    this.refreshControls();
  }

  private render(): void {
    const doc = this.win && !this.win.closed ? this.win.document : null;
    if (!doc) return;
    const grid = doc.getElementById('grid')!;
    const others = this.grid.all().filter((t) => !t.local);
    const ids = new Set(others.map((t) => t.id));
    for (const [id, tile] of this.tiles) {
      if (ids.has(id)) continue;
      tile.video.srcObject = null;
      tile.el.remove();
      this.tiles.delete(id);
    }
    for (const tile of others) this.update(doc, tile);
    const empty = grid.querySelector<HTMLElement>('.empty')!;
    empty.hidden = others.length > 0;
    grid.replaceChildren(empty, ...others.map((t) => this.tiles.get(t.id)!.el));
    grid.dataset.count = String(Math.max(1, others.length));
  }

  private update(doc: Document, tile: Tile): void {
    let t = this.tiles.get(tile.id);
    if (!t) {
      const el = doc.createElement('div');
      el.className = 'tile';
      const video = doc.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // audio plays in the call tab
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
    if (t.video.srcObject !== tile.stream) t.video.srcObject = tile.stream;
    if (tile.stream && t.video.paused) void t.video.play().catch(() => {});
    const s = tile.state;
    t.name.textContent = s.name;
    t.avatar.textContent = (s.name.trim()[0] ?? '?').toUpperCase();
    t.el.classList.toggle('no-video', !s.video);
    t.el.classList.toggle('muted', !s.audio);
    t.el.classList.toggle('speaking', tile.speaking);
  }
}
