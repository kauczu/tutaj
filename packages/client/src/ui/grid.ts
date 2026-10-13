import type { PeerState } from '../messages';
import type { PeerStats } from '../peer';
import { h } from './dom';
import { icon } from './icons';

const QUALITY_LABEL = { good: 'Dobre połączenie', fair: 'Średnie połączenie', poor: 'Słabe połączenie', unknown: 'Łączenie…' };

export class Tile {
  readonly el: HTMLDivElement;
  readonly video: HTMLVideoElement;
  private readonly avatar: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly micEl: HTMLSpanElement;
  private readonly handEl: HTMLSpanElement;
  private readonly qualityEl: HTMLSpanElement;
  private readonly statusEl: HTMLDivElement;
  state: PeerState;
  speaking = false;
  /** Set by the grid: called whatever changes what the tile shows (mirrored by the stage window). */
  onChange: () => void = () => {};

  constructor(readonly id: string, state: PeerState, readonly local: boolean) {
    this.state = state;
    this.video = h('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = local; // never play our own mic back
    this.avatar = h('div', { class: 'avatar' });
    this.nameEl = h('span', { class: 'name' });
    this.micEl = h('span', { class: 'mic-off', title: 'Wyciszony' });
    this.micEl.innerHTML = icon('micOff');
    this.handEl = h('span', { class: 'hand', text: '✋', title: 'Podniesiona ręka' });
    this.qualityEl = h('span', { class: 'quality unknown' });
    this.statusEl = h('div', { class: 'status' });
    this.el = h(
      'div',
      { class: `tile${local ? ' local' : ''}` },
      this.video,
      this.avatar,
      this.statusEl,
      this.handEl,
      h('div', { class: 'label' }, this.qualityEl, this.micEl, this.nameEl),
    );
    this.setState(state);
  }

  setStream(stream: MediaStream): void {
    if (this.video.srcObject !== stream) {
      this.video.srcObject = stream;
      this.onChange();
    }
    void this.video.play().catch(() => {});
  }

  get stream(): MediaStream | null {
    return this.video.srcObject instanceof MediaStream ? this.video.srcObject : null;
  }

  setState(state: PeerState): void {
    this.state = state;
    const label = this.local ? `${state.name} (Ty)` : state.name;
    this.nameEl.textContent = label;
    this.avatar.textContent = (state.name.trim()[0] ?? '?').toUpperCase();
    this.el.classList.toggle('no-video', !state.video);
    this.el.classList.toggle('screen', state.screen);
    this.el.classList.toggle('muted', !state.audio);
    this.el.classList.toggle('hand-up', state.hand);
    // Mirror our own camera (feels natural), but never a shared screen.
    this.el.classList.toggle('mirror', this.local && !state.screen);
    this.onChange();
  }

  setStats(stats: PeerStats | null): void {
    const q = stats?.quality ?? 'unknown';
    this.qualityEl.className = `quality ${q}`;
    this.qualityEl.title = stats
      ? `${QUALITY_LABEL[q]} · RTT ${stats.rttMs ?? '–'} ms · straty ${stats.lossPct.toFixed(1)}%${stats.relayed ? ' · przez TURN' : ''}`
      : QUALITY_LABEL.unknown;
  }

  setStatus(text: string | null): void {
    this.statusEl.textContent = text ?? '';
    this.statusEl.hidden = !text;
  }

  setSpeaking(on: boolean): void {
    const speaking = on && this.state.audio;
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.el.classList.toggle('speaking', speaking);
    this.onChange();
  }
}

/** Video grid. Click a tile to spotlight it, double-click for fullscreen. */
export class Grid {
  private tiles = new Map<string, Tile>();
  private pinned: string | null = null;
  private listeners = new Set<() => void>();
  private pending = false;

  constructor(private readonly el: HTMLElement) {}

  /** Called (batched) when tiles are added/removed or a tile's stream, state or speaking changes. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    if (this.pending || !this.listeners.size) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const fn of this.listeners) fn();
    });
  }

  add(tile: Tile): void {
    this.tiles.set(tile.id, tile);
    tile.onChange = () => this.changed();
    tile.el.addEventListener('click', () => this.pin(this.pinned === tile.id ? null : tile.id));
    tile.el.addEventListener('dblclick', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void tile.el.requestFullscreen?.();
    });
    this.el.append(tile.el);
    this.layout();
    this.changed();
  }

  remove(id: string): void {
    this.tiles.get(id)?.el.remove();
    this.tiles.delete(id);
    if (this.pinned === id) this.pinned = null;
    this.layout();
    this.changed();
  }

  get(id: string): Tile | undefined {
    return this.tiles.get(id);
  }

  all(): Tile[] {
    return [...this.tiles.values()];
  }

  pin(id: string | null): void {
    this.pinned = id;
    for (const t of this.tiles.values()) t.el.classList.toggle('pinned', t.id === id);
    this.layout();
  }

  private layout(): void {
    this.el.dataset.count = String(this.tiles.size);
    this.el.classList.toggle('has-pinned', !!this.pinned && this.tiles.size > 1);
  }
}
