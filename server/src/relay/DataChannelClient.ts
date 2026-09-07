import { EventEmitter } from 'node:events';
import type { RTCDataChannel } from 'werift';
import { DIRECT_DEAD_MS, DIRECT_HEARTBEAT_MS, DIRECT_MAX_FRAME } from '../../../shared/directTransport';
import { RELAY_CLOSE } from '../../../shared/relayTunnel';

/** Raw client surface consumed by Colyseus WebSocketClient; gameplay bytes stay untouched. */
export class DataChannelClient extends EventEmitter {
  pingCount = 0;
  private ended = false;
  private lastAlive = Date.now();
  private readonly timer: NodeJS.Timeout;
  constructor(readonly channel: RTCDataChannel, private readonly release: () => void) {
    super();
    this.on('error', () => undefined);
    channel.onMessage.subscribe((data) => {
      if (this.ended) return;
      this.lastAlive = Date.now();
      if (typeof data === 'string') {
        if (data === '{"type":"alive"}') return;
        this.close(1002, 'Invalid control frame'); return;
      }
      if (data.length > DIRECT_MAX_FRAME) { this.close(1009, 'Frame too large'); return; }
      this.emit('message', data);
    });
    channel.stateChange.subscribe((state) => {
      if (state === 'closed') this.close(RELAY_CLOSE.disconnected, 'Direct connection closed');
    });
    channel.error.subscribe((error) => { this.emit('error', error); this.close(RELAY_CLOSE.disconnected, 'Direct connection failed'); });
    this.timer = setInterval(() => {
      if (Date.now() - this.lastAlive > DIRECT_DEAD_MS) { this.close(RELAY_CLOSE.disconnected, 'Direct connection timed out'); return; }
      try { if (this.readyState === 1) channel.send('{"type":"alive"}'); }
      catch { this.close(RELAY_CLOSE.disconnected, 'Direct connection failed'); }
    }, DIRECT_HEARTBEAT_MS);
    this.timer.unref();
  }
  get readyState(): number { return this.ended ? 3 : ({ connecting: 0, open: 1, closing: 2, closed: 3 })[this.channel.readyState]; }
  get bufferedAmount(): number { return this.channel.bufferedAmount; }
  send(data: Uint8Array, _options?: unknown, callback?: (error?: Error) => void): void {
    let failure: Error | undefined;
    try {
      if (this.readyState !== 1 || data.byteLength + this.bufferedAmount > DIRECT_MAX_FRAME) throw new Error('Direct channel unavailable or congested');
      this.channel.send(Buffer.from(data));
    } catch (error) { failure = error as Error; }
    if (failure) this.close(RELAY_CLOSE.disconnected, 'Direct connection failed');
    callback?.(failure);
  }
  close(code = 1000, reason = ''): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    try { if (this.channel.readyState === 'open') this.channel.send(JSON.stringify({ type: 'closed', code, reason: String(reason).slice(0, 120) })); }
    catch { /* Disconnect still releases the seat when SCTP is already gone. */ }
    this.emit('close', code, Buffer.from(String(reason)));
    const flush = setTimeout(this.release, 100);
    flush.unref();
  }
}
