"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIRECT_STUN = exports.DIRECT_DEAD_MS = exports.DIRECT_HEARTBEAT_MS = exports.DIRECT_MAX_FRAME = exports.DIRECT_CONNECT_MS = exports.DIRECT_CHANNEL = void 0;
/** The broker only forwards these as opaque strings; peers own this protocol. */
exports.DIRECT_CHANNEL = 'strafeball-reliable-v1';
exports.DIRECT_CONNECT_MS = 5000;
exports.DIRECT_MAX_FRAME = 1024 * 1024;
exports.DIRECT_HEARTBEAT_MS = 2000;
exports.DIRECT_DEAD_MS = 10_000;
exports.DIRECT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
