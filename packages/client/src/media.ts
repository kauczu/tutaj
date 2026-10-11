import { Emitter } from './emitter';

type MediaEvents = {
  /** Outgoing audio or video track changed (device switch, camera toggle, screen share). */
  change: void;
};

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

const withDevice = (base: MediaTrackConstraints, deviceId?: string): MediaTrackConstraints =>
  deviceId ? { ...base, deviceId: { exact: deviceId } } : base;

export function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Brak zgody na dostęp do kamery/mikrofonu';
    case 'NotFoundError':
      return 'Nie znaleziono urządzenia';
    case 'NotReadableError':
      return 'Urządzenie jest zajęte przez inną aplikację';
    case 'OverconstrainedError':
      return 'Wybrane urządzenie jest niedostępne';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/** Owns local capture: microphone, camera and screen share. */
export class LocalMedia extends Emitter<MediaEvents> {
  audioTrack: MediaStreamTrack | null = null;
  cameraTrack: MediaStreamTrack | null = null;
  screenTrack: MediaStreamTrack | null = null;
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  /** Mic mute is done via track.enabled so unmuting is instant. */
  audioEnabled = true;

  get outgoingAudio(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  get outgoingVideo(): MediaStreamTrack | null {
    return this.screenTrack ?? this.cameraTrack;
  }

  get cameraOn(): boolean {
    return !!this.cameraTrack;
  }

  get sharingScreen(): boolean {
    return !!this.screenTrack;
  }

  /** Stream for the local preview tile. */
  previewStream(): MediaStream {
    return new MediaStream([this.outgoingVideo, this.audioTrack].filter((t): t is MediaStreamTrack => !!t));
  }

  /** Acquires mic and camera, degrading gracefully. Returns human-readable problems, if any. */
  async start(wantAudio = true, wantVideo = true): Promise<string[]> {
    const problems: string[] = [];
    if (!navigator.mediaDevices?.getUserMedia) {
      return ['Przeglądarka nie udostępnia kamery/mikrofonu (wymagane HTTPS lub localhost)'];
    }
    if (wantAudio) {
      try {
        await this.setMicrophone(this.audioDeviceId);
      } catch (e) {
        problems.push(`Mikrofon: ${describeMediaError(e)}`);
      }
    }
    if (wantVideo) {
      try {
        await this.setCamera(true);
      } catch (e) {
        problems.push(`Kamera: ${describeMediaError(e)}`);
      }
    }
    return problems;
  }

  async setMicrophone(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: withDevice(AUDIO, deviceId) });
    const track = stream.getAudioTracks()[0];
    this.audioTrack?.stop();
    track.enabled = this.audioEnabled;
    this.audioTrack = track;
    this.audioDeviceId = track.getSettings().deviceId ?? deviceId;
    this.emit('change', undefined);
  }

  setAudioEnabled(on: boolean): void {
    this.audioEnabled = on;
    if (this.audioTrack) this.audioTrack.enabled = on;
  }

  /** Turning the camera off releases the device (camera light goes off) instead of sending black frames. */
  async setCamera(on: boolean, deviceId = this.videoDeviceId): Promise<void> {
    if (!on) {
      this.cameraTrack?.stop();
      this.cameraTrack = null;
      this.emit('change', undefined);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: withDevice(VIDEO, deviceId) });
    const track = stream.getVideoTracks()[0];
    this.cameraTrack?.stop();
    this.cameraTrack = track;
    this.videoDeviceId = track.getSettings().deviceId ?? deviceId;
    this.emit('change', undefined);
  }

  async startScreen(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => this.stopScreen());
    this.screenTrack = track;
    this.emit('change', undefined);
  }

  stopScreen(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.emit('change', undefined);
  }

  stop(): void {
    for (const t of [this.audioTrack, this.cameraTrack, this.screenTrack]) t?.stop();
    this.audioTrack = this.cameraTrack = this.screenTrack = null;
  }

  static async devices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId);
  }
}
