// Deliberately isolated Phase 0 code: no production transport selection or fallback changes.
import { Client, Room, type SeatReservation } from '@colyseus/sdk';
import { HostSessionClient } from '../../src/game/network/hostSession';

class SpikeRoom<T = any> extends Room<any, T> {
  constructor(name: string, private readonly channel: RTCDataChannel) { super(name); }
  override connect(): void {
    this.reconnection.enabled = false;
    const channel = this.channel;
    let closed = false;
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      if (this.joinedAtTime === 0) this.onError.invoke(code, reason);
      else this.onLeave.invoke(code, reason);
    };
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const notice = JSON.parse(event.data);
          if (notice.type === 'closed') finish(notice.code, notice.reason);
        } catch { finish(1002, 'Invalid spike control message'); }
      } else this.onMessageCallback(event);
    };
    channel.onclose = () => finish(1006, 'Direct channel disconnected');
    channel.onerror = () => finish(1011, 'Direct channel error');
    const send = (data: Uint8Array) => {
      if (closed || channel.readyState !== 'open') return;
      if (channel.bufferedAmount + data.byteLength > 1024 * 1024) { channel.close(); return; }
      channel.send(new Uint8Array(data));
    };
    const transport = {
      get isOpen() { return channel.readyState === 'open' && !closed; },
      get ws() { return { readyState: transport.isOpen ? 1 : 3, bufferedAmount: channel.bufferedAmount }; },
      send, sendUnreliable: send, connect: () => undefined, close: () => channel.close()
    };
    // Room.onMessageCallback, serializers, encoding and all game messages remain the SDK's own.
    // Only the Connection surface is replaced; this coupling is confined to the spike.
    this.connection = { get isOpen() { return transport.isOpen; }, send, sendUnreliable: send,
      connect: transport.connect, close: transport.close, transport, events: {} } as unknown as Room['connection'];
  }
}

class SpikeSeatClient extends HostSessionClient {
  constructor(private readonly channel: RTCDataChannel) { super('ws://localhost'); }
  protected override createRoom<T>(name: string): Room<any, T> { return new SpikeRoom<T>(name, this.channel); }
}

export class BrowserSpike {
  readonly peer: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  room: Room | null = null;
  readonly samples: Array<{ at: number; rttMs: number; serverLoopP95Ms?: number; serverBuffer?: number; clientBuffer: number }> = [];
  readonly startedAt = new Date().toISOString();

  constructor(stun = true) {
    this.peer = new RTCPeerConnection({ iceServers: stun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] });
    this.channel = this.peer.createDataChannel('colyseus-spike', { ordered: true });
    this.channel.binaryType = 'arraybuffer';
  }

  async offer(): Promise<RTCSessionDescriptionInit> {
    await this.peer.setLocalDescription(await this.peer.createOffer());
    if (this.peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('ICE gathering timed out. Check STUN access.')); }, 20_000);
      const done = () => { if (this.peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); this.peer.removeEventListener('icegatheringstatechange', done); };
      this.peer.addEventListener('icegatheringstatechange', done);
      done();
    });
    return this.peer.localDescription!.toJSON();
  }

  async answer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.peer.setRemoteDescription(answer);
    if (this.channel.readyState === 'open') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('No direct channel within 30s. Record this ICE failure; no fallback in Phase 0.')); }, 30_000);
      this.channel.onopen = () => { clearTimeout(timer); resolve(); };
      this.channel.onclose = () => { clearTimeout(timer); reject(new Error('Direct channel closed before opening')); };
    });
  }

  async join(roomId: string, name: string): Promise<Room> {
    if (this.room || this.channel.readyState !== 'open') throw new Error('Apply the answer first; each peer supports one join.');
    const joined = new Promise<Room>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Direct room join timed out')); }, 12_000);
      this.channel.onmessage = (event) => {
        if (typeof event.data !== 'string') { clearTimeout(timer); reject(new Error('Unexpected frame before reservation')); return; }
        try {
          const response = JSON.parse(event.data);
          if (response.type === 'error') throw new Error(response.message);
          if (response.type !== 'reservation') throw new Error('Expected a reservation');
          // Installs the room's DataChannel handler synchronously before the first binary handshake.
          void new SpikeSeatClient(this.channel).consumeSeatReservation(response.reservation as SeatReservation)
            .then((room) => { clearTimeout(timer); this.room = room; this.record(room); resolve(room); }, (error) => { clearTimeout(timer); reject(error); });
        } catch (error) { clearTimeout(timer); this.close(); reject(error); }
      };
      this.channel.onclose = () => { clearTimeout(timer); reject(new Error('Direct channel closed during reservation')); };
    });
    this.channel.send(JSON.stringify({ type: 'join', roomId: roomId.trim(), name }));
    return joined;
  }

  async report(): Promise<object> {
    const stats: object[] = [];
    (await this.peer.getStats()).forEach((stat) => {
      if (['candidate-pair', 'local-candidate', 'remote-candidate', 'data-channel', 'transport'].includes(stat.type)) stats.push(stat);
    });
    const rtts = this.samples.map((sample) => sample.rttMs).sort((a, b) => a - b);
    return { phase: 0, path: 'direct-reliable-ordered', startedAt: this.startedAt, endedAt: new Date().toISOString(),
      gate: 'PENDING real cross-network full match and same-pair relay comparison',
      count: rtts.length, medianMs: rtts[Math.floor(rtts.length / 2)] ?? null,
      p95Ms: rtts[Math.floor(rtts.length * 0.95)] ?? null, maxMs: rtts.at(-1) ?? null,
      stallSamplesOver1000Ms: rtts.filter((rtt) => rtt >= 1000).length, samples: this.samples, stats };
  }

  close(): void { this.channel.close(); this.peer.close(); }
  private record(room: Room): void {
    room.onMessage('pong', (pong: { clientTimeMs: number; loopP95Ms?: number; outBufferedB?: number }) => {
      const rttMs = Date.now() - pong.clientTimeMs;
      if (!Number.isFinite(rttMs) || rttMs < 0 || document.visibilityState !== 'visible') return;
      if (this.samples.length >= 3600) this.samples.shift();
      this.samples.push({ at: Date.now(), rttMs, serverLoopP95Ms: pong.loopP95Ms, serverBuffer: pong.outBufferedB, clientBuffer: this.channel.bufferedAmount });
    });
  }
}

/** Only the dedicated experimental page calls this. Ordinary site bundles never import it. */
export function installSpikeJoin(spike: BrowserSpike): void {
  Client.prototype.joinById = ((roomId: string, options: { name?: string } = {}) =>
    spike.join(roomId, options.name ?? 'Guest')) as Client['joinById'];
}
