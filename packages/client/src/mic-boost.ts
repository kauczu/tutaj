/**
 * Studio audio has no automatic gain control (it would pump music and game sound), so a plain
 * microphone comes out much quieter than in voice mode. This raises it by a fixed amount the person
 * chooses, with a limiter so loud moments never clip. Stereo is kept.
 * Muting the microphone still works (a disabled mic track feeds silence).
 */
export class MicBoost {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly gain = this.ctx.createGain();
  private readonly limiter = this.ctx.createDynamicsCompressor();
  private readonly out = this.ctx.createMediaStreamDestination();
  private source: MediaStreamAudioSourceNode | null = null;
  private mic: MediaStreamTrack | null = null;
  /** What goes out instead of the bare microphone. */
  readonly track: MediaStreamTrack;

  /**
   * Whether the boosted sound really flows. A browser may hold the audio engine until the page is
   * clicked; until then the bare microphone goes out (never silence). `onReady` runs when it starts.
   */
  get ready(): boolean {
    return this.ctx.state === 'running';
  }

  constructor(mic: MediaStreamTrack, db: number, onReady: () => void) {
    // A limiter, not a compressor: below -1.5 dBFS nothing is touched.
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.out.channelCount = 2;
    this.gain.connect(this.limiter).connect(this.out);
    this.setGain(db);
    this.setMic(mic);
    this.track = this.out.stream.getAudioTracks()[0];
    if (this.ctx.state !== 'running') {
      this.ctx.onstatechange = () => {
        if (this.ctx.state !== 'running') return;
        this.ctx.onstatechange = null;
        onReady();
      };
      const resume = () => void this.ctx.resume().catch(() => {});
      for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, resume, { once: true, capture: true });
      resume();
    }
  }

  setMic(mic: MediaStreamTrack): void {
    if (mic === this.mic) return;
    this.source?.disconnect();
    this.mic = mic;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([mic]));
    this.source.connect(this.gain);
  }

  setGain(db: number): void {
    this.gain.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.05);
  }

  /** Stops only what this made — the microphone itself stays open. */
  stop(): void {
    this.ctx.onstatechange = null;
    this.source?.disconnect();
    this.track.stop();
    void this.ctx.close().catch(() => {});
  }
}
