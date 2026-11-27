import { Emitter } from './emitter';
import { AUDIO_BITRATE, loadQuality, micChanged, saveQuality, type QualitySettings } from './quality';
import { t } from './i18n';
import { ScreenAudioMix } from './screen-audio';
import { MicBoost } from './mic-boost';
import { ScreenCamera, loadScreenCamera, saveScreenCamera, screenCameraSupported, type ScreenCameraSetting } from './screen-camera';

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
  /** Screen shared with sound: its sound mixed with the microphone (see ScreenAudioMix). */
  private screenMix: ScreenAudioMix | null = null;
  /** Studio audio: the microphone made louder (see MicBoost). */
  private micBoost: MicBoost | null = null;
  /** Screen share with the camera drawn into a corner (see ScreenCamera). */
  private screenCam: ScreenCamera | null = null;
  /** Where the camera goes on a shared screen, or 'off'. */
  screenCamera: ScreenCameraSetting = loadScreenCamera();
  audioDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  /** Which way the camera looks, when the device says (phones): the back camera is not mirrored. */
  get facing(): 'user' | 'environment' | undefined {
    const f = this.cameraTrack?.getSettings().facingMode;
    return f === 'user' || f === 'environment' ? f : undefined;
  }
  /** Mic mute is done via track.enabled so unmuting is instant. */
  audioEnabled = true;
  quality: QualitySettings = loadQuality();

  get audioBitrate(): number {
    // Game or film sound needs more than a voice does.
    return this.screenMix ? Math.max(AUDIO_BITRATE[this.quality.audio], 128_000) : AUDIO_BITRATE[this.quality.audio];
  }

  /** The screen is being shared together with its sound. */
  get sharingScreenAudio(): boolean {
    return !!this.screenMix;
  }

  /** Applies new quality settings, re-opening the mic/camera when their capture settings change. */
  async setQuality(q: QualitySettings): Promise<void> {
    const prev = this.quality;
    this.quality = q;
    saveQuality(q);
    if (this.audioTrack && micChanged(prev, q)) await this.setMicrophone(this.audioDeviceId);
    else this.syncMicBoost();
    if (this.cameraTrack && prev.resolution !== q.resolution) await this.setCamera(true);
    this.emit('change', undefined);
  }

  get outgoingAudio(): MediaStreamTrack | null {
    return this.screenMix?.track ?? this.sentMic;
  }

  /** The microphone as it goes out: boosted in studio mode, bare otherwise. */
  private get sentMic(): MediaStreamTrack | null {
    return this.micBoost?.ready ? this.micBoost.track : this.audioTrack;
  }

  /** Starts, updates or ends the studio microphone boost to match the settings. */
  private syncMicBoost(): void {
    const mic = this.audioTrack;
    const db = this.quality.audio === 'studio' ? this.quality.micBoost : 0;
    if (mic && db > 0) {
      if (this.micBoost) {
        this.micBoost.setMic(mic);
        this.micBoost.setGain(db);
      } else {
        const boost = new MicBoost(mic, db, () => {
          if (this.micBoost !== boost) return;
          this.screenMix?.setMic(boost.track);
          this.emit('change', undefined);
        });
        this.micBoost = boost;
        this.screenMix?.setMic(this.sentMic);
      }
      return;
    }
    if (this.micBoost) {
      this.screenMix?.setMic(mic);
      this.micBoost.stop();
      this.micBoost = null;
    }
  }

  get outgoingVideo(): MediaStreamTrack | null {
    return this.screenCam?.track ?? this.screenTrack ?? this.cameraTrack;
  }

  /** Starts, updates or ends drawing the camera into the shared screen to match what is on. */
  private syncScreenCamera(): void {
    const want = !!this.screenTrack && !!this.cameraTrack && this.screenCamera !== 'off' && screenCameraSupported();
    if (want && this.screenCamera !== 'off') {
      if (this.screenCam) {
        this.screenCam.setCamera(this.cameraTrack!);
        this.screenCam.setCorner(this.screenCamera);
      } else {
        try {
          this.screenCam = new ScreenCamera(this.screenTrack!, this.cameraTrack!, this.screenCamera);
        } catch {
          this.screenCam = null; // the screen goes out alone, as before
        }
      }
      return;
    }
    this.screenCam?.stop();
    this.screenCam = null;
  }

  /** Where the camera goes on a shared screen (remembered); applies right away. */
  setScreenCamera(v: ScreenCameraSetting): void {
    this.screenCamera = v;
    saveScreenCamera(v);
    const before = this.outgoingVideo;
    this.syncScreenCamera();
    if (this.outgoingVideo !== before) this.emit('change', undefined);
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
    this.syncMicBoost();
    this.screenMix?.setMic(this.sentMic);
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
      this.syncScreenCamera();
      this.emit('change', undefined);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: withDevice(videoConstraints(this.quality), deviceId) });
    const track = stream.getVideoTracks()[0];
    this.cameraTrack?.stop();
    this.cameraTrack = track;
    this.videoDeviceId = track.getSettings().deviceId ?? deviceId;
    this.syncScreenCamera();
    this.emit('change', undefined);
  }

  /** Phones: switches between the front and the back camera. */
  async flipCamera(): Promise<void> {
    const facingMode = this.facing === 'environment' ? 'user' : 'environment';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...videoConstraints(this.quality), facingMode: { exact: facingMode } } });
    const track = stream.getVideoTracks()[0];
    this.cameraTrack?.stop();
    this.cameraTrack = track;
    this.videoDeviceId = track.getSettings().deviceId;
    this.syncScreenCamera();
    this.emit('change', undefined);
  }

  async startScreen(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      // Sound only if the person ticks it in the picker. Never the call itself (others would hear
      // themselves), and untouched: no voice processing on music or game sound.
      audio: { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => this.stopScreen());
    this.screenTrack = track;
    const sound = stream.getAudioTracks()[0];
    if (sound) this.screenMix = new ScreenAudioMix(this.sentMic, sound);
    this.syncScreenCamera();
    this.emit('change', undefined);
  }

  stopScreen(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.screenMix?.stop();
    this.screenMix = null;
    this.syncScreenCamera();
    this.emit('change', undefined);
  }

  stop(): void {
    this.screenMix?.stop();
    this.screenMix = null;
    this.screenCam?.stop();
    this.screenCam = null;
    this.micBoost?.stop();
    this.micBoost = null;
    for (const t of [this.audioTrack, this.cameraTrack, this.screenTrack]) t?.stop();
    this.audioTrack = this.cameraTrack = this.screenTrack = null;
  }

  static async devices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId);
  }
}
