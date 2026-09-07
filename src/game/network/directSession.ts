import { Room } from '@colyseus/sdk';
import type { ITransport, ITransportEventMap } from '@colyseus/sdk/build/transport/ITransport';
import { HostSessionClient } from './hostSession';
import { DIRECT_CHANNEL, DIRECT_CONNECT_MS, DIRECT_DEAD_MS, DIRECT_MAX_FRAME, DIRECT_STUN, type ConnectionPath } from '../../../shared/directTransport';
import { RELAY_CLOSE, RELAY_ERRORS, SIGNAL_MAX_BYTES, SIGNAL_MAX_FRAMES } from '../../../shared/relayTunnel';

const paths = new WeakMap<Room, ConnectionPath>();
export function roomConnectionPath(room: Room): ConnectionPath | undefined { return paths.get(room); }

export interface DirectLink { peer: RTCPeerConnection; channel: RTCDataChannel; close: () => void }

/** Reliable transport only: tiered snapshots must not be put on a lossy channel. */
export class WebRTCTransport implements ITransport {
  private ended = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastMessageAt = Date.now();
  constructor(readonly link: DirectLink, readonly events: ITransportEventMap) {}
  get isOpen(): boolean { return !this.ended && this.link.channel.readyState === 'open'; }
  get ws(): { readyState: number; bufferedAmount: number } {
    return { readyState: this.isOpen ? 1 : 3, bufferedAmount: this.link.channel.bufferedAmount };
  }
  connect(endpoint: string): void {
    const channel = this.link.channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = event => {
      if (this.ended) return;
      this.lastMessageAt = Date.now();
      try {
        if (typeof event.data === 'string') {
          if (event.data === '{"type":"alive"}') { channel.send(event.data); return; }
          if (event.data.length > 512) throw new Error('Invalid control frame');
          const notice = JSON.parse(event.data);
          if (notice?.type !== 'closed' || !Number.isInteger(notice.code) || typeof notice.reason !== 'string') throw new Error('Invalid close');
          this.close(notice.code, notice.reason);
        } else {
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > DIRECT_MAX_FRAME) throw new Error('Invalid binary frame');
          this.events.onmessage?.(event);
        }
      } catch { this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected); }
    };
    channel.onclose = () => this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected);
    channel.onerror = () => this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected);
    this.link.peer.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.link.peer.connectionState)) this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected);
    };
    if (!this.isOpen) { this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected); return; }
    this.timer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > DIRECT_DEAD_MS) this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected);
    }, 1000);
    const url = new URL(endpoint);
    const segments = url.pathname.split('/');
    try {
      channel.send(JSON.stringify({ type: 'join', processId: segments[segments.length - 2], roomId: segments[segments.length - 1], sessionId: url.searchParams.get('sessionId') }));
      this.events.onopen?.({});
    } catch { this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected); }
  }
  send(data: Uint8Array): void {
    if (!this.isOpen) return;
    try {
      if (this.link.channel.bufferedAmount + data.byteLength > DIRECT_MAX_FRAME) throw new Error('Send backlog');
      // SDK buffers are reused after send; copy before SCTP takes ownership.
      this.link.channel.send(new Uint8Array(data));
    } catch { this.close(RELAY_CLOSE.disconnected, RELAY_ERRORS.disconnected); }
  }
  sendUnreliable(data: Uint8Array): void { this.send(data); }
  close(code = 1000, reason = ''): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.link.close();
    this.events.onclose?.({ code, reason });
  }
}

/** SDK coupling is confined here and guarded by a pinned-version compatibility test. */
export class DirectRoom<T = any> extends Room<any, T> {
  constructor(name: string, private readonly link: DirectLink) { super(name); }
  override connect(endpoint: string): void {
    this.reconnection.enabled = false;
    const events: ITransportEventMap = {
      onmessage: event => this.onMessageCallback(event),
      onclose: event => {
        if (this.joinedAtTime === 0) this.onError.invoke(event.code, event.reason);
        else this.onLeave.invoke(event.code, event.reason);
      },
      onerror: event => this.onError.invoke(event.code, event.reason)
    };
    const transport = new WebRTCTransport(this.link, events);
    this.connection = {
      transport, events, get isOpen() { return transport.isOpen; },
      send: (data: Uint8Array) => transport.send(data), sendUnreliable: (data: Uint8Array) => transport.sendUnreliable(data),
      close: (code?: number, reason?: string) => transport.close(code, reason), connect: (url: string) => transport.connect(url)
    } as unknown as Room['connection'];
    transport.connect(endpoint);
  }
}

class DirectSeatClient extends HostSessionClient {
  constructor(endpoint: string, signal: AbortSignal, private readonly link: DirectLink) { super(endpoint, signal); }
  protected override createRoom<T>(name: string): Room<any, T> { return new DirectRoom<T>(name, this.link); }
}

/** Try ICE before matchmaking: fallback reserves exactly one seat using the unchanged relay path. */
export async function joinPrivateHost(endpoint: string, code: string, name: string, signal: AbortSignal,
  options: { relayOnly?: boolean; stunUrls?: string[]; timeoutMs?: number } = {}): Promise<Room> {
  const hostEndpoint = `${endpoint.replace(/\/$/, '')}/relay/${code}`;
  let link: DirectLink | null = null;
  if (!options.relayOnly && typeof RTCPeerConnection !== 'undefined') {
    try { link = await negotiateDirect(hostEndpoint, signal, options); }
    catch { /* Direct failure before reserving a seat safely selects the byte relay. */ }
  }
  if (signal.aborted) { link?.close(); throw new Error(RELAY_ERRORS.unreachable); }
  try {
    const client = link ? new DirectSeatClient(hostEndpoint, signal, link) : new HostSessionClient(hostEndpoint, signal);
    const room = await client.joinById(code, { name });
    paths.set(room, link ? 'direct' : 'relay');
    return room;
  } catch (error) { link?.close(); throw error; }
}

export function negotiateDirect(endpoint: string, signal: AbortSignal,
  options: { stunUrls?: string[]; timeoutMs?: number } = {}): Promise<DirectLink> {
  return new Promise((resolve, reject) => {
    const peer = new RTCPeerConnection({ iceServers: (options.stunUrls ?? DIRECT_STUN).map(urls => ({ urls })) });
    const channel = peer.createDataChannel(DIRECT_CHANNEL, { ordered: true });
    const socket = new WebSocket(`${endpoint}/signal`);
    let settled = false;
    let offered = false;
    let answered = false;
    let received = 0;
    const outgoing: RTCIceCandidateInit[] = [];
    const incoming: RTCIceCandidateInit[] = [];
    let chain = Promise.resolve();
    const close = () => { channel.close(); peer.close(); };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      peer.onicecandidate = null;
      socket.close();
      if (ok) resolve({ peer, channel, close });
      else { close(); reject(new Error('Direct negotiation unavailable')); }
    };
    const aborted = () => finish(false);
    const timer = setTimeout(aborted, options.timeoutMs ?? DIRECT_CONNECT_MS);
    const send = (payload: object) => {
      if (!settled && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { finish(false); return; }
    channel.onopen = () => finish(true);
    channel.onclose = () => finish(false);
    channel.onerror = () => finish(false);
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
    peer.onicecandidate = event => {
      if (!event.candidate) return;
      if (offered) send({ type: 'candidate', candidate: event.candidate.toJSON() });
      else outgoing.push(event.candidate.toJSON());
    };
    socket.onopen = () => {
      void (async () => {
        await peer.setLocalDescription(await peer.createOffer());
        if (settled) return;
        send({ type: 'offer', sdp: peer.localDescription!.sdp });
        offered = true;
        for (const candidate of outgoing) send({ type: 'candidate', candidate });
        outgoing.length = 0;
      })().catch(() => finish(false));
    };
    socket.onmessage = event => {
      if (settled) return;
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > SIGNAL_MAX_BYTES
        || ++received > SIGNAL_MAX_FRAMES) { finish(false); return; }
      chain = chain.then(async () => {
        if (settled) return;
        const message = JSON.parse(event.data);
        if (message?.type === 'answer' && !answered && typeof message.sdp === 'string') {
          answered = true;
          await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          for (const candidate of incoming) await peer.addIceCandidate(candidate);
          incoming.length = 0;
        } else if (message?.type === 'candidate' && typeof message.candidate?.candidate === 'string') {
          if (answered) await peer.addIceCandidate(message.candidate);
          else incoming.push(message.candidate);
        } else throw new Error('Invalid direct signal');
      }).catch(() => finish(false));
    };
  });
}
