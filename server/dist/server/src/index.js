"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = void 0;
const colyseus_1 = require("colyseus");
const DuelRoom_1 = require("./rooms/DuelRoom");
const DEFAULT_PORT = 2567;
function readPort() {
    const raw = process.env.PORT ?? process.env.COLYSEUS_PORT;
    if (!raw)
        return DEFAULT_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}
exports.server = (0, colyseus_1.defineServer)({
    rooms: {
        duel: (0, colyseus_1.defineRoom)(DuelRoom_1.DuelRoom)
    }
});
const port = readPort();
void exports.server.listen(port).then(() => {
    console.log(`Strafeball Colyseus server listening on ws://localhost:${port}`);
    console.log('Create a private room with client.create("duel", { name }) and join by roomId with client.joinById(roomId, { name }).');
});
