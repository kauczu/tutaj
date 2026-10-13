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
}

export type ProfileId = 'call' | 'game';

export const PROFILES: Record<ProfileId, { label: string; settings: QualitySettings }> = {
  call: { label: 'Rozmowa', settings: { audio: 'voice', resolution: 720, uploadKbps: 0, codec: 'auto' } },
  game: { label: 'Gra', settings: { audio: 'studio', resolution: 1080, uploadKbps: 4000, codec: 'auto' } },
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

/** High-quality settings make 3+ person rooms go through the SFU right away. */
export const isHighQuality = (q: QualitySettings): boolean => q.audio === 'studio' || q.resolution === 1080;

let hwH264: Promise<boolean> | null = null;

/** Whether this machine encodes H.264 in hardware (GPU), which keeps the CPU free for the game. */
export function hasHardwareH264(): Promise<boolean> {
  hwH264 ??= (async () => {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/H264', width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 },
      });
      return info.supported && info.powerEfficient;
    } catch {
      return false;
    }
  })();
  return hwH264;
}

export async function prefersH264(q: QualitySettings): Promise<boolean> {
  return q.codec === 'h264' || (q.codec === 'auto' && (await hasHardwareH264()));
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

/** Codec order for a transceiver: RED (redundant audio) before Opus; H.264 first for video when preferred. */
export function codecOrder(kind: 'audio' | 'video', h264: boolean): RTCRtpCodec[] | null {
  const caps = RTCRtpReceiver.getCapabilities?.(kind)?.codecs;
  if (!caps?.length) return null;
  const rank = (c: RTCRtpCodec): number => {
    const mime = c.mimeType.toLowerCase();
    if (kind === 'audio') return mime === 'audio/red' ? 0 : mime === 'audio/opus' ? 1 : 2;
    if (!h264) return 1;
    if (mime !== 'video/h264') return 1;
    // Packetization mode 1 is what hardware encoders and the SFU use.
    return c.sdpFmtpLine?.includes('packetization-mode=1') ? 0 : 0.5;
  };
  if (kind === 'audio' && !caps.some((c) => c.mimeType.toLowerCase() === 'audio/red')) return null;
  if (kind === 'video' && !h264) return null;
  return [...caps].sort((a, b) => rank(a) - rank(b));
}

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
