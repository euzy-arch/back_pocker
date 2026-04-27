import { createRoomEngine } from "./room-engine.js";
const map = new Map();
export function getOrCreateRoom(tournamentId) {
    let r = map.get(tournamentId);
    if (!r) {
        r = createRoomEngine(tournamentId);
        map.set(tournamentId, r);
    }
    return r;
}
export function getRoom(tournamentId) {
    return map.get(tournamentId);
}
export function allRooms() {
    return map.values();
}
