import './style.css';
import { lang, languagePreference, setLanguagePreference, t, translateDocument, type LangPreference } from './i18n';
import { SpeakingDetector } from './audio';
import { APP_VERSION, BRAND } from './brand';
import { LocalMedia, describeMediaError } from './media';
import { Room } from './room';
import { signalingUrl } from './signaling';
import { $, fillDeviceSelect } from './ui/dom';
import type { OverlaySettings } from './ui/overlay';
import { showHelp } from './ui/help';
import { renderQualityForm } from './ui/quality-form';
import { setIcon } from './ui/icons';
import { toast } from './ui/toast';

/** Exposed by the Electron preload when running as the desktop app. */
interface DesktopInfo {
  /** Version of the desktop app (0.3.0+); the page itself comes from the server. */
  appVersion?: string;
  /** remote: window onto the Tutaj server; lan: the app hosts calls on the local network. */
  mode: 'remote' | 'lan';
  serverUrl: string;
  /** The server this build is dedicated to. */
  defaultServer?: string;
  lan: { lanUrls: string[]; httpPort: number } | null;
}
interface DesktopBridge {
  isDesktop: true;
  info(): Promise<DesktopInfo | null>;
  switchMode(mode: 'remote' | 'lan'): Promise<void>;
  /** Saves another server address (empty = default) and restarts the app. */
  setServer?(url: string): Promise<{ ok: boolean; error?: string }>;
  /** Game overlay (0.3.0+). */
  overlay?: {
    get(): Promise<
      OverlaySettings & {
        displays: { id: number; label: string; width: number; height: number; primary: boolean }[];
        hotkeys: Record<'overlay' | 'mute' | 'window', string>;
      }
    >;
    set(patch: Partial<OverlaySettings>): Promise<OverlaySettings>;
    resize(width: number, height: number): Promise<void>;
  };
  /** Changes a global shortcut (Electron accelerator; null = default). */
  setHotkey?(
    name: 'overlay' | 'mute' | 'window',
    accelerator: string | null,
  ): Promise<{ ok: boolean; error?: string; hotkeys?: Record<'overlay' | 'mute' | 'window', string> }>;
  /** Suspends global shortcuts while a new one is being recorded. */
  pauseHotkeys?(paused: boolean): Promise<void>;
  /** Enables the global shortcuts for the duration of a call. */
  setInCall?(inCall: boolean): Promise<void>;
  onHotkey?(cb: (name: 'overlay' | 'mute' | 'window') => void): () => void;
  /** Tells the app the page's language (menus, dialogs, update window follow it). */
  setLanguage?(lang: 'pl' | 'en'): Promise<void>;
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
const ownerKeyInput = $<HTMLInputElement>('owner-key');
const audioSelect = $<HTMLSelectElement>('audio-input');
const videoSelect = $<HTMLSelectElement>('video-input');
const previewVideo = $<HTMLVideoElement>('preview-video');
const errorEl = $('lobby-error');
const joinBtn = $<HTMLButtonElement>('join');
const micBtn = $('preview-mic');
const camBtn = $('preview-cam');
const meter = $('preview-meter').firstElementChild as HTMLElement;

let detector: SpeakingDetector | null = null;

/**
 * The lobby captures nothing by itself: the camera and microphone open when you join (or for the
 * preview you turn on), and close when you hang up — no hidden capture draining a phone's battery.
 * The buttons under the preview are what you join with, remembered between visits.
 */
const joinWith = { mic: store.get('joinMic') !== 'off', cam: store.get('joinCam') !== 'off' };
media.setAudioEnabled(joinWith.mic);
let previewing = false;
/** The preview was stopped because the tab went to the background; it comes back with the tab. */
let resumePreview = false;
let joining = false;

function rememberJoinWith(): void {
  store.set('joinMic', joinWith.mic ? 'on' : 'off');
  store.set('joinCam', joinWith.cam ? 'on' : 'off');
}

function startMeter(): void {
  if (detector) return;
  try {
    detector = new SpeakingDetector((_id, _speaking, level) => {
      meter.style.width = `${Math.min(100, level * 400)}%`;
    });
  } catch {
    /* no WebAudio */
  }
}

function stopMeter(): void {
  detector?.destroy();
  detector = null;
  meter.style.width = '0';
}

async function startPreview(): Promise<void> {
  if (previewing) return;
  previewing = true;
  refreshPreview();
  const problems = await media.start(true, joinWith.cam);
  if (!previewing) return media.stop(); // stopped while the browser was asking
  if (problems.length) showError(t('lobby.canJoinWithout', { problems: problems.join('. ') }));
  startMeter();
  refreshPreview();
  await refreshDevices(); // labels are only available after permission is granted
}

function stopPreview(): void {
  if (!previewing) return;
  previewing = false;
  stopMeter();
  media.stop();
  refreshPreview();
}

function showError(msg: string | null): void {
  errorEl.textContent = msg ?? '';
  errorEl.hidden = !msg;
}

function refreshPreview(): void {
  const stream = media.previewStream();
  previewVideo.srcObject = stream.getVideoTracks().length ? stream : null;
  const placeholder = $('preview-placeholder');
  placeholder.hidden = previewing && media.cameraOn;
  $('preview-note').textContent = previewing ? t('lobby.cameraOff') : t('lobby.previewIdle');
  const toggle = $<HTMLButtonElement>('preview-toggle');
  // Under the note before the preview; in the corner over the picture while it runs.
  if (previewing) placeholder.parentElement!.append(toggle);
  else placeholder.append(toggle);
  toggle.textContent = previewing ? t('lobby.previewStop') : t('lobby.previewStart');
  toggle.disabled = joining;
  $('preview-meter').hidden = !previewing;
  // In the preview the buttons show what is live; before it, what you will join with.
  const micOn = previewing && media.audioTrack ? media.audioEnabled : joinWith.mic;
  const camOn = previewing ? media.cameraOn : joinWith.cam;
  setIcon(micBtn, micOn ? 'mic' : 'micOff');
  setIcon(camBtn, camOn ? 'cam' : 'camOff');
  micBtn.classList.toggle('off', !micOn);
  camBtn.classList.toggle('off', !camOn);
  micBtn.setAttribute('aria-pressed', String(micOn));
  camBtn.setAttribute('aria-pressed', String(camOn));
  detector?.watch('preview', media.audioTrack);
}

async function refreshDevices(): Promise<void> {
  fillDeviceSelect(audioSelect, await LocalMedia.devices('audioinput'), media.audioDeviceId, t('lobby.mic'));
  fillDeviceSelect(videoSelect, await LocalMedia.devices('videoinput'), media.videoDeviceId, t('lobby.camera'));
}

async function initLobby(): Promise<void> {
  translateDocument();
  const languageSelect = $<HTMLSelectElement>('language');
  languageSelect.value = languagePreference();
  languageSelect.onchange = () => setLanguagePreference(languageSelect.value as LangPreference);
  void window.tutaj?.setLanguage?.(lang).catch(() => {});
  const params = new URLSearchParams(location.search);
  nameInput.value = store.get('name');
  // An invitation link wins; otherwise the room used last time.
  roomInput.value = params.get('room') ?? (store.get('room') || randomRoom());
  serverInput.value = params.get('server') ?? store.get('server');
  ownerKeyInput.value = store.get('ownerKey');
  renderBranding();
  // A message carried over the reload after leaving a call (e.g. removed by the host).
  try {
    const notice = sessionStorage.getItem('tutaj:notice');
    if (notice) {
      sessionStorage.removeItem('tutaj:notice');
      showError(notice);
    }
  } catch {
    /* no storage */
  }
  renderQualityForm($('quality-lobby'), media, (msg) => showError(msg));
  if (params.get('room')) joinBtn.textContent = t('lobby.joinRoom', { room: params.get('room') ?? '' });

  $('random-room').addEventListener('click', () => (roomInput.value = randomRoom()));
  media.on('change', refreshPreview);

  micBtn.addEventListener('click', async () => {
    joinWith.mic = !joinWith.mic;
    rememberJoinWith();
    if (previewing && !media.audioTrack && joinWith.mic) {
      try {
        await media.setMicrophone(media.audioDeviceId);
      } catch (e) {
        showError(t('media.micProblem', { error: describeMediaError(e) }));
      }
    }
    media.setAudioEnabled(joinWith.mic);
    refreshPreview();
  });
  camBtn.addEventListener('click', async () => {
    joinWith.cam = !joinWith.cam;
    rememberJoinWith();
    if (previewing) {
      try {
        await media.setCamera(joinWith.cam);
      } catch (e) {
        showError(t('media.cameraProblem', { error: describeMediaError(e) }));
      }
    }
    refreshPreview();
  });
  $('preview-toggle').addEventListener('click', () => {
    showError(null);
    if (previewing) stopPreview();
    else void startPreview();
  });
  // A preview left running in a background tab (or a phone's browser) would keep the camera and
  // microphone busy and drain the battery: stop it there, bring it back with the tab.
  document.addEventListener('visibilitychange', () => {
    if (joining) return; // in the call (or joining) the room owns the devices
    if (document.visibilityState === 'hidden' && previewing) {
      resumePreview = true;
      stopPreview();
    } else if (document.visibilityState === 'visible' && resumePreview) {
      resumePreview = false;
      void startPreview();
    }
  });
  audioSelect.addEventListener('change', () => {
    store.set('audioDevice', audioSelect.value);
    media.audioDeviceId = audioSelect.value;
    if (media.audioTrack) media.setMicrophone(audioSelect.value).catch((e) => showError(describeMediaError(e)));
  });
  videoSelect.addEventListener('change', () => {
    store.set('videoDevice', videoSelect.value);
    media.videoDeviceId = videoSelect.value;
    if (media.cameraOn) media.setCamera(true, videoSelect.value).catch((e) => showError(describeMediaError(e)));
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

  $<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void join();
  });

  void showDesktopInfo();

  refreshPreview();
  await refreshDevices(); // with a permission granted earlier the names show without capturing
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function helpLink(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = t('lobby.help');
  b.onclick = () => void showHelp();
  return b;
}

/**
 * Author, repository and licence: lobby footer and the "about" section in settings.
 * The page comes from the server, so APP_VERSION is the server's version; the desktop app has its own.
 */
function renderBranding(desktopVersion?: string): void {
  const versions = desktopVersion ? t('lobby.versions', { server: APP_VERSION, app: desktopVersion }) : `v${APP_VERSION}`;
  $('tagline').textContent = t('lobby.tagline');
  const repoLabel = BRAND.repoUrl.replace(/^https:\/\//, '');
  $('lobby-footer').replaceChildren(
    `© ${BRAND.year} `,
    link(BRAND.author, BRAND.authorUrl),
    ' · ',
    link('GitHub', BRAND.repoUrl),
    ' · ',
    helpLink(),
    ` · ${BRAND.license} · ${versions}`,
  );
  const logo = document.createElement('img');
  logo.src = '/logo.webp';
  logo.alt = BRAND.logoAlt;
  const p = (...parts: (string | Node)[]) => {
    const el = document.createElement('p');
    el.append(...parts);
    return el;
  };
  $('about').replaceChildren(
    logo,
    p(`${BRAND.name} ${versions} · © ${BRAND.year} `, link(BRAND.author, BRAND.authorUrl)),
    p(t('lobby.sourceCode'), link(repoLabel, BRAND.repoUrl), ` (${BRAND.license})`),
    p(t('lobby.brandRights')),
  );
}

/** "Change server" for the desktop app: e.g. someone running Tutaj on their own domain. */
function serverChanger(bridge: DesktopBridge, info: DesktopInfo): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'server-changer';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ghost host-switch';
  toggle.textContent = t('desk.changeServer');
  const form = document.createElement('div');
  form.className = 'server-form';
  form.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = info.serverUrl;
  input.placeholder = t('desk.serverPlaceholder');
  input.setAttribute('aria-label', t('desk.serverAddress'));
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = t('desk.checkSave');
  const hint = document.createElement('p');
  hint.className = 'muted server-hint';
  hint.textContent = t('desk.serverHint');
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.hidden = true;
  const apply = async (url: string) => {
    save.disabled = true;
    save.textContent = t('desk.checking');
    msg.hidden = true;
    const res = await bridge.setServer!(url);
    if (!res.ok) {
      msg.textContent = res.error ?? t('desk.badAddress');
      msg.hidden = false;
      save.disabled = false;
      save.textContent = t('desk.checkSave');
    }
  };
  save.onclick = () => void apply(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void apply(input.value);
    }
  };
  form.append(input, save, hint, msg);
  if (info.defaultServer && info.serverUrl !== info.defaultServer) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost';
    reset.textContent = t('desk.restore', { host: new URL(info.defaultServer).host });
    reset.onclick = () => void apply('');
    form.append(reset);
  }
  toggle.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) input.focus();
  };
  wrap.append(toggle, form);
  return wrap;
}

/** Desktop app: show which mode it runs in and let the user switch (the app restarts). */
async function showDesktopInfo(): Promise<void> {
  const bridge = window.tutaj;
  const info = await bridge?.info?.().catch(() => null);
  if (!bridge || !info) return;
  if (info.appVersion) renderBranding(info.appVersion);
  const details = $<HTMLDetailsElement>('host-details');
  details.hidden = false;
  // In LAN mode the addresses for the others matter right away.
  details.open = info.mode === 'lan';
  $('host-summary').textContent = info.mode === 'lan' ? t('desk.networkLan') : t('desk.networkServer', { host: new URL(info.serverUrl).host });
  const box = $('host-info');
  box.replaceChildren();
  const title = document.createElement('strong');
  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.className = 'ghost host-switch';
  const serverHost = new URL(info.serverUrl).host;

  if (info.mode === 'remote') {
    title.textContent = t('desk.connected', { host: serverHost });
    box.append(title, document.createElement('br'), t('desk.offlineHint'));
    switchBtn.textContent = t('desk.toLan');
    switchBtn.onclick = () => void bridge.switchMode('lan');
    if (bridge.setServer) box.append(serverChanger(bridge, info));
    // The app is dedicated to its server; a custom signaling server makes no sense here.
    $('server').closest('label')?.setAttribute('hidden', '');
  } else {
    title.textContent = t('desk.lanTitle');
    const lan = info.lan;
    box.append(
      title,
      document.createElement('br'),
      lan?.lanUrls.length
        ? t('desk.lanHow', {
            urls: lan.lanUrls.join(t('desk.lanOr')),
            server: lan.lanUrls[0].replace(/^https:\/\/([^:]+):\d+/, `$1:${lan.httpPort}`),
          })
        : t('desk.noLan'),
    );
    switchBtn.textContent = t('desk.backToServer', { host: serverHost });
    switchBtn.onclick = () => void bridge.switchMode('remote');
  }
  box.append(switchBtn);
}

async function join(): Promise<void> {
  showError(null);
  const name = nameInput.value.trim();
  const roomId = roomInput.value.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(roomId)) {
    return showError(t('lobby.badNameRoom'));
  }
  let url: string;
  try {
    url = signalingUrl(serverInput.value);
  } catch {
    return showError(t('lobby.badServer'));
  }
  store.set('name', name);
  store.set('room', roomId);
  store.set('server', serverInput.value.trim());
  store.set('ownerKey', ownerKeyInput.value.trim());

  joinBtn.disabled = true;
  joinBtn.textContent = t('lobby.joining');
  joining = true;
  resumePreview = false;
  const wasPreviewing = previewing;
  refreshPreview();
  try {
    stopMeter();
    // Open what you join with; the mic opens muted too, so unmuting in the call is instant.
    const problems = await media.start(!media.audioTrack, joinWith.cam && !media.cameraOn);
    if (!joinWith.cam) await media.setCamera(false);
    media.setAudioEnabled(joinWith.mic);
    await Room.join(
      {
        roomId,
        name,
        password: passwordInput.value || undefined,
        ownerKey: ownerKeyInput.value.trim() || undefined,
        signalingUrl: url,
        media,
      },
      () => {
        // Back to the lobby with the room prefilled; a reload releases everything cleanly.
        location.reload();
      },
    );
    previewing = false;
    if (problems.length) toast(t('lobby.joinedWithout', { problems: problems.join('. ') }), 'error', 8000);
    const u = new URL(location.href);
    u.searchParams.set('room', roomId);
    history.replaceState(null, '', u);
    document.title = `${roomId} · Tutaj`;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    joinBtn.disabled = false;
    joinBtn.textContent = t('lobby.join');
    joining = false;
    // Back in the lobby: release the devices unless the preview was on.
    if (wasPreviewing) startMeter();
    else media.stop();
    refreshPreview();
  }
}

// Help: F1 anywhere, "Pomoc" in the settings dialog and the lobby footer.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F1') return;
  e.preventDefault();
  void showHelp();
});
$('open-help').addEventListener('click', () => void showHelp());

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

void initLobby();
