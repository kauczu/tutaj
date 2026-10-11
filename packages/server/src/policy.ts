import type { MediaMode, ModePreference, ModeReason, QualityReport } from '@tutaj/shared';

/** Minimum upload per outgoing stream for a usable mesh, kb/s. */
export const MIN_STREAM_KBPS = 350;
/** Consecutive bad reports (≈5 s apart) before we act — ignores short dips and BWE ramp-up. */
export const STRIKES_TO_SWITCH = 3;

export interface Decision {
  mode: MediaMode;
  reason: ModeReason;
}

interface PeerHealth {
  strikes: number;
  cause: 'bandwidth' | 'cpu';
  relayed: boolean;
}

/**
 * Per-room choice between P2P mesh and SFU.
 *
 * Mesh is the default and always wins for 2 people (one upstream either way). With 3–4 people
 * we move to the SFU once someone's uplink or CPU can't keep up with N−1 streams, or when
 * connections already go through TURN. Once on the SFU we stay there until the room shrinks
 * to 2, so the room does not flap between modes.
 */
export class ModePolicy {
  mode: MediaMode = 'mesh';
  pref: ModePreference = 'auto';
  private health = new Map<string, PeerHealth>();

  constructor(private sfuAvailable: boolean) {}

  /** Returns a decision only when the mode changes. */
  report(peerId: string, r: QualityReport, participants: number): Decision | null {
    const h = this.health.get(peerId) ?? { strikes: 0, cause: 'bandwidth', relayed: false };
    const uplinkShort = r.uplinkKbps !== null && participants > 1 && r.uplinkKbps < (participants - 1) * MIN_STREAM_KBPS;
    if (r.cpu) {
      h.strikes++;
      h.cause = 'cpu';
    } else if (r.bw || uplinkShort) {
      h.strikes++;
      h.cause = 'bandwidth';
    } else {
      h.strikes = 0;
    }
    h.relayed = r.relayed;
    this.health.set(peerId, h);
    return this.apply(participants);
  }

  setPref(pref: ModePreference, participants: number): Decision | null {
    this.pref = pref;
    return this.apply(participants);
  }

  participantsChanged(participants: number, leftId?: string): Decision | null {
    if (leftId) this.health.delete(leftId);
    return this.apply(participants);
  }

  /** The SFU died or was never there: fall back to mesh for good. */
  disableSfu(participants: number): Decision | null {
    this.sfuAvailable = false;
    return this.apply(participants);
  }

  private apply(participants: number): Decision | null {
    const d = this.decide(participants);
    if (d.mode === this.mode) return null;
    this.mode = d.mode;
    // Fresh start after a switch: old strikes described the previous topology.
    for (const h of this.health.values()) h.strikes = 0;
    return d;
  }

  private decide(n: number): Decision {
    if (!this.sfuAvailable) return { mode: 'mesh', reason: 'sfu-unavailable' };
    if (this.pref !== 'auto') return { mode: this.pref, reason: 'manual' };
    if (n <= 2) return { mode: 'mesh', reason: 'participants' };
    if (this.mode === 'sfu') return { mode: 'sfu', reason: 'participants' };
    const all = [...this.health.values()];
    if (all.some((h) => h.relayed)) return { mode: 'sfu', reason: 'relay' };
    const struggling = all.find((h) => h.strikes >= STRIKES_TO_SWITCH);
    if (struggling) return { mode: 'sfu', reason: struggling.cause };
    return { mode: 'mesh', reason: 'participants' };
  }
}
