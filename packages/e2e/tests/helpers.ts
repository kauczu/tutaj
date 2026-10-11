import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '@tutaj/server';
import { WebSocket } from 'ws';

// --- Server -----------------------------------------------------------------

let sfuPortSeq = 0;

export interface TestServer {
  server: RunningServer;
  url: string;
  port: number;
}

/** Starts a real server on 127.0.0.1 (random HTTP port, no external STUN). */
export async function startTestServer(opts: { sfu?: boolean; port?: number; maxPeers?: number } = {}): Promise<TestServer> {
  // Distinct SFU ports per worker and per server, so parallel tests and restarts never collide.
  const sfuPort = 41000 + Number(process.env.TEST_PARALLEL_INDEX ?? 0) * 200 + (sfuPortSeq++ % 200);
  const server = await startServer({
    host: '127.0.0.1',
    port: opts.port ?? 0,
    maxPeers: opts.maxPeers,
    log: () => {},
    ice: { stunUrls: [] },
    sfu: opts.sfu ? { listenIp: '127.0.0.1', port: sfuPort } : false,
  });
  return { server, url: `http://127.0.0.1:${server.httpPort}`, port: server.httpPort };
}

// --- Traffic probe (runs in the page before the app) ----------------------------

export interface PcTraffic {
  /** True for the SFU's connection (mediasoup is ICE-lite), false for a mesh connection. */
  sfu: boolean;
  state: RTCPeerConnectionState;
  inKB: number;
  outKB: number;
}

declare global {
  interface Window {
    __pcs: RTCPeerConnection[];
    __delta(ms: number): Promise<PcTraffic[]>;
  }
}

/** Records every RTCPeerConnection the page creates and measures video bytes over a time window. */
function trafficProbe() {
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  const Wrapped = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  window.RTCPeerConnection = Wrapped;

  const snapshot = async () =>
    Promise.all(
      window.__pcs
        .filter((pc) => pc.connectionState !== 'closed')
        .map(async (pc) => {
          let inV = 0;
          let outV = 0;
          (await pc.getStats()).forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') inV += s.bytesReceived;
            if (s.type === 'outbound-rtp' && s.kind === 'video') outV += s.bytesSent;
          });
          return { pc, sfu: !!pc.remoteDescription?.sdp.includes('a=ice-lite'), inV, outV };
        }),
    );
  window.__delta = async (ms: number) => {
    const before = await snapshot();
    await new Promise((r) => setTimeout(r, ms));
    const after = await snapshot();
    return after.map((a) => {
      const b = before.find((x) => x.pc === a.pc);
      return {
        sfu: a.sfu,
        state: a.pc.connectionState,
        inKB: Math.round((a.inV - (b?.inV ?? 0)) / 1024),
        outKB: Math.round((a.outV - (b?.outV ?? 0)) / 1024),
      };
    });
  };
}

// --- Participant --------------------------------------------------------------

export class Participant {
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly name: string,
  ) {}

  /** Opens the lobby in a fresh browser context (own storage, own fake camera). */
  static async open(browser: Browser, baseUrl: string, room: string, name: string): Promise<Participant> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(trafficProbe);
    await page.goto(`${baseUrl}/?room=${encodeURIComponent(room)}`);
    await page.fill('#name', name);
    // The lobby acquires camera + mic on load; wait until both are live.
    await expect(page.locator('#preview-cam')).not.toHaveClass(/off/);
    await expect(page.locator('#preview-mic')).not.toHaveClass(/off/);
    return new Participant(context, page, name);
  }

  static async join(browser: Browser, baseUrl: string, room: string, name: string, password?: string): Promise<Participant> {
    const p = await Participant.open(browser, baseUrl, room, name);
    await p.submitJoin(password);
    await expect(p.page.locator('#room-view')).toBeVisible();
    return p;
  }

  async submitJoin(password?: string): Promise<void> {
    if (password) {
      await this.page.click('details summary');
      await this.page.fill('#password', password);
    }
    await this.page.click('#join');
  }

  tile(name: string): Locator {
    return this.page.locator('.tile', { has: this.page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
  }

  get badge(): Locator {
    return this.page.locator('#mode-badge');
  }

  get banner(): Locator {
    return this.page.locator('#reconnecting');
  }

  /** Asserts that live video from `name` is rendering (has size and keeps advancing). */
  async expectVideoFrom(name: string): Promise<void> {
    const video = this.tile(name).locator('video');
    await expect(video).toHaveCount(1);
    await expect
      .poll(async () => {
        const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
        await this.page.waitForTimeout(400);
        const t1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
        const w = await video.evaluate((v: HTMLVideoElement) => v.videoWidth);
        return w > 0 && t1 - t0 > 0.15;
      })
      .toBe(true);
  }

  async setMode(mode: 'auto' | 'mesh' | 'sfu'): Promise<void> {
    await this.page.click('#btn-settings');
    await this.page.selectOption('#set-mode', mode);
    await this.page.getByRole('button', { name: 'Zamknij' }).click();
  }

  traffic(ms = 1500): Promise<PcTraffic[]> {
    return this.page.evaluate((m) => window.__delta(m), ms);
  }

  /** Polls until video bytes flow the expected way: only through the SFU, or only over the mesh. */
  async expectMediaPath(path: 'sfu' | 'mesh'): Promise<void> {
    await expect
      .poll(async () => {
        const t = await this.traffic();
        const sfuIn = t.filter((x) => x.sfu).reduce((s, x) => s + x.inKB, 0);
        const meshIn = t.filter((x) => !x.sfu).reduce((s, x) => s + x.inKB, 0);
        const meshOut = t.filter((x) => !x.sfu).reduce((s, x) => s + x.outKB, 0);
        return path === 'sfu' ? sfuIn > 5 && meshIn + meshOut < 3 : meshIn > 5 && sfuIn === 0;
      })
      .toBe(true);
  }

  async sendChat(text: string): Promise<void> {
    if (await this.page.locator('#chat').isHidden()) await this.page.click('#btn-chat');
    await this.page.fill('#chat-input', text);
    await this.page.press('#chat-input', 'Enter');
  }

  chatMessages(): Locator {
    return this.page.locator('#chat-list li:not(.system):not(.file) .text');
  }

  systemMessages(): Locator {
    return this.page.locator('#chat-list li.system');
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

// --- Raw signaling client (to drive the server directly) -----------------------

export class Bot {
  private queue: any[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (d) => this.queue.push(JSON.parse(d.toString())));
  }

  static async join(baseUrl: string, room: string, name = 'Bot'): Promise<Bot> {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const bot = new Bot(ws);
    bot.send({ type: 'join', room, name });
    await expect.poll(() => bot.received('welcome').length).toBe(1);
    return bot;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  received(type: string): any[] {
    return this.queue.filter((m) => m.type === type);
  }

  leave(): void {
    this.send({ type: 'leave' });
    this.ws.close();
  }
}

export async function closeAll(...items: (Participant | { server: RunningServer } | undefined)[]): Promise<void> {
  for (const item of items) {
    if (!item) continue;
    if (item instanceof Participant) await item.close().catch(() => {});
    else await item.server.close().catch(() => {});
  }
}
