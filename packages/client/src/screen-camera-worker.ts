/// <reference lib="webworker" />
// Draws the camera into a corner of the shared screen (see screen-camera.ts). Runs in a worker so
// the background-tab timer throttling never freezes it.

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
type In =
  | { type: 'start'; screen: ReadableStream<VideoFrame>; out: WritableStream<VideoFrame>; corner: Corner }
  | { type: 'camera'; camera: ReadableStream<VideoFrame> }
  | { type: 'corner'; corner: Corner };

/** At most this many pictures a second: the camera stays smooth, the encoder is not overloaded. */
const MAX_FPS = 24;
/** Camera picture height, as a part of the screen's height. */
const CAMERA_HEIGHT = 0.24;

let canvas: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let corner: Corner = 'bottom-right';
let screenFrame: VideoFrame | null = null;
let cameraFrame: VideoFrame | null = null;
let cameraReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let lastEmit = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;
let stopped = false;

async function pump(reader: ReadableStreamDefaultReader<VideoFrame>, isCamera: boolean): Promise<void> {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || stopped) {
        value?.close();
        break;
      }
      if (isCamera) {
        if (reader !== cameraReader) {
          value.close();
          break;
        }
        cameraFrame?.close();
        cameraFrame = value;
      } else {
        screenFrame?.close();
        screenFrame = value;
      }
      schedule();
    }
  } catch {
    /* the track ended */
  }
}

function schedule(): void {
  if (timer !== null || stopped) return;
  const wait = Math.max(0, lastEmit + 1000 / MAX_FPS - performance.now());
  timer = setTimeout(() => {
    timer = null;
    emit();
  }, wait);
}

function emit(): void {
  if (!screenFrame || !writer || !g || !canvas || writing) return;
  const w = screenFrame.displayWidth;
  const h = screenFrame.displayHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  g.drawImage(screenFrame, 0, 0, w, h);
  if (cameraFrame) {
    const ch = Math.round(h * CAMERA_HEIGHT);
    const cw = Math.min(Math.round((ch * cameraFrame.displayWidth) / Math.max(1, cameraFrame.displayHeight)), Math.round(w * 0.4));
    const m = Math.round(h * 0.02);
    const x = corner.endsWith('left') ? m : w - cw - m;
    const y = corner.startsWith('top') ? m : h - ch - m;
    const r = Math.round(ch * 0.08);
    g.save();
    g.beginPath();
    g.roundRect(x, y, cw, ch, r);
    g.clip();
    // Cover: fill the box, cropping the camera picture if its shape differs.
    const scale = Math.max(cw / cameraFrame.displayWidth, ch / cameraFrame.displayHeight);
    const dw = cameraFrame.displayWidth * scale;
    const dh = cameraFrame.displayHeight * scale;
    g.drawImage(cameraFrame, x + (cw - dw) / 2, y + (ch - dh) / 2, dw, dh);
    g.restore();
    g.beginPath();
    g.roundRect(x, y, cw, ch, r);
    g.lineWidth = Math.max(2, Math.round(h / 360));
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    g.stroke();
  }
  lastEmit = performance.now();
  const frame = new VideoFrame(canvas, { timestamp: Math.round(lastEmit * 1000) });
  writing = true;
  writer
    .write(frame)
    .catch(() => {
      frame.close();
      stopped = true;
    })
    .finally(() => {
      writing = false;
    });
}

self.onmessage = (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    canvas = new OffscreenCanvas(16, 16);
    g = canvas.getContext('2d', { alpha: false, desynchronized: true });
    writer = msg.out.getWriter();
    corner = msg.corner;
    void pump(msg.screen.getReader(), false);
  } else if (msg.type === 'camera') {
    void cameraReader?.cancel().catch(() => {});
    cameraFrame?.close();
    cameraFrame = null;
    cameraReader = msg.camera.getReader();
    void pump(cameraReader, true);
  } else if (msg.type === 'corner') {
    corner = msg.corner;
    schedule();
  }
};
