import { formatBytes } from '../files';
import { $, h, linkify } from './dom';
import { setIcon } from './icons';

export interface TransferHandle {
  progress(done: number): void;
  complete(blob?: Blob): void;
  fail(reason: string): void;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class ChatPanel {
  private readonly panel = $('chat');
  private readonly list = $<HTMLOListElement>('chat-list');
  private readonly badge = $('chat-badge');
  private unread = 0;

  constructor(
    onSend: (text: string) => void,
    onFiles: (files: File[]) => void,
    private readonly onToggle: (open: boolean) => void,
  ) {
    const form = $<HTMLFormElement>('chat-form');
    const input = $<HTMLInputElement>('chat-input');
    const fileInput = $<HTMLInputElement>('chat-file-input');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      onSend(text);
      input.value = '';
    });
    setIcon($('chat-file'), 'file');
    $('chat-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) onFiles([...fileInput.files]);
      fileInput.value = '';
    });
    $('chat-close').addEventListener('click', () => this.toggle(false));

    // Drag & drop files anywhere onto the room.
    const room = $('room-view');
    room.addEventListener('dragover', (e) => e.preventDefault());
    room.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) {
        this.toggle(true);
        onFiles(files);
      }
    });
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  toggle(open = !this.open): void {
    this.panel.hidden = !open;
    if (open) {
      this.unread = 0;
      this.badge.hidden = true;
      $<HTMLInputElement>('chat-input').focus();
    }
    this.onToggle(open);
  }

  addMessage(from: string, text: string, ts: number, self: boolean): void {
    this.push(
      h(
        'li',
        { class: self ? 'self' : '' },
        h('div', { class: 'meta' }, h('strong', { text: from }), ` · ${time(ts)}`),
        h('div', { class: 'text' }, linkify(text)),
      ),
      self,
    );
  }

  addSystem(text: string): void {
    this.push(h('li', { class: 'system', text }), true);
  }

  addTransfer(from: string, name: string, size: number, self: boolean): TransferHandle {
    const bar = h('progress');
    bar.max = size || 1;
    bar.value = 0;
    const status = h('span', { class: 'file-status', text: formatBytes(size) });
    const title = h('span', { class: 'file-name', text: name });
    this.push(
      h(
        'li',
        { class: `file ${self ? 'self' : ''}` },
        h('div', { class: 'meta' }, h('strong', { text: from }), self ? ' · wysyłanie' : ' · plik'),
        h('div', { class: 'file-row' }, title, status),
        bar,
      ),
      self,
    );
    return {
      progress: (done) => {
        bar.value = done;
        status.textContent = `${formatBytes(done)} / ${formatBytes(size)}`;
      },
      complete: (blob) => {
        bar.remove();
        status.textContent = formatBytes(size);
        if (blob) {
          const a = h('a', { class: 'file-name', text: name });
          a.href = URL.createObjectURL(blob);
          a.download = name;
          title.replaceWith(a);
        } else {
          status.textContent += ' · wysłano';
        }
      },
      fail: (reason) => {
        bar.remove();
        status.textContent = `błąd: ${reason}`;
        status.classList.add('error');
      },
    };
  }

  private push(li: HTMLLIElement, self: boolean): void {
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    this.list.append(li);
    if (nearBottom || self) this.list.scrollTop = this.list.scrollHeight;
    if (!this.open && !self) {
      this.unread++;
      this.badge.textContent = String(this.unread);
      this.badge.hidden = false;
    }
  }
}
