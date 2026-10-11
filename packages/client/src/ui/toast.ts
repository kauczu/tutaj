import { $, h } from './dom';

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
  const el = h('div', { class: `toast ${kind}`, text: message });
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, ms);
}
