"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataChannelClient = void 0;
const node_events_1 = require("node:events");
const directTransport_1 = require("../../../shared/directTransport");
const relayTunnel_1 = require("../../../shared/relayTunnel");
/** Raw client surface consumed by Colyseus WebSocketClient; gameplay bytes stay untouched. */
class DataChannelClient extends node_events_1.EventEmitter {
    channel;
    release;
    pingCount = 0;
    ended = false;
    lastAlive = Date.now();
    timer;
    constructor(channel, release) {
        super();
        this.channel = channel;
        this.release = release;
        this.on('error', () => undefined);
        channel.onMessage.subscribe((data) => {
            if (this.ended)
                return;
            this.lastAlive = Date.now();
            if (typeof data === 'string') {
                if (data === '{"type":"alive"}')
                    return;
                this.close(1002, 'Invalid control frame');
                return;
            }
            if (data.length > directTransport_1.DIRECT_MAX_FRAME) {
                this.close(1009, 'Frame too large');
                return;
            }
            this.emit('message', data);
        });
        channel.stateChange.subscribe((state) => {
            if (state === 'closed')
                this.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Direct connection closed');
        });
        channel.error.subscribe((error) => { this.emit('error', error); this.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Direct connection failed'); });
        this.timer = setInterval(() => {
            if (Date.now() - this.lastAlive > directTransport_1.DIRECT_DEAD_MS) {
                this.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Direct connection timed out');
                return;
            }
            try {
                if (this.readyState === 1)
                    channel.send('{"type":"alive"}');
            }
            catch {
                this.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Direct connection failed');
            }
        }, directTransport_1.DIRECT_HEARTBEAT_MS);
        this.timer.unref();
    }
    get readyState() { return this.ended ? 3 : ({ connecting: 0, open: 1, closing: 2, closed: 3 })[this.channel.readyState]; }
    get bufferedAmount() { return this.channel.bufferedAmount; }
    send(data, _options, callback) {
        let failure;
        try {
            if (this.readyState !== 1 || data.byteLength + this.bufferedAmount > directTransport_1.DIRECT_MAX_FRAME)
                throw new Error('Direct channel unavailable or congested');
            this.channel.send(Buffer.from(data));
        }
        catch (error) {
            failure = error;
        }
        if (failure)
            this.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Direct connection failed');
        callback?.(failure);
    }
    close(code = 1000, reason = '') {
        if (this.ended)
            return;
        this.ended = true;
        clearInterval(this.timer);
        try {
            if (this.channel.readyState === 'open')
                this.channel.send(JSON.stringify({ type: 'closed', code, reason: String(reason).slice(0, 120) }));
        }
        catch { /* Disconnect still releases the seat when SCTP is already gone. */ }
        this.emit('close', code, Buffer.from(String(reason)));
        const flush = setTimeout(this.release, 100);
        flush.unref();
    }
}
exports.DataChannelClient = DataChannelClient;
