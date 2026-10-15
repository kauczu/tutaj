// Call quality settings: audio mode, camera resolution, upload limit and video codec.

export type AudioMode = 'voice' | 'studio';
export type Resolution = 720 | 1080;
export type CodecPref = 'auto' | 'h264' | 'vp8';

export interface QualitySettings {
  audio: AudioMode;
  resolution: Resolution;
  /** Total upload limit for the call, kb/s; 0 = no limit (bandwidth estimation decides). */
  uploadKbps: number;
  codec: CodecPref;
  /**
   * Studio audio only: echo cancellation without the rest of the voice processing (still stereo,
   * no noise suppression or gain control) — for speakers instead of headphones. Voice always has it.
   * A property of your setup, not of a profile: profiles keep it as it is.
   */
  echoCancel: boolean;
}

export type ProfileId = 'call' | 'game';

export const PROFILES: Record<ProfileId, { settings: QualitySettings }> = {
  call: { settings: { audio: 'voice', resolution: 720, uploadKbps: 0, codec: 'auto', echoCancel: false } },
  game: { settings: { audio: 'studio', resolution: 1080, uploadKbps: 4000, codec: 'auto', echoCancel: false } },
};

export const UPLOAD_LIMITS = [0, 1500, 3000, 4000, 6000, 10000];

/** Opus target bitrate. Studio is stereo and transparent for music; voice is still full-band. */
export const AUDIO_BITRATE: Record<AudioMode, number> = { voice: 64_000, studio: 160_000 };
export const SCREEN_BITRATE = 3_000_000;
/** Total video upload across the mesh when there is no user limit. */
export const AUTO_VIDEO_BUDGET = 4_500_000;
/** Never squeeze a video stream below this, whatever the limit. */
export const MIN_VIDEO_BITRATE = 250_000;

const KEY = 'tutaj:quality';

export function loadQuality(): QualitySettings {
  const base = { ...PROFILES.call.settings };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (raw.audio === 'voice' || raw.audio === 'studio') base.audio = raw.audio;
      if (raw.resolution === 720 || raw.resolution === 1080) base.resolution = raw.resolution;
      if (UPLOAD_LIMITS.includes(raw.uploadKbps)) base.uploadKbps = raw.uploadKbps;
      if (raw.codec === 'auto' || raw.codec === 'h264' || raw.codec === 'vp8') base.codec = raw.codec;
      if (typeof raw.echoCancel === 'boolean') base.echoCancel = raw.echoCancel;
    }
  } catch {
    /* defaults */
  }
  return base;
}

export function saveQuality(q: QualitySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* private mode */
  }
}

export function profileOf(q: QualitySettings): ProfileId | null {
  for (const [id, p] of Object.entries(PROFILES) as [ProfileId, (typeof PROFILES)[ProfileId]][]) {
    const s = p.settings;
    if (s.audio === q.audio && s.resolution === q.resolution && s.uploadKbps === q.uploadKbps && s.codec === q.codec) return id;
  }
  return null;
}

/** A profile's settings, keeping what belongs to your setup rather than to the profile. */
export const withProfile = (id: ProfileId, current: QualitySettings): QualitySettings => ({
  ...PROFILES[id].settings,
  echoCancel: current.echoCancel,
});

/** Whether the microphone has to be re-opened to apply new settings. */
export const micChanged = (a: QualitySettings, b: QualitySettings): boolean =>
  a.audio !== b.audio || (b.audio === 'studio' && a.echoCancel !== b.echoCancel);

/** High-quality settings make 3+ person rooms go through the SFU right away. */
export const isHighQuality = (q: QualitySettings): boolean => q.audio === 'studio' || q.resolution === 1080;

/** true/false once known; null = not measurable yet (no camera/mic permission). */
let hwH264: boolean | null = null;
let probing: Promise<boolean | null> | null = null;

/**
 * Whether this machine encodes H.264 in hardware (GPU), which keeps the CPU free for the game.
 *
 * `mediaCapabilities.encodingInfo()` is no help here: Chromium reports `powerEfficient: false`
 * even when it then encodes on NVENC/QuickSync. So we encode a second of video over a local
 * connection and ask the encoder itself. Chromium reveals the encoder only to pages that capture
 * camera or mic — before that the answer is null and the probe is repeated later.
 */
export async function hasHardwareH264(): Promise<boolean | null> {
  if (hwH264 !== null) return hwH264;
  probing ??= probeHardwareH264().then((r) => {
    probing = null;
    if (r !== null) hwH264 = r;
    return r;
  });
  return probing;
}

async function probeHardwareH264(): Promise<boolean | null> {
  const h264 = RTCRtpSender.getCapabilities?.('video')?.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264?.length) return false;
  // Hardware encoders are skipped for tiny frames, so probe at 720p.
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream) return null;
  let frame = 0;
  const draw = window.setInterval(() => {
    ctx.fillStyle = `hsl(${(frame++ * 9) % 360} 70% 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
    a.addTransceiver(track, { direction: 'sendonly' }).setCodecPreferences(h264);
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      let result: boolean | null | undefined;
      (await a.getStats()).forEach((s) => {
        if (s.type !== 'outbound-rtp' || !s.framesEncoded) return;
        // Hidden (undefined) without capture permission.
        result = typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null;
      });
      if (result !== undefined) return result;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearInterval(draw);
    track.stop();
    a.close();
    b.close();
  }
}

export async function prefersH264(q: QualitySettings): Promise<boolean> {
  return q.codec === 'h264' || (q.codec === 'auto' && (await hasHardwareH264()) === true);
}

/**
 * Lets Opus carry stereo at high bitrate in both directions. Applied to local and remote
 * descriptions: `stereo` / `maxaveragebitrate` from the remote side configure our encoder,
 * `stereo` in our own description configures our decoder. The actual send bitrate is then
 * set per sender (RTCRtpEncodingParameters.maxBitrate), so it can change without renegotiation.
 */
export function tuneOpusSdp(sdp: string): string {
  const pts = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/gim)].map((m) => m[1]);
  let out = sdp;
  for (const pt of pts) {
    out = out.replace(new RegExp(`^a=fmtp:${pt} (.*?)(\\r?)$`, 'm'), (_line, params: string, cr: string) => {
      const map = new Map<string, string>();
      for (const p of params.split(';')) {
        const [k, v = ''] = p.trim().split('=');
        if (k) map.set(k, v);
      }
      map.set('stereo', '1');
      map.set('sprop-stereo', '1');
      map.set('maxaveragebitrate', '510000');
      map.set('useinbandfec', '1');
      return `a=fmtp:${pt} ${[...map].map(([k, v]) => `${k}=${v}`).join(';')}${cr}`;
    });
  }
  return out;
}

/** Audio codec order with RED (redundant audio) before Opus, or null when RED is unavailable. */
export function redFirst(): RTCRtpCodec[] | null {
  const caps = RTCRtpReceiver.getCapabilities?.('audio')?.codecs;
  if (!caps?.some((c) => c.mimeType.toLowerCase() === 'audio/red')) return null;
  const rank = (c: RTCRtpCodec) => {
    const mime = c.mimeType.toLowerCase();
    return mime === 'audio/red' ? 0 : mime === 'audio/opus' ? 1 : 2;
  };
  return [...caps].sort((a, b) => rank(a) - rank(b));
}

/** H.264 in packetization mode 1 — what hardware encoders and the SFU use. */
export const isH264 = (c: { mimeType: string; sdpFmtpLine?: string }): boolean =>
  c.mimeType.toLowerCase() === 'video/h264' && /packetization-mode=1/.test(c.sdpFmtpLine ?? '');

/** Bitrate ceiling for a camera stream of the given height (what it needs to look sharp). */
export function videoCap(height: number | undefined): number {
  const h = height ?? 720;
  return h >= 1000 ? 4_000_000 : h >= 540 ? 2_000_000 : 1_000_000;
}

/** Video bitrate budget for all our outgoing streams (`audioBps` = audio we send alongside). */
export function videoBudget(q: QualitySettings, audioBps: number): number {
  return q.uploadKbps ? Math.max(MIN_VIDEO_BITRATE, q.uploadKbps * 1000 - audioBps) : AUTO_VIDEO_BUDGET;
}

/** Simulcast layer bitrates relative to the top layer, lowest first. */
const LADDER: Record<number, number[]> = { 1: [1], 2: [0.3, 1], 3: [0.08, 0.3, 1] };

/** Per-layer max bitrates for `layers` simulcast layers within `budget`, top layer at most `cap`. */
export function simulcastBitrates(layers: number, cap: number, budget: number): number[] {
  const ratios = LADDER[layers] ?? LADDER[1];
  const top = Math.max(MIN_VIDEO_BITRATE, Math.min(cap, budget / ratios.reduce((a, b) => a + b, 0)));
  return ratios.map((r) => Math.max(80_000, Math.round(top * r)));
}
