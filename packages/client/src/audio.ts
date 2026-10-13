interface Watched {
  trackId: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array;
  speaking: boolean;
  lastLoud: number;
}

let cueCtx: AudioContext | null = null;

/** Short tone confirming a mute toggle done by a global shortcut (the call window is hidden behind the game). */
export function playCue(on: boolean): void {
  try {
    cueCtx ??= new AudioContext();
    const ctx = cueCtx;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    // Rising for "on", falling for "muted".
    const [a, b] = on ? [520, 780] : [780, 520];
    for (const [freq, start] of [
      [a, 0],
      [b, 0.09],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t + start);
      osc.stop(t + start + 0.12);
    }
  } catch {
    /* no audio output */
  }
}

const THRESHOLD = 0.035;
const HOLD_MS = 450;

/** Detects who is speaking (RMS of each audio track) for the tile highlight and the level meter. */
export class SpeakingDetector {
  private ctx = new AudioContext();
  private watched = new Map<string, Watched>();
  private timer: number;

  constructor(private readonly onChange: (id: string, speaking: boolean, level: number) => void) {
    this.timer = window.setInterval(() => this.poll(), 120);
  }

  watch(id: string, track: MediaStreamTrack | null | undefined): void {
    const existing = this.watched.get(id);
    if (existing?.trackId === track?.id) return;
    this.unwatch(id);
    if (!track || track.readyState !== 'live') return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.watched.set(id, { trackId: track.id, source, analyser, data: new Uint8Array(analyser.fftSize), speaking: false, lastLoud: 0 });
  }

  unwatch(id: string): void {
    const w = this.watched.get(id);
    if (!w) return;
    w.source.disconnect();
    this.watched.delete(id);
    if (w.speaking) this.onChange(id, false, 0);
  }

  destroy(): void {
    clearInterval(this.timer);
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    void this.ctx.close();
  }

  private poll(): void {
    const now = performance.now();
    for (const [id, w] of this.watched) {
      w.analyser.getByteTimeDomainData(w.data);
      let sum = 0;
      for (const v of w.data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / w.data.length);
      if (rms > THRESHOLD) w.lastLoud = now;
      const speaking = now - w.lastLoud < HOLD_MS;
      w.speaking = speaking;
      this.onChange(id, speaking, rms);
    }
  }
}
