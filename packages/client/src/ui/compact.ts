import { t } from '../i18n';
import { $, h } from './dom';
import type { Grid } from './grid';

/** Phones (and very small windows): the same media query as the compact layout in style.css. */
export const COMPACT_QUERY = '(max-width: 700px), (max-height: 500px)';
const HIDE_AFTER_MS = 4000;
const CORNER_KEY = 'tutaj:selfview-corner';
type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface MoreItem {
  label: string;
  run: () => void;
}

/**
 * Call layout for phones: the others fill the screen edge to edge, our own camera is a small
 * window in a corner (drag it to another one, tap it to swap), and the control bar floats over
 * the picture and hides itself — a tap on the picture brings it back. Less used buttons go into
 * a "more" menu so the bar keeps to one row.
 */
export class CompactLayout {
  private readonly media = window.matchMedia(COMPACT_QUERY);
  private readonly view = $('room-view');
  private hideTimer = 0;
  private corner: Corner = 'br';
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly grid: Grid,
    private readonly extraItems: () => MoreItem[],
  ) {
    try {
      const saved = localStorage.getItem(CORNER_KEY);
      if (saved === 'tl' || saved === 'tr' || saved === 'bl' || saved === 'br') this.corner = saved;
    } catch {
      /* no storage */
    }
    grid.compact = () => this.active;
    grid.onStageTap = () => this.toggleControls();
    this.listen(this.media, 'change', () => this.update());

    // Any touch or key keeps the bar up; a tap on the empty stage toggles it.
    this.listen(this.view, 'pointerdown', () => {
      if (!this.view.classList.contains('controls-hidden')) this.scheduleHide();
    });
    this.listen(document, 'keydown', () => this.show());
    this.listen($('room-view').querySelector('.stage')!, 'click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('stage') || target.classList.contains('grid')) this.toggleControls();
    });
    // The bar's height, for keeping our own camera above it.
    const bar = this.view.querySelector<HTMLElement>('.controls')!;
    const ro = new ResizeObserver(() => this.view.style.setProperty('--bar-h', `${bar.offsetHeight}px`));
    ro.observe(bar);
    this.cleanups.push(() => ro.disconnect());

    this.listen($('btn-more'), 'click', () => this.toggleMore());
    this.listen(document, 'pointerdown', (e) => {
      const menu = $('more-menu');
      const target = e.target as Node;
      if (!menu.hidden && !menu.contains(target) && !$('btn-more').contains(target)) menu.hidden = true;
    });
    this.update();
  }

  get active(): boolean {
    return this.media.matches;
  }

  /** Tiles were added or removed: our own tile may have to (stop) floating. */
  refresh(): void {
    const local = this.grid.all().find((tile) => tile.local);
    if (local) {
      for (const c of ['tl', 'tr', 'bl', 'br']) local.el.classList.toggle(`corner-${c}`, c === this.corner);
      if (!local.el.dataset.draggable) {
        local.el.dataset.draggable = '1';
        this.makeDraggable(local.el);
      }
    }
    // Tiles change all the time (who is speaking): only start the countdown, never restart it.
    if (this.alone) this.show();
    else if (!this.hideTimer && !this.view.classList.contains('controls-hidden')) this.scheduleHide();
  }

  close(): void {
    clearTimeout(this.hideTimer);
    this.cleanups.forEach((fn) => fn());
    this.view.classList.remove('controls-hidden');
  }

  private get alone(): boolean {
    return this.grid.all().length < 2;
  }

  private update(): void {
    if (!this.active) {
      clearTimeout(this.hideTimer);
      this.hideTimer = 0;
      this.view.classList.remove('controls-hidden');
      $('more-menu').hidden = true;
    } else this.refresh();
  }

  private listen<K extends string>(target: EventTarget, type: K, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanups.push(() => target.removeEventListener(type, fn));
  }

  private show(): void {
    this.view.classList.remove('controls-hidden');
    this.scheduleHide();
  }

  private toggleControls(): void {
    if (!this.active) return;
    if (this.view.classList.contains('controls-hidden')) this.show();
    else if (!this.busy && !this.alone) {
      clearTimeout(this.hideTimer);
      this.hideTimer = 0;
      this.view.classList.add('controls-hidden');
    }
  }

  /** Something needs the bar (or sits on it): an open dialog, chat, picker or menu. */
  private get busy(): boolean {
    return (
      !!document.querySelector('dialog[open]') ||
      !$('chat').hidden ||
      !$('reaction-picker').hidden ||
      !$('tile-menu').hidden ||
      !$('more-menu').hidden ||
      !!document.activeElement?.closest('.chat, dialog')
    );
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = 0;
    if (!this.active || this.alone) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = 0;
      if (this.busy) return this.scheduleHide();
      this.view.classList.add('controls-hidden');
    }, HIDE_AFTER_MS);
  }

  /** "More": the buttons hidden from the bar on a phone, plus phone-only actions. */
  private toggleMore(): void {
    const menu = $('more-menu');
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const item = (label: string, run: () => void, cls = '') => {
      const b = h('button', { text: label, class: cls });
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        menu.hidden = true;
        run();
      };
      return b;
    };
    const fromBar = [...this.view.querySelectorAll<HTMLButtonElement>('.controls .buttons .secondary')]
      .filter((b) => !b.hidden)
      .map((b) => item(stripShortcut(b.title), () => b.click(), b.classList.contains('active') ? 'checked' : ''));
    menu.replaceChildren(...this.extraItems().map((x) => item(x.label, x.run)), ...fromBar, item(t('ctl.invite'), () => $('btn-invite').click()));
    menu.hidden = false;
    const r = $('btn-more').getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
  }

  /** Our own floating camera: drag it to another corner (a short tap still swaps). */
  private makeDraggable(el: HTMLElement): void {
    let start: { x: number; y: number; id: number } | null = null;
    let dragging = false;
    const floating = () => this.active && !this.alone && !el.classList.contains('pinned');
    const down = (e: PointerEvent) => {
      if (!floating()) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging = false;
      // Keep getting the moves when a quick finger leaves the small window right away.
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < 10) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('dragging');
      }
      el.style.translate = `${dx}px ${dy}px`;
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (!dragging) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      this.corner = `${cy < window.innerHeight / 2 ? 't' : 'b'}${cx < window.innerWidth / 2 ? 'l' : 'r'}` as Corner;
      try {
        localStorage.setItem(CORNER_KEY, this.corner);
      } catch {
        /* no storage */
      }
      el.classList.remove('dragging');
      el.style.translate = '';
      this.refresh();
      // The click that ends a drag is not a tap.
      const swallow = (ev: Event) => ev.stopImmediatePropagation();
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 400);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}

/** "Podnieś rękę (H)" → "Podnieś rękę": no keyboard on a phone. */
const stripShortcut = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, '');
