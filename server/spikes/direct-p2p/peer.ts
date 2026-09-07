// Phase 0 only. Not imported by the production server or included in its build.
import { EventEmitter } from 'node:events';
import { connectClientToRoom, matchMaker } from '@colyseus/core';
import { WebSocketClient } from '@colyseus/ws-transport';
import { RTCDataChannel, RTCPeerConnection, type RTCSessionDescriptionInit } from 'werift';
import type WebSocket from 'ws';

const MAX_FRAME = 1024 * 1024;

/** Minimal raw WebSocket surface consumed by the existing Colyseus WebSocketClient. */
export class SpikeRawClient extends EventEmitter {
  pingCount = 0;
  private ended = false;
  constructor(readonly channel: RTCDataChannel, private readonly peer: RTCPeerConnection) {
    super();
    channel.onMessage.subscribe((data) => {
      if (this.ended) return;
      if (typeof data === 'string') { this.close(1002, 'Expected binary Colyseus frame'); return; }
      if (data.length > MAX_FRAME) { this.close(1009, 'Frame too large'); return; }
      this.emit('message', data);
    });
    channel.stateChange.subscribe((state) => { if (state === 'closed') this.close(1006, 'DataChannel closed'); });
    channel.error.subscribe((error) => { this.emit('error', error); this.close(1011, 'DataChannel error'); });
    this.on('error', () => undefined);
  }
  get readyState(): number { return this.ended ? 3 : ({ connecting: 0, open: 1, closing: 2, closed: 3 })[this.channel.readyState]; }
  get bufferedAmount(): number { return this.channel.bufferedAmount; }
  send(data: Uint8Array, _options?: unknown, callback?: (error?: Error) => void): void {
    try {
      if (this.readyState !== 1) throw new Error('DataChannel is not open');
      if (this.bufferedAmount + data.byteLength > MAX_FRAME) throw new Error('DataChannel backlog exceeded');
      this.channel.send(Buffer.from(data));
      callback?.();
    } catch (error) {
      callback?.(error as Error);
      this.close(1011, 'DataChannel send failed');
    }
  }
  close(code = 1000, reason = ''): void {
    if (this.ended) return;
    // Text messages are reserved for spike control, never confused with binary game frames.
    try {
      if (this.channel.readyState === 'open') this.channel.send(JSON.stringify({ type: 'closed', code, reason }));
    } catch { /* A failed channel still needs to release its Colyseus seat. */ }
    this.finish(code, reason);
    // Give the ordered close notice a chance to flush before tearing down SCTP.
    const timer = setTimeout(() => { void this.peer.close(); }, 100);
    timer.unref();
  }
  private finish(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('close', code, Buffer.from(reason));
  }
}

export class SpikePeer {
  readonly peer: RTCPeerConnection;
  private accepted = false;
  private raw?: SpikeRawClient;
  private readonly deadline: NodeJS.Timeout;

  constructor(stunUrls: string[] = ['stun:stun.l.google.com:19302']) {
    this.peer = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })) });
    this.deadline = setTimeout(() => { void this.close(); }, 5 * 60_000);
    this.deadline.unref();
    this.peer.onDataChannel.subscribe((channel) => {
      if (this.accepted || channel.label !== 'colyseus-spike' || !channel.ordered
        || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { channel.close(); return; }
      this.accepted = true;
      const subscription = channel.onMessage.subscribe((data) => {
        subscription.unSubscribe();
        void this.join(channel, data).catch((error) => {
          console.error('[p2p spike] join failed:', error.message);
          if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'error', message: error.message }));
          void this.close();
        });
      });
    });
    this.peer.connectionStateChange.subscribe((state) => {
      console.log(`[p2p spike] peer ${state}`);
      if (state === 'failed' || state === 'closed') {
        this.raw?.close(1006, 'Peer disconnected');
        clearTimeout(this.deadline);
      }
    });
  }

  async answer(offer: RTCSessionDescriptionInit): Promise<{ type: 'answer'; sdp: string }> {
    if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length > 64 * 1024) throw new Error('Paste a complete SDP offer JSON.');
    await this.peer.setRemoteDescription(offer);
    await this.peer.setLocalDescription(await this.peer.createAnswer());
    return { type: 'answer', sdp: this.peer.localDescription!.sdp };
  }

  async close(): Promise<void> {
    clearTimeout(this.deadline);
    this.raw?.close(1000, 'Spike stopped');
    await this.peer.close();
  }

  private async join(channel: RTCDataChannel, data: string | Buffer): Promise<void> {
    if (typeof data !== 'string' || data.length > 4096) throw new Error('Expected spike join request');
    const request = JSON.parse(data);
    if (!request || request.type !== 'join' || typeof request.roomId !== 'string'
      || !/^[\w-]{1,64}$/.test(request.roomId) || typeof request.name !== 'string') throw new Error('Invalid room/name');
    // Reserve after manual signaling completes, avoiding Colyseus seat expiry while humans copy SDP.
    const reservation = await matchMaker.joinById(request.roomId, { name: request.name.slice(0, 24) });
    this.raw = new SpikeRawClient(channel, this.peer);
    const client = new WebSocketClient(reservation.sessionId, this.raw as unknown as WebSocket);
    channel.send(JSON.stringify({ type: 'reservation', reservation }));
    await connectClientToRoom(matchMaker.getLocalRoomById(reservation.roomId), client, {
      headers: new Headers(), ip: 'p2p-spike'
    }, {});
    clearTimeout(this.deadline);
    console.log(`[p2p spike] real DuelRoom joined: ${reservation.roomId}`);
  }
}
