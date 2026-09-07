"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectHostPeers = void 0;
const core_1 = require("@colyseus/core");
const ws_transport_1 = require("@colyseus/ws-transport");
const werift_1 = require("werift");
const directTransport_1 = require("../../../shared/directTransport");
const relayTunnel_1 = require("../../../shared/relayTunnel");
const DataChannelClient_1 = require("./DataChannelClient");
/** Host-only WebRTC peers. The public server and broker do not interpret this protocol. */
class DirectHostPeers {
    options;
    peers = new Map();
    constructor(options) {
        this.options = options;
    }
    open(id) {
        if (this.peers.has(id))
            return;
        if (!this.options.roomId() || this.peers.size >= 16) {
            this.options.closeSignal(id);
            return;
        }
        const peer = new HostPeer(id, this.options, () => this.peers.delete(id));
        this.peers.set(id, peer);
    }
    signal(id, payload) { this.peers.get(id)?.signal(payload); }
    signalClosed(id) { this.peers.get(id)?.signalClosed(); }
    close() { for (const peer of [...this.peers.values()])
        peer.close(); }
}
exports.DirectHostPeers = DirectHostPeers;
class HostPeer {
    id;
    options;
    removed;
    peer;
    raw;
    channel;
    closed = false;
    offered = false;
    received = 0;
    chain = Promise.resolve();
    deadline;
    constructor(id, options, removed) {
        this.id = id;
        this.options = options;
        this.removed = removed;
        this.peer = new werift_1.RTCPeerConnection({ iceServers: (options.stunUrls ?? directTransport_1.DIRECT_STUN).map(urls => ({ urls })) });
        this.deadline = setTimeout(() => this.close(), 20_000);
        this.deadline.unref();
        this.peer.onIceCandidate.subscribe(candidate => {
            if (!this.closed && candidate)
                options.send(id, JSON.stringify({ type: 'candidate', candidate: candidate.toJSON() }));
        });
        this.peer.connectionStateChange.subscribe(state => {
            if (state === 'failed' || state === 'closed')
                this.close();
        });
        this.peer.onDataChannel.subscribe(channel => {
            if (this.closed || this.channel || channel.label !== directTransport_1.DIRECT_CHANNEL || !channel.ordered
                || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
                channel.close();
                return;
            }
            this.channel = channel;
            channel.stateChange.subscribe(state => { if (state === 'closed')
                this.close(); });
            const first = channel.onMessage.subscribe(data => {
                first.unSubscribe();
                void this.join(channel, data).catch(() => this.close());
            });
        });
    }
    signal(payload) {
        if (this.closed)
            return;
        if (Buffer.byteLength(payload) > relayTunnel_1.SIGNAL_MAX_BYTES || ++this.received > relayTunnel_1.SIGNAL_MAX_FRAMES) {
            this.close();
            return;
        }
        this.chain = this.chain.then(async () => {
            if (this.closed)
                return;
            const message = JSON.parse(payload);
            if (message?.type === 'offer' && typeof message.sdp === 'string' && !this.offered) {
                this.offered = true;
                await this.peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
                if (this.closed)
                    return;
                const answer = await this.peer.createAnswer();
                // werift awaits STUN gathering here. Trickle candidates while it runs, so a slow STUN
                // server cannot hold the answer (and every subsequent candidate) beyond the 5s budget.
                void this.peer.setLocalDescription(answer).catch(() => this.close());
                if (!this.options.send(this.id, JSON.stringify({ type: 'answer', sdp: answer.sdp })))
                    this.close();
            }
            else if (message?.type === 'candidate' && this.offered && message.candidate
                && typeof message.candidate.candidate === 'string') {
                await this.peer.addIceCandidate(message.candidate);
            }
            else
                throw new Error('Invalid direct signaling');
        }).catch(() => this.close());
    }
    signalClosed() {
        // Signaling ends once the channel opens; an established match does not depend on the broker.
        if (this.channel?.readyState !== 'open')
            this.close();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearTimeout(this.deadline);
        this.raw?.close(relayTunnel_1.RELAY_CLOSE.disconnected, 'Host disconnected');
        this.options.closeSignal(this.id);
        this.removed();
        void this.peer.close().catch(() => undefined);
    }
    async join(channel, data) {
        if (this.closed || typeof data !== 'string' || data.length > 4096)
            throw new Error('Invalid join');
        const join = JSON.parse(data);
        if (join?.type !== 'join' || ![join.roomId, join.sessionId, join.processId].every(value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value)) || join.roomId !== this.options.roomId())
            throw new Error('Invalid seat');
        const room = core_1.matchMaker.getLocalRoomById(join.roomId);
        if (!room || core_1.matchMaker.processId !== join.processId || !room.hasReservedSeat(join.sessionId))
            throw new Error('Expired seat');
        this.raw = new DataChannelClient_1.DataChannelClient(channel, () => this.close());
        const client = new ws_transport_1.WebSocketClient(join.sessionId, this.raw);
        await (0, core_1.connectClientToRoom)(room, client, { headers: new Headers(), ip: 'direct-peer' }, {});
        clearTimeout(this.deadline);
    }
}
