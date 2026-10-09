// registry.js - turns raw JSON documents into an indexed, read-only registry.
//
// Pure: takes already-parsed objects, returns lookups. No fetch, no DOM, no
// globals - so the same function serves the browser and the headless test
// runner, and it is a direct translation target for a Godot/Unity resource
// loader later on.

export function makeRegistry({ rules, arena, parts, robots = [], index = null, league = null, economy = null, matchups = null, arenas = null }) {
  const partsById = new Map();
  for (const p of parts.parts) {
    if (partsById.has(p.id)) throw new Error(`duplicate part id: ${p.id}`);
    partsById.set(p.id, Object.freeze(p));
  }

  const partsByCategory = new Map();
  for (const c of parts.categories) partsByCategory.set(c, []);
  for (const p of parts.parts) {
    if (!partsByCategory.has(p.category)) partsByCategory.set(p.category, []);
    partsByCategory.get(p.category).push(p);
  }

  const robotsById = new Map();
  for (const r of robots) {
    if (robotsById.has(r.id)) throw new Error(`duplicate robot id: ${r.id}`);
    robotsById.set(r.id, Object.freeze(r));
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    arena: Object.freeze(arena),
    partsDoc: Object.freeze(parts),
    // Season formats and money (Stage 5). Optional so a bare test registry builds.
    league,
    economy,
    // Weapon class vs weapon class in physics (data/matchups.json), for the advisor.
    matchups,
    // Hazard layouts and the venues round the box (js/logic/arenas.js).
    arenas,

    part(id) {
      const p = partsById.get(id);
      if (!p) throw new Error(`unknown part id: ${id}`);
      return p;
    },
    hasPart: (id) => partsById.has(id),
    partsIn: (category) => (partsByCategory.get(category) || []).slice(),
    allParts: () => [...partsById.values()],

    robot(id) {
      const r = robotsById.get(id);
      if (!r) throw new Error(`unknown robot id: ${id}`);
      return r;
    },
    hasRobot: (id) => robotsById.has(id),
    /**
     * Add a robot made during a career (a new team joining the field - see
     * js/logic/field.js). The data files never change; a career registers
     * its own robots whenever it is loaded. Re-adding the same id replaces it.
     */
    addRobot(def) { robotsById.set(def.id, Object.freeze({ ...def })); return def; },
    allRobots: () => [...robotsById.values()],
    /** The league field: every robot in the index's roster (the player's included). */
    roster: () => (index ? index.roster : [...robotsById.keys()]).filter((id) => robotsById.has(id)).map((id) => robotsById.get(id)),
    /** Id of the player's robot. */
    playerId: index?.player ?? "player_default",

    hazard: (id) => arena.hazards.find((h) => h.id === id) || null,
    cameraDef: (id) => arena.cameras.find((c) => c.id === id) || null,
    spawn: (id) => arena.spawns.find((s) => s.id === id) || null,
  });
}
