import type { LocalMedia } from '../media';
import { describeMediaError } from '../media';
import { PROFILES, UPLOAD_LIMITS, hasHardwareH264, profileOf, type ProfileId, type QualitySettings } from '../quality';
import { h } from './dom';
import { locale, t } from '../i18n';

const option = (value: string, text: string, selected: boolean): HTMLOptionElement => {
  const o = h('option', { text });
  o.value = value;
  o.selected = selected;
  return o;
};

const field = (label: string, control: HTMLElement): HTMLLabelElement => h('label', {}, label, control);

const mbps = (kbps: number) => `${(kbps / 1000).toLocaleString(locale)} Mb/s`;

/**
 * Quality settings: a profile ("Rozmowa" / "Gra") plus the individual knobs behind it.
 * Renders into `container`; changes apply immediately to `media` (and through it to the call).
 */
export function renderQualityForm(container: HTMLElement, media: LocalMedia, onError: (msg: string) => void): void {
  const q = media.quality;
  const profile = h('select');
  profile.id = `${container.id}-profile`;
  const audio = h('select');
  audio.id = `${container.id}-audio`;
  const resolution = h('select');
  resolution.id = `${container.id}-resolution`;
  const upload = h('select');
  upload.id = `${container.id}-upload`;
  const codec = h('select');
  codec.id = `${container.id}-codec`;
  const hint = h('p', { class: 'muted small quality-hint' });

  const fill = (s: QualitySettings) => {
    const current = profileOf(s);
    profile.replaceChildren(
      ...(Object.entries(PROFILES) as [ProfileId, (typeof PROFILES)[ProfileId]][]).map(([id]) => option(id, t(`q.profile.${id}`), id === current)),
      option('custom', t('q.profile.custom'), current === null),
    );
    audio.replaceChildren(
      option('voice', t('q.audio.voice'), s.audio === 'voice'),
      option('studio', t('q.audio.studio'), s.audio === 'studio'),
    );
    resolution.replaceChildren(option('720', '720p', s.resolution === 720), option('1080', t('q.video.1080'), s.resolution === 1080));
    upload.replaceChildren(...UPLOAD_LIMITS.map((k) => option(String(k), k ? mbps(k) : t('q.upload.none'), k === s.uploadKbps)));
    codec.replaceChildren(
      option('auto', t('q.codec.auto'), s.codec === 'auto'),
      option('h264', 'H.264', s.codec === 'h264'),
      option('vp8', t('q.codec.vp8'), s.codec === 'vp8'),
    );
    const notes: string[] = [];
    if (s.audio === 'studio') notes.push(t('q.studioHint'));
    if (s.uploadKbps) notes.push(t('q.uploadHint', { rate: mbps(s.uploadKbps) }));
    hint.textContent = notes.join(' ');
  };

  const apply = (s: QualitySettings) => {
    fill(s);
    media.setQuality(s).catch((e) => onError(describeMediaError(e)));
  };

  profile.onchange = () => {
    if (profile.value in PROFILES) apply({ ...PROFILES[profile.value as ProfileId].settings });
  };
  const read = (): QualitySettings => ({
    audio: audio.value === 'studio' ? 'studio' : 'voice',
    resolution: resolution.value === '1080' ? 1080 : 720,
    uploadKbps: Number(upload.value),
    codec: codec.value === 'h264' || codec.value === 'vp8' ? codec.value : 'auto',
  });
  for (const el of [audio, resolution, upload, codec]) el.onchange = () => apply(read());

  const encoder = h('p', { class: 'muted small' });
  const checkEncoder = async () => {
    const hw = await hasHardwareH264();
    encoder.textContent =
      hw === null
        ? t('q.hwChecking')
        : hw
          ? t('q.hwYes')
          : t('q.hwNo');
    return hw;
  };
  // The encoder is only revealed once the page captures camera/mic: re-check when that starts.
  void checkEncoder().then((hw) => {
    if (hw !== null) return;
    const off = media.on('change', () => {
      void checkEncoder().then((r) => r !== null && off());
    });
  });

  fill(q);
  container.replaceChildren(
    field(t('q.profile'), profile),
    field(t('q.audio'), audio),
    field(t('q.video'), resolution),
    field(t('q.upload'), upload),
    field(t('q.codec'), codec),
    hint,
    encoder,
  );
}
