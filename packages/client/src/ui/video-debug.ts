import { h } from './dom';
import type { Grid } from './grid';

/**
 * Diagnostics for video layout on devices we cannot debug directly (iOS): `?debug=1` in the address
 * shows, per tile, the video element's box, the picture size and the fit, plus buttons that each
 * try one way of making the browser lay the picture out again.
 */
export function videoDebug(grid: Grid): (() => void) | null {
  if (!new URLSearchParams(location.search).has('debug')) return null;
  const panel = h('div', { class: 'video-debug' });
  const out = h('pre');
  const videos = () => grid.all().map((t) => ({ name: t.state.name, local: t.local, v: t.el.querySelector('video')! }));
  const log: string[] = [];
  const note = (s: string) => {
    log.unshift(`${new Date().toLocaleTimeString()} ${s}`);
    log.length = Math.min(log.length, 8);
  };
  const onNote = (e: Event) => note((e as CustomEvent<string>).detail);
  window.addEventListener('tutaj:debug', onNote);
  const button = (label: string, fn: (v: HTMLVideoElement) => void) => {
    const b = h('button', { text: label });
    b.type = 'button';
    b.onclick = (e) => {
      e.stopPropagation();
      for (const { v } of videos()) fn(v);
      note(label);
    };
    return b;
  };
  const frames = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));
  panel.append(
    out,
    h(
      'div',
      { class: 'video-debug-buttons' },
      button('1 strumień', (v) => {
        const s = v.srcObject;
        v.srcObject = null;
        v.srcObject = s;
        void v.play().catch(() => {});
      }),
      button('2 rozmiar', (v) => {
        v.style.width = '50%';
        frames(() => (v.style.width = ''));
      }),
      button('3 ukryj', (v) => {
        v.style.display = 'none';
        frames(() => (v.style.display = ''));
      }),
      button('4 play', (v) => {
        v.pause();
        void v.play().catch(() => {});
      }),
      button('5 za 3 s', (v) => {
        setTimeout(() => {
          const s = v.srcObject;
          v.srcObject = null;
          v.srcObject = s;
          void v.play().catch(() => {});
          note('5 wykonane');
        }, 3000);
      }),
    ),
  );
  document.body.append(panel);
  const tick = () => {
    const lines = videos().map(({ name, local, v }) => {
      const r = v.getBoundingClientRect();
      const cs = getComputedStyle(v);
      return `${local ? '*' : ' '}${name.slice(0, 8)} box ${Math.round(r.width)}x${Math.round(r.height)} pic ${v.videoWidth}x${v.videoHeight} fit ${cs.objectFit} pos ${cs.position} ${v.paused ? 'paused' : 'play'} rs${v.readyState}`;
    });
    out.textContent = `okno ${innerWidth}x${innerHeight} vv ${Math.round(visualViewport?.width ?? 0)}x${Math.round(visualViewport?.height ?? 0)}@${visualViewport?.scale ?? 1}\n${lines.join('\n')}\n${log.join('\n')}`;
  };
  const timer = window.setInterval(tick, 500);
  tick();
  return () => {
    window.removeEventListener('tutaj:debug', onNote);
    clearInterval(timer);
    panel.remove();
  };
}
