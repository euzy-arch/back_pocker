import { createRoomEngine, type RoomEngine } from "./room-engine.js";

const map = new Map<number, RoomEngine>();

export function getOrCreateRoom(tournamentId: number): RoomEngine {
  let r = map.get(tournamentId);
  if (!r) {
    r = createRoomEngine(tournamentId);
    map.set(tournamentId, r);
  }
  return r;
}

export function getRoom(tournamentId: number): RoomEngine | undefined {
  return map.get(tournamentId);
}

export function allRooms(): IterableIterator<RoomEngine> {
  return map.values();
}
