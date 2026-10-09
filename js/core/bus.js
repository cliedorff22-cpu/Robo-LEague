// bus.js - a tiny publish/subscribe event bus.
//
// This is the seam that keeps logic from knowing rendering exists. The match
// and damage systems emit facts ("hit", "partFailed", "immobilized"); the
// renderer, HUD and audio subscribe. Swapping Three.js for a Godot scene tree
// later means rewriting only the subscribers.

export function makeBus() {
  const handlers = new Map();

  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);   // unsubscribe
    },

    emit(type, payload) {
      const set = handlers.get(type);
      if (set) for (const fn of set) fn(payload);
      const any = handlers.get("*");
      if (any) for (const fn of any) fn({ type, payload });
    },

    clear() { handlers.clear(); },
  };
}

// Event names used so far. Kept central so typos surface as missing constants
// instead of silently-never-fired strings.
export const EV = {
  DATA_LOADED: "data:loaded",
  MATCH_STATE: "match:state",       // { phase, clockS }
  HAZARD_FIRE: "hazard:fire",       // { id, type }
  BOT_RESET: "bot:reset",           // { botId }
  CAMERA_CHANGED: "camera:changed", // { id, label }
  REPLAY_START: "replay:start",
  REPLAY_END: "replay:end",
  CONTROL_CHANGED: "control:changed", // { botId, pilot: "human" | "ai" }

  // Stage 2. The render layer subscribes to these for sparks, dents and
  // auto-replays; the logic layer never needs to know anyone is listening.
  HIT: "combat:hit",               // { attackerId, defenderId, targetKey, severity, hits }
  PART_FAILED: "combat:partFailed",// { botId, key, name, category }
  WEAPON_STATE: "weapon:state",    // { botId, phase, spinPct }

  // Stage 4: the referee and the result.
  REF_COUNT: "ref:count",          // { botId, count, of }
  KO: "ref:ko",                    // { botId }
  TAP_OUT: "ref:tapOut",           // { botId }
  PIN_WARNING: "ref:pinWarning",   // { botId (the pinner), pinnedId }
  PIN_PENALTY: "ref:pinPenalty",   // { botId, pinnedId }
  SEPARATE: "ref:separate",        // { a, b } - two robots locked together, pulled apart
  MATCH_END: "match:end",          // the full result - see logic/match.js
};
