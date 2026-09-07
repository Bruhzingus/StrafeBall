import { connectClientToRoom, matchMaker } from '@colyseus/core';
import { WebSocketClient } from '@colyseus/ws-transport';
import type WebSocket from 'ws';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { DIRECT_CHANNEL, DIRECT_STUN } from '../../../shared/directTransport';
import { RELAY_CLOSE, SIGNAL_MAX_BYTES, SIGNAL_MAX_FRAMES } from '../../../shared/relayTunnel';
import { DataChannelClient } from './DataChannelClient';

interface Options {
  roomId: () => string | null;
  send: (id: string, payload: string) => boolean;
  closeSignal: (id: string) => void;
  stunUrls?: string[];
}

/** Host-only WebRTC peers. The public server and broker do not interpret this protocol. */
export class DirectHostPeers {
  private readonly peers = new Map<string, HostPeer>();
  constructor(private readonly options: Options) {}
  open(id: string): void {
    if (this.peers.has(id)) return;
    if (!this.options.roomId() || this.peers.size >= 16) { this.options.closeSignal(id); return; }
    const peer = new HostPeer(id, this.options, () => this.peers.delete(id));
    this.peers.set(id, peer);
  }
  signal(id: string, payload: string): void { this.peers.get(id)?.signal(payload); }
  signalClosed(id: string): void { this.peers.get(id)?.signalClosed(); }
  close(): void { for (const peer of [...this.peers.values()]) peer.close(); }
}

class HostPeer {
  private readonly peer: RTCPeerConnection;
  private raw?: DataChannelClient;
  private channel?: RTCDataChannel;
  private closed = false;
  private offered = false;
  private received = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly deadline: NodeJS.Timeout;
  constructor(private readonly id: string, private readonly options: Options, private readonly removed: () => void) {
    this.peer = new RTCPeerConnection({ iceServers: (options.stunUrls ?? DIRECT_STUN).map(urls => ({ urls })) });
    this.deadline = setTimeout(() => this.close(), 20_000);
    this.deadline.unref();
    this.peer.onIceCandidate.subscribe(candidate => {
      if (!this.closed && candidate) options.send(id, JSON.stringify({ type: 'candidate', candidate: candidate.toJSON() }));
    });
    this.peer.connectionStateChange.subscribe(state => {
      if (state === 'failed' || state === 'closed') this.close();
    });
    this.peer.onDataChannel.subscribe(channel => {
      if (this.closed || this.channel || channel.label !== DIRECT_CHANNEL || !channel.ordered
        || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { channel.close(); return; }
      this.channel = channel;
      channel.stateChange.subscribe(state => { if (state === 'closed') this.close(); });
      const first = channel.onMessage.subscribe(data => {
        first.unSubscribe();
        void this.join(channel, data).catch(() => this.close());
      });
    });
  }
  signal(payload: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(payload) > SIGNAL_MAX_BYTES || ++this.received > SIGNAL_MAX_FRAMES) { this.close(); return; }
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      const message = JSON.parse(payload);
      if (message?.type === 'offer' && typeof message.sdp === 'string' && !this.offered) {
        this.offered = true;
        await this.peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        if (this.closed) return;
        const answer = await this.peer.createAnswer();
        // werift awaits STUN gathering here. Trickle candidates while it runs, so a slow STUN
        // server cannot hold the answer (and every subsequent candidate) beyond the 5s budget.
        void this.peer.setLocalDescription(answer).catch(() => this.close());
        if (!this.options.send(this.id, JSON.stringify({ type: 'answer', sdp: answer.sdp }))) this.close();
      } else if (message?.type === 'candidate' && this.offered && message.candidate
        && typeof message.candidate.candidate === 'string') {
        await this.peer.addIceCandidate(message.candidate);
      } else throw new Error('Invalid direct signaling');
    }).catch(() => this.close());
  }
  signalClosed(): void {
    // Signaling ends once the channel opens; an established match does not depend on the broker.
    if (this.channel?.readyState !== 'open') this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.deadline);
    this.raw?.close(RELAY_CLOSE.disconnected, 'Host disconnected');
    this.options.closeSignal(this.id);
    this.removed();
    void this.peer.close().catch(() => undefined);
  }
  private async join(channel: RTCDataChannel, data: string | Buffer): Promise<void> {
    if (this.closed || typeof data !== 'string' || data.length > 4096) throw new Error('Invalid join');
    const join = JSON.parse(data);
    if (join?.type !== 'join' || ![join.roomId, join.sessionId, join.processId].every(value =>
      typeof value === 'string' && /^[\w-]{1,64}$/.test(value)) || join.roomId !== this.options.roomId()) throw new Error('Invalid seat');
    const room = matchMaker.getLocalRoomById(join.roomId);
    if (!room || matchMaker.processId !== join.processId || !room.hasReservedSeat(join.sessionId)) throw new Error('Expired seat');
    this.raw = new DataChannelClient(channel, () => this.close());
    const client = new WebSocketClient(join.sessionId, this.raw as unknown as WebSocket);
    await connectClientToRoom(room, client, { headers: new Headers(), ip: 'direct-peer' }, {});
    clearTimeout(this.deadline);
  }
}
