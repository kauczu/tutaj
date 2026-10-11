import './style.css';
import { SpeakingDetector } from './audio';
import { LocalMedia, describeMediaError } from './media';
import { Room } from './room';
import { signalingUrl } from './signaling';
import { $, fillDeviceSelect } from './ui/dom';
import { setIcon } from './ui/icons';

/** Exposed by the Electron preload when running as the desktop app. */
interface DesktopBridge {
  isDesktop: true;
  hostInfo(): Promise<{ lanUrls: string[]; httpPort: number } | null>;
}
declare global {
  interface Window {
    tutaj?: DesktopBridge;
  }
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`tutaj:${k}`) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`tutaj:${k}`, v);
    } catch {
      /* private mode */
    }
  },
};

const WORDS = ['las', 'rzeka', 'sowa', 'lis', 'wiatr', 'kawa', 'most', 'zorza', 'fala', 'szczyt', 'jasny', 'cichy', 'ruda', 'mewa'];
function randomRoom(): string {
  const pick = () => WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
  const num = crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
  return `${pick()}-${pick()}-${num}`;
}

const media = new LocalMedia();
media.audioDeviceId = store.get('audioDevice') || undefined;
media.videoDeviceId = store.get('videoDevice') || undefined;

const nameInput = $<HTMLInputElement>('name');
const roomInput = $<HTMLInputElement>('room');
const passwordInput = $<HTMLInputElement>('password');
const serverInput = $<HTMLInputElement>('server');
const audioSelect = $<HTMLSelectElement>('audio-input');
const videoSelect = $<HTMLSelectElement>('video-input');
const previewVideo = $<HTMLVideoElement>('preview-video');
const errorEl = $('lobby-error');
const joinBtn = $<HTMLButtonElement>('join');
const micBtn = $('preview-mic');
const camBtn = $('preview-cam');
const meter = $('preview-meter').firstElementChild as HTMLElement;

let detector: SpeakingDetector | null = null;

function showError(msg: string | null): void {
  errorEl.textContent = msg ?? '';
  errorEl.hidden = !msg;
}

function refreshPreview(): void {
  const stream = media.previewStream();
  previewVideo.srcObject = stream.getVideoTracks().length ? stream : null;
  $('preview-placeholder').hidden = media.cameraOn;
  setIcon(micBtn, media.audioEnabled && media.audioTrack ? 'mic' : 'micOff');
  setIcon(camBtn, media.cameraOn ? 'cam' : 'camOff');
  micBtn.classList.toggle('off', !(media.audioEnabled && media.audioTrack));
  camBtn.classList.toggle('off', !media.cameraOn);
  detector?.watch('preview', media.audioTrack);
}

async function refreshDevices(): Promise<void> {
  fillDeviceSelect(audioSelect, await LocalMedia.devices('audioinput'), media.audioDeviceId, 'Mikrofon');
  fillDeviceSelect(videoSelect, await LocalMedia.devices('videoinput'), media.videoDeviceId, 'Kamera');
}

async function initLobby(): Promise<void> {
  const params = new URLSearchParams(location.search);
  nameInput.value = store.get('name');
  roomInput.value = params.get('room') ?? randomRoom();
  serverInput.value = params.get('server') ?? store.get('server');
  if (params.get('room')) joinBtn.textContent = `Dołącz do „${params.get('room')}”`;

  $('random-room').addEventListener('click', () => (roomInput.value = randomRoom()));
  media.on('change', refreshPreview);

  micBtn.addEventListener('click', async () => {
    if (!media.audioTrack) {
      try {
        await media.setMicrophone(media.audioDeviceId);
      } catch (e) {
        return showError(`Mikrofon: ${describeMediaError(e)}`);
      }
    } else media.setAudioEnabled(!media.audioEnabled);
    refreshPreview();
  });
  camBtn.addEventListener('click', async () => {
    try {
      await media.setCamera(!media.cameraOn);
    } catch (e) {
      showError(`Kamera: ${describeMediaError(e)}`);
    }
  });
  audioSelect.addEventListener('change', () => {
    store.set('audioDevice', audioSelect.value);
    media.setMicrophone(audioSelect.value).catch((e) => showError(describeMediaError(e)));
  });
  videoSelect.addEventListener('change', () => {
    store.set('videoDevice', videoSelect.value);
    media.setCamera(true, videoSelect.value).catch((e) => showError(describeMediaError(e)));
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

  $<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void join();
  });

  void showHostInfo();

  const problems = await media.start(true, true);
  if (problems.length) showError(`${problems.join('. ')}. Możesz dołączyć bez nich.`);
  try {
    detector = new SpeakingDetector((_id, _speaking, level) => {
      meter.style.width = `${Math.min(100, level * 400)}%`;
    });
  } catch {
    /* no WebAudio */
  }
  refreshPreview();
  await refreshDevices(); // labels are only available after permission is granted
}

async function showHostInfo(): Promise<void> {
  const info = await window.tutaj?.hostInfo().catch(() => null);
  if (!info) return;
  const box = $('host-info');
  box.hidden = false;
  box.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'Ta aplikacja jest hostem w sieci lokalnej.';
  box.append(title, document.createElement('br'));
  box.append(
    info.lanUrls.length
      ? `Inni w tej samej sieci dołączą przez przeglądarkę: ${info.lanUrls.join(' lub ')} (zaakceptuj certyfikat) albo z aplikacji desktopowej, wpisując ${info.lanUrls[0].replace(/^https:\/\/([^:]+):\d+/, `$1:${info.httpPort}`)} jako serwer.`
      : 'Nie wykryto sieci lokalnej.',
  );
}

async function join(): Promise<void> {
  showError(null);
  const name = nameInput.value.trim();
  const roomId = roomInput.value.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(roomId)) {
    return showError('Podaj imię i nazwę pokoju (litery, cyfry, - i _).');
  }
  let url: string;
  try {
    url = signalingUrl(serverInput.value);
  } catch {
    return showError('Nieprawidłowy adres serwera.');
  }
  store.set('name', name);
  store.set('server', serverInput.value.trim());

  joinBtn.disabled = true;
  joinBtn.textContent = 'Łączenie…';
  try {
    detector?.destroy();
    detector = null;
    await Room.join(
      { roomId, name, password: passwordInput.value || undefined, signalingUrl: url, media },
      () => {
        // Back to the lobby with the room prefilled; a reload releases everything cleanly.
        location.reload();
      },
    );
    const u = new URL(location.href);
    u.searchParams.set('room', roomId);
    history.replaceState(null, '', u);
    document.title = `${roomId} · Tutaj`;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    joinBtn.disabled = false;
    joinBtn.textContent = 'Dołącz';
    try {
      detector = new SpeakingDetector((_id, _s, level) => (meter.style.width = `${Math.min(100, level * 400)}%`));
      detector.watch('preview', media.audioTrack);
    } catch {
      /* ignore */
    }
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

void initLobby();
