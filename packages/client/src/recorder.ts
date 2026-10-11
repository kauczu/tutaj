export interface RecordingSource {
  video: HTMLVideoElement;
  label: string;
  showVideo: boolean;
}

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const W = 1280;
const H = 720;

/**
 * Local call recording: composites all tiles onto a canvas and mixes every audio track.
 * Nothing leaves the machine; the result is offered as a download.
 */
export class CallRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer = 0;
  private audioCtx: AudioContext | null = null;
  private mixed = new Set<string>();

  constructor(
    private readonly sources: () => RecordingSource[],
    private readonly audioTracks: () => MediaStreamTrack[],
  ) {}

  get active(): boolean {
    return !!this.recorder;
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  start(): void {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();

    const tick = () => {
      this.draw(ctx);
      for (const track of this.audioTracks()) {
        if (this.mixed.has(track.id) || track.readyState !== 'live') continue;
        this.mixed.add(track.id);
        this.audioCtx!.createMediaStreamSource(new MediaStream([track])).connect(dest);
      }
    };
    tick();
    // setInterval keeps drawing when the tab is in the background (rAF would pause).
    this.timer = window.setInterval(tick, 1000 / 30);

    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(1000);
  }

  stop(): Promise<Blob> {
    const rec = this.recorder;
    this.recorder = null;
    clearInterval(this.timer);
    return new Promise((resolve) => {
      const finish = () => {
        void this.audioCtx?.close();
        this.audioCtx = null;
        this.mixed.clear();
        resolve(new Blob(this.chunks, { type: rec?.mimeType || 'video/webm' }));
      };
      if (!rec || rec.state === 'inactive') return finish();
      rec.onstop = finish;
      rec.stop();
    });
  }

  private draw(ctx: CanvasRenderingContext2D): void {
    const sources = this.sources();
    ctx.fillStyle = '#02060c';
    ctx.fillRect(0, 0, W, H);
    const n = Math.max(1, sources.length);
    const cols = n === 1 ? 1 : 2;
    const rows = Math.ceil(n / cols);
    const cw = W / cols;
    const ch = H / rows;
    sources.forEach((s, i) => {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      const v = s.video;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y + 2, cw - 4, ch - 4);
      ctx.clip();
      ctx.fillStyle = '#0a1730';
      ctx.fillRect(x, y, cw, ch);
      if (s.showVideo && v.videoWidth) {
        // object-fit: contain
        const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
        const dw = v.videoWidth * scale;
        const dh = v.videoHeight * scale;
        ctx.drawImage(v, x + (cw - dw) / 2, y + (ch - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = '#6c9eca';
        ctx.beginPath();
        ctx.arc(x + cw / 2, y + ch / 2, Math.min(cw, ch) / 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a1a33';
        ctx.font = `600 ${Math.round(Math.min(cw, ch) / 7)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((s.label[0] ?? '?').toUpperCase(), x + cw / 2, y + ch / 2);
      }
      ctx.font = '500 20px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      const tw = ctx.measureText(s.label).width;
      ctx.fillRect(x + 10, y + ch - 42, tw + 20, 32);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.label, x + 20, y + ch - 16);
      ctx.restore();
    });
  }
}
