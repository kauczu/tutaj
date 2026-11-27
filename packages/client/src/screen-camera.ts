/**
 * Screen share with the camera in a corner: the camera is drawn into the shared picture, so the
 * others see the person next to what they share. It is still one video track — nothing about the
 * connections (P2P, SFU, end-to-end encryption) changes, and everyone sees it whatever app version
 * they have. The drawing runs in a worker, so it keeps going while the window is in the background
 * (a game in front). Needs Chrome/Edge/the desktop app; elsewhere the screen goes out alone, as before.
 */

export type CameraCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type ScreenCameraSetting = CameraCorner | 'off';

const KEY = 'tutaj:screen-camera';
const SETTINGS: ScreenCameraSetting[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'off'];

export function loadScreenCamera(): ScreenCameraSetting {
  try {
    const v = localStorage.getItem(KEY) as ScreenCameraSetting | null;
    if (v && SETTINGS.includes(v)) return v;
  } catch {
    /* defaults */
  }
  return 'bottom-right';
}

export function saveScreenCamera(v: ScreenCameraSetting): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode */
  }
}

type Processor = { readable: ReadableStream<VideoFrame> };
type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type BreakoutBox = {
  MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => Processor;
  MediaStreamTrackGenerator: new (init: { kind: 'video' }) => Generator;
};
const box = globalThis as unknown as Partial<BreakoutBox>;

/** Whether this browser can draw the camera into the shared screen. */
export const screenCameraSupported = (): boolean =>
  typeof box.MediaStreamTrackProcessor === 'function' && typeof box.MediaStreamTrackGenerator === 'function' && typeof Worker === 'function';

export class ScreenCamera {
  private readonly worker = new Worker(new URL('./screen-camera-worker.ts', import.meta.url), { type: 'module', name: 'tutaj-screen-camera' });
  private readonly generator: Generator;
  /** Our own copies, so stopping here never stops the real screen or camera. */
  private readonly screen: MediaStreamTrack;
  private camera: MediaStreamTrack | null = null;
  private cameraSource: MediaStreamTrack | null = null;
  /** What goes out instead of the bare screen. */
  readonly track: MediaStreamTrack;

  constructor(screen: MediaStreamTrack, camera: MediaStreamTrack, corner: CameraCorner) {
    const { MediaStreamTrackProcessor, MediaStreamTrackGenerator } = box as BreakoutBox;
    this.screen = screen.clone();
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.generator.contentHint = 'detail';
    this.track = this.generator;
    const readable = new MediaStreamTrackProcessor({ track: this.screen }).readable;
    const writable = this.generator.writable;
    this.worker.postMessage({ type: 'start', screen: readable, out: writable, corner }, [readable, writable] as unknown as Transferable[]);
    this.setCamera(camera);
  }

  /** Another camera (device switch, front/back on a phone). */
  setCamera(camera: MediaStreamTrack): void {
    if (camera === this.cameraSource) return;
    this.camera?.stop();
    this.cameraSource = camera;
    this.camera = camera.clone();
    const { MediaStreamTrackProcessor } = box as BreakoutBox;
    const readable = new MediaStreamTrackProcessor({ track: this.camera }).readable;
    this.worker.postMessage({ type: 'camera', camera: readable }, [readable] as unknown as Transferable[]);
  }

  setCorner(corner: CameraCorner): void {
    this.worker.postMessage({ type: 'corner', corner });
  }

  stop(): void {
    this.worker.terminate();
    this.screen.stop();
    this.camera?.stop();
    this.generator.stop();
  }
}
