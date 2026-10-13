// Signaling protocol shared by client and server. Types only — import with `import type`.

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerInfo {
  id: string;
  name: string;
}

export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalData = { description: SessionDescription } | { candidate: IceCandidate };

/** How media flows in a room: directly between peers, or through the server's SFU. */
export type MediaMode = 'mesh' | 'sfu';
/** What the room asked for; `auto` lets the server decide from quality reports. */
export type ModePreference = 'auto' | 'mesh' | 'sfu';
export type ModeReason = 'participants' | 'bandwidth' | 'cpu' | 'relay' | 'quality' | 'manual' | 'sfu-unavailable';

/** Periodic uplink health summary a client sends while in mesh mode. */
export interface QualityReport {
  /** Outgoing video is limited by bandwidth on at least one connection. */
  bw: boolean;
  /** Outgoing video is limited by CPU. */
  cpu: boolean;
  /** At least one connection goes through a TURN relay. */
  relayed: boolean;
  /** Sum of estimated available upload over all connections, kb/s. */
  uplinkKbps: number | null;
  /** Sending high-quality media (studio audio or 1080p): 3+ person rooms should use the SFU. */
  hq?: boolean;
}

export type SfuMethod =
  | 'capabilities'
  | 'create-transport'
  | 'connect-transport'
  | 'produce'
  | 'close-producer'
  | 'producers'
  | 'consume'
  | 'resume-consumer'
  | 'leave';

export interface SfuProducerInfo {
  peerId: string;
  producerId: string;
  kind: 'audio' | 'video';
}

export type SfuNotification =
  | { method: 'producer-added'; data: SfuProducerInfo }
  | { method: 'producer-removed'; data: { peerId: string; producerId: string } }
  | { method: 'consumer-closed'; data: { consumerId: string } };

export type ClientMessage =
  | {
      type: 'join';
      room: string;
      name: string;
      password?: string;
      /** Rejoin under a previous identity (from `welcome`) so existing P2P connections survive a signaling outage. */
      resume?: { id: string; token: string };
      /** Owner key (server's OWNER_KEY): lifts per-IP limits and extends TURN credentials. */
      ownerKey?: string;
    }
  /** `sid` identifies the sender's RTCPeerConnection, so a fresh connection can be told apart from the old one. */
  | { type: 'signal'; to: string; sid: string; data: SignalData }
  /** Opaque app payload forwarded to one peer (`to`) or everyone else in the room. */
  | { type: 'relay'; to?: string; payload: unknown }
  | { type: 'leave' }
  | { type: 'quality'; report: QualityReport }
  | { type: 'set-mode'; pref: ModePreference }
  /** Request to the SFU; answered by `sfu-response` with the same `id`. Payloads are mediasoup objects. */
  | { type: 'sfu'; id: number; method: SfuMethod; data?: Record<string, unknown> };

export type ErrorCode =
  | 'room-full'
  | 'bad-password'
  | 'invalid-message'
  | 'not-joined'
  | 'already-joined'
  | 'unknown-peer'
  | 'rate-limited'
  | 'room-limit';

export type ServerMessage =
  | {
      type: 'welcome';
      selfId: string;
      room: string;
      peers: PeerInfo[];
      iceServers: IceServer[];
      maxPeers: number;
      /** Base URL under which this server hosts the web client, used to build invite links. */
      shareBaseUrl: string | null;
      resumeToken: string;
      mode: MediaMode;
      pref: ModePreference;
      sfuAvailable: boolean;
      /** The server recognised the owner key or a trusted IP — no limits apply to this client. */
      privileged: boolean;
    }
  /** Room media mode changed (or the preference did). `by` names who changed the preference. */
  | { type: 'mode'; mode: MediaMode; pref: ModePreference; reason: ModeReason; by?: string }
  | { type: 'sfu-response'; id: number; ok: true; data: unknown }
  | { type: 'sfu-response'; id: number; ok: false; error: string }
  | ({ type: 'sfu-notify' } & SfuNotification)
  | { type: 'peer-joined'; peer: PeerInfo }
  /** `disconnect` = socket dropped (the P2P call may still be alive); `leave` = left on purpose. */
  | { type: 'peer-left'; id: string; reason: 'leave' | 'disconnect' }
  | { type: 'signal'; from: string; sid: string; data: SignalData }
  | { type: 'relay'; from: string; payload: unknown }
  | { type: 'error'; code: ErrorCode; message: string };
