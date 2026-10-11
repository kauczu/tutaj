export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  el.append(...children);
  return el;
}

/** Renders text with http(s) URLs turned into links — never via innerHTML. */
export function linkify(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    const a = h('a', { text: m[0] });
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = (m.index ?? 0) + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

export function fillDeviceSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], current: string | undefined, fallback: string): void {
  select.replaceChildren(
    ...devices.map((d, i) => {
      const opt = h('option', { text: d.label || `${fallback} ${i + 1}` });
      opt.value = d.deviceId;
      opt.selected = d.deviceId === current;
      return opt;
    }),
  );
  select.disabled = devices.length === 0;
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
