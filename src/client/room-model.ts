import { DEFAULT_ROOM_SPEC, roomFromSpec, type RoomModel, type RoomSpec } from '../shared/room';

// The page draws one room at a time: the measured room of the design on screen (the sample room until one is set).
let current: RoomModel = roomFromSpec(DEFAULT_ROOM_SPEC);
let currentKey = JSON.stringify(DEFAULT_ROOM_SPEC);
export function roomModel(): RoomModel { return current; }
/** Switches the drawn room. True when the size changed, so the walls must be built again. */
export function setRoomSpec(spec: RoomSpec | undefined): boolean {
  const key = JSON.stringify(spec ?? DEFAULT_ROOM_SPEC);
  if (key === currentKey) return false;
  currentKey = key; current = roomFromSpec(spec ?? DEFAULT_ROOM_SPEC);
  return true;
}
