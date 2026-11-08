/**
 * Screen share with sound: the shared sound is mixed with the microphone into one audio track,
 * so it goes out over the call's existing audio channel — nothing about the connections (P2P, SFU,
 * end-to-end encryption) changes, and everyone hears it whatever app version they have.
 * Muting the microphone mutes only the voice (a disabled mic track feeds silence); the shared sound
 * goes on until the screen share stops.
 */
export class ScreenAudioMix {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly out = this.ctx.createMediaStreamDestination();
  private readonly screen: MediaStreamAudioSourceNode;
  private mic: MediaStreamAudioSourceNode | null = null;
  /** What goes out instead of the bare microphone while the screen is shared with sound. */
  readonly track: MediaStreamTrack;

  constructor(
    mic: MediaStreamTrack | null,
    private readonly screenTrack: MediaStreamTrack,
  ) {
    this.screen = this.ctx.createMediaStreamSource(new MediaStream([screenTrack]));
    this.screen.connect(this.out);
    this.setMic(mic);
    this.track = this.out.stream.getAudioTracks()[0];
    void this.ctx.resume().catch(() => {});
  }

  /** The microphone changed (another device, studio audio re-opened it…). */
  setMic(mic: MediaStreamTrack | null): void {
    this.mic?.disconnect();
    this.mic = mic ? this.ctx.createMediaStreamSource(new MediaStream([mic])) : null;
    this.mic?.connect(this.out);
  }

  stop(): void {
    this.mic?.disconnect();
    this.screen.disconnect();
    this.track.stop();
    this.screenTrack.stop();
    void this.ctx.close().catch(() => {});
  }
}
