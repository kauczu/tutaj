import { $ } from './dom';
import { setIcon, type IconName } from './icons';

const STORE_KEY = 'tutaj:settings-tab';

/**
 * Topics of the settings dialog: a menu on the left, one topic's options on the right.
 * The last topic you looked at opens next time.
 */
class SettingsTabs {
  private ready = false;

  private get tabs(): HTMLButtonElement[] {
    return [...$('settings').querySelectorAll<HTMLButtonElement>('.settings-tab')];
  }

  private init(): void {
    if (this.ready) return;
    this.ready = true;
    for (const tab of this.tabs) {
      setIcon(tab, tab.dataset.icon as IconName);
      tab.addEventListener('click', () => this.show(tab.dataset.tab!));
    }
    // Arrow keys move between topics (tab pattern), Home/End to the first/last.
    $('settings')
      .querySelector('.settings-nav')!
      .addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        const visible = this.tabs.filter((t) => !t.hidden);
        const i = visible.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        const next =
          ev.key === 'ArrowDown' || ev.key === 'ArrowRight'
            ? visible[(i + 1) % visible.length]
            : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft'
              ? visible[(i - 1 + visible.length) % visible.length]
              : ev.key === 'Home'
                ? visible[0]
                : ev.key === 'End'
                  ? visible[visible.length - 1]
                  : null;
        if (!next) return;
        ev.preventDefault();
        this.show(next.dataset.tab!);
        next.focus();
      });
  }

  /** Opens the remembered topic (or the first one available). */
  select(): void {
    this.init();
    let saved = '';
    try {
      saved = localStorage.getItem(STORE_KEY) ?? '';
    } catch {
      /* no storage */
    }
    this.show(saved, false);
  }

  /** Some topics exist only sometimes (the overlay: desktop app only). */
  setAvailable(name: string, available: boolean): void {
    const tab = this.tabs.find((t) => t.dataset.tab === name);
    if (!tab || tab.hidden === !available) return;
    tab.hidden = !available;
    if (!available && tab.getAttribute('aria-selected') === 'true') this.show('', false);
  }

  show(name: string, remember = true): void {
    const visible = this.tabs.filter((t) => !t.hidden);
    const active = visible.find((t) => t.dataset.tab === name) ?? visible[0];
    for (const tab of this.tabs) {
      const on = tab === active;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${tab.dataset.tab}`).hidden = !on;
    }
    if (remember && active) {
      try {
        localStorage.setItem(STORE_KEY, active.dataset.tab!);
      } catch {
        /* no storage */
      }
    }
  }
}

export const settingsTabs = new SettingsTabs();
