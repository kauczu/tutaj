import { Emitter } from './emitter';
import { AUDIO_BITRATE, loadQuality, micChanged, saveQuality, type QualitySettings } from './quality';
import { t } from './i18n';

type MediaEvents = {
  /** Outgoing audio or video track changed (device switch, camera toggle, screen share). */
  change: void;
};

/**
 * Voice: browser processing on. Studio: raw stereo signal — for headphones; with `echoCancel` the
 * browser removes the call's own sound coming back from speakers, nothing else (still stereo).
 */
function audioConstraints(q: QualitySettings): MediaTrackConstraints {
  return q.audio === 'studio'
    ? {
        echoCancellation: q.echoCancel,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
      }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

function videoConstraints(q: QualitySettings): MediaTrackConstraints {
  return q.resolution === 1080
    ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
}

const withDevice = (base: MediaTrackConstraints, deviceId?: string): MediaTrackConstraints =>
  deviceId ? { ...base, deviceId: { exact: deviceId } } : base;

export function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return t('media.denied');
    case 'NotFoundError':
      return t('media.notFound');
    case 'NotReadableError':
      return t('media.busy');
    case 'OverconstrainedError':
      return t('media.unavailable');
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
  quality: QualitySettings = loadQuality();

  get audioBitrate(): number {
    return AUDIO_BITRATE[this.quality.audio];
  }

  /** Applies new quality settings, re-opening the mic/camera when their capture settings change. */
  async setQuality(q: QualitySettings): Promise<void> {
    const prev = this.quality;
    this.quality = q;
    saveQuality(q);
    if (this.audioTrack && micChanged(prev, q)) await this.setMicrophone(this.audioDeviceId);
    if (this.cameraTrack && prev.resolution !== q.resolution) await this.setCamera(true);
    this.emit('change', undefined);
  }

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
      return [t('media.noApi')];
    }
    if (wantAudio) {
      try {
        await this.setMicrophone(this.audioDeviceId);
      } catch (e) {
        problems.push(t('media.micProblem', { error: describeMediaError(e) }));
      }
    }
    if (wantVideo) {
      try {
        await this.setCamera(true);
      } catch (e) {
        problems.push(t('media.cameraProblem', { error: describeMediaError(e) }));
      }
    }
    return problems;
  }

  async setMicrophone(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: withDevice(audioConstraints(this.quality), deviceId) });
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
    const stream = await navigator.mediaDevices.getUserMedia({ video: withDevice(videoConstraints(this.quality), deviceId) });
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
