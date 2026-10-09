// validate.js - data integrity checks, runnable headlessly.
//
// Stage 1 validates the part library, the arena and individual builds. The
// roster-wide checks the brief asks for (120 bots, 100 parody / 20 original,
// per-league skill ranges, duplicate names) are stubbed with their real shape
// so Stage 5 only has to fill the bodies, not redesign the reporting.

import { assembleRobot, assemblePartner, checkMultibotWeight } from "./build.js";
import { buildShape } from "./shape.js";
import { validateArenas } from "./arenas.js";

const LEAGUES = ["rookie", "pro", "elite", "world"];
const ARCHETYPES = [
  "spinner_h", "spinner_v", "drum", "flipper", "lifter",
  "hammer", "crusher", "wedge", "multibot",
];
const ORIGINS = ["parody", "original"];
const PERSONALITIES = ["aggressive", "defensive", "opportunistic"];

// Expected roster shape, from the brief. Stage 5 enforces these.
export const ROSTER_TARGET = {
  total: 120,
  parody: 100,
  original: 20,
  leagues: 4,
  perLeague: 30,
};

export function validatePartsDoc(doc) {
  const errors = [];
  const seen = new Set();

  for (const p of doc.parts) {
    const where = `part "${p.id}"`;
    if (seen.has(p.id)) errors.push(`${where}: duplicate id`);
    seen.add(p.id);

    if (!doc.categories.includes(p.category)) errors.push(`${where}: unknown category "${p.category}"`);
    if (!(p.weight > 0)) errors.push(`${where}: weight must be positive`);
    if (!(p.cost >= 0)) errors.push(`${where}: cost must be >= 0`);
    if (!(p.hp > 0)) errors.push(`${where}: hp must be positive`);
    if (!p.spec) errors.push(`${where}: missing spec block`);
    if (p.category === "armor" && !doc.armorSlots.includes(p.spec?.slot)) {
      errors.push(`${where}: armour slot "${p.spec?.slot}" is not one of ${doc.armorSlots.join(", ")}`);
    }
    if (p.category === "chassis" && !Array.isArray(p.spec?.sizeIn)) {
      errors.push(`${where}: chassis needs spec.sizeIn [L, H, W]`);
    }
  }
  return errors;
}

export function validateArena(arena) {
  const errors = [];
  if (!arena.floor?.size) errors.push("arena: missing floor.size");
  if (!arena.spawns?.length) errors.push("arena: no spawn points");
  if (!arena.cameras?.length) errors.push("arena: no camera definitions");

  const [fx, fz] = arena.floor.size;
  for (const s of arena.spawns) {
    if (Math.abs(s.pos[0]) > fx / 2 || Math.abs(s.pos[2]) > fz / 2) {
      errors.push(`arena: spawn "${s.id}" lies outside the floor`);
    }
  }
  const ids = new Set();
  const HAZARD_TYPES = ["screw", "hammer", "pulverizer", "killsaw", "pit"];
  for (const h of arena.hazards) {
    if (ids.has(h.id)) errors.push(`arena: duplicate hazard id "${h.id}"`);
    ids.add(h.id);
    if (!HAZARD_TYPES.includes(h.type)) {
      errors.push(`arena: hazard "${h.id}" has unknown type "${h.type}" (expected ${HAZARD_TYPES.join(", ")})`);
    }
    // Every hazard sits on the floor plan, so a typo in a coordinate should not
    // silently put a pulverizer outside the building.
    if (Math.abs(h.pos[0]) > fx / 2 + 2 || Math.abs(h.pos[2]) > fz / 2 + 2) {
      errors.push(`arena: hazard "${h.id}" is outside the arena at (${h.pos[0]}, ${h.pos[2]})`);
    }
  }

  // Killsaws share one config block; without it they have no geometry at all.
  const saws = arena.hazards.filter((h) => h.type === "killsaw");
  if (saws.length && !arena.killsaw) {
    errors.push(`arena: ${saws.length} killsaw(s) but no "killsaw" config block`);
  }
  if (arena.killsaw) {
    const k = arena.killsaw;
    const DEPLOY = ["rotating", "timed", "proximity"];
    if (!DEPLOY.includes(k.deploy)) {
      errors.push(`arena: killsaw.deploy must be one of ${DEPLOY.join(", ")}, got "${k.deploy}"`);
    }
    if ((k.deploy === "timed" || k.deploy === "rotating") && !(k.deployAtRemainingS > 0)) {
      errors.push(`arena: ${k.deploy} killsaws need a positive killsaw.deployAtRemainingS`);
    }
    if (k.deploy === "rotating" && saws.length) {
      if (!(k.rotateEveryS > 0)) errors.push("arena: rotating killsaws need a positive killsaw.rotateEveryS");
      if (!(k.activeCount >= 1 && k.activeCount <= saws.length)) {
        errors.push(`arena: killsaw.activeCount must be 1..${saws.length}, got ${k.activeCount}`);
      }
    }
    // Stowed below the deck, deployed above it - otherwise they are never hidden
    // or never actually reach the floor.
    if (!(k.stowedDepth > 0)) errors.push("arena: killsaw.stowedDepth must be positive (depth below the floor)");
    if (!(k.deployedHeight > 0)) errors.push("arena: killsaw.deployedHeight must be positive");
  }

  // A pit is a hole in the deck: it has to be inside the floor with a bit of
  // deck all round, and deep enough that a robot in it is below the deck.
  for (const h of arena.hazards.filter((x) => x.type === "pit")) {
    const [w, l] = h.size || [];
    if (!(w > 0 && l > 0)) errors.push(`arena: pit "${h.id}" needs a positive size [w, l]`);
    else if (Math.abs(h.pos[0]) + w / 2 > fx / 2 - 3 || Math.abs(h.pos[2]) + l / 2 > fz / 2 - 3) {
      errors.push(`arena: pit "${h.id}" comes within 3 ft of the wall`);
    }
    if (!(h.depth >= 1.5)) errors.push(`arena: pit "${h.id}" must be at least 1.5 ft deep`);
    if ((h.yaw || 0) % 90 !== 0) errors.push(`arena: pit "${h.id}" must be square to the walls (yaw a multiple of 90)`);
  }

  // Pulverizers must be in corners to be mountable on a wall.
  for (const h of arena.hazards.filter((x) => x.type === "pulverizer")) {
    const inCorner = Math.abs(h.pos[0]) > fx / 4 && Math.abs(h.pos[2]) > fz / 4;
    if (h.mount === "corner" && !inCorner) {
      errors.push(`arena: pulverizer "${h.id}" claims a corner mount but sits at (${h.pos[0]}, ${h.pos[2]})`);
    }
  }

  return errors;
}

export function validateRobotDef(reg, def) {
  const errors = [];
  const where = `robot "${def.id}"`;

  if (!ORIGINS.includes(def.origin)) errors.push(`${where}: origin must be parody|original`);
  if (!ARCHETYPES.includes(def.archetype)) errors.push(`${where}: unknown archetype "${def.archetype}"`);
  if (!LEAGUES.includes(def.league)) errors.push(`${where}: unknown league "${def.league}"`);
  if (!PERSONALITIES.includes(def.personality)) errors.push(`${where}: unknown personality "${def.personality}"`);
  if (!(def.rating >= 0 && def.rating <= 100)) errors.push(`${where}: rating must be 0-100`);

  try {
    const a = assembleRobot(reg, def);
    for (const e of a.legality.errors) errors.push(`${where}: ${e}`);
    // The body has to build: unknown templates or extras are data errors.
    buildShape(a);
    if (def.partner) {
      const b = assemblePartner(reg, def);
      for (const e of b.legality.errors) errors.push(`${where} (${b.name}): ${e}`);
      buildShape(b);
      for (const e of checkMultibotWeight(reg, a, b)) errors.push(`${where}: ${e}`);
    }

    // Geometry coherence: the chassis must ride higher than the tyres squash,
    // or its collider grinds on the floor and the bot can barely move. This
    // shipped once as a silent handling bug, so it is a hard error now.
    const rest = a.stats.suspensionTravelM * 0.5;
    if (a.stats.groundClearanceM <= rest) {
      errors.push(
        `${where}: ground clearance ${(a.stats.groundClearanceM * 1000).toFixed(1)} mm is not ` +
        `above the resting tyre squash of ${(rest * 1000).toFixed(1)} mm - the chassis would drag.`
      );
    }
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
  }
  return errors;
}

/** Whole-registry check. Returns { errors, warnings }. */
export function validateAll(reg) {
  const errors = [
    ...validatePartsDoc(reg.partsDoc),
    ...validateArena(reg.arena),
    ...(reg.arenas ? validateArenas(reg, validateArena) : []),
  ];
  const warnings = [];

  const names = new Map();
  for (const def of reg.allRobots()) {
    errors.push(...validateRobotDef(reg, def));
    const key = def.name.toLowerCase();
    if (names.has(key)) errors.push(`duplicate robot name "${def.name}" (${names.get(key)} and ${def.id})`);
    names.set(key, def.id);
  }

  // Roster-wide totals, over the league field only (the exhibition and test
  // bots are not in it).
  const roster = reg.roster ? reg.roster() : reg.allRobots();
  const total = roster.length;
  if (total < ROSTER_TARGET.total) {
    warnings.push(`roster is ${total}/${ROSTER_TARGET.total} robots`);
  } else {
    const byOrigin = { parody: 0, original: 0 };
    const byLeague = {};
    for (const d of roster) {
      byOrigin[d.origin]++;
      byLeague[d.league] = (byLeague[d.league] || 0) + 1;
    }
    if (byOrigin.parody !== ROSTER_TARGET.parody) {
      errors.push(`roster has ${byOrigin.parody} parody bots, expected ${ROSTER_TARGET.parody}`);
    }
    if (byOrigin.original !== ROSTER_TARGET.original) {
      errors.push(`roster has ${byOrigin.original} original bots, expected ${ROSTER_TARGET.original}`);
    }
    for (const l of LEAGUES) {
      if ((byLeague[l] || 0) !== ROSTER_TARGET.perLeague) {
        errors.push(`league "${l}" has ${byLeague[l] || 0} robots, expected ${ROSTER_TARGET.perLeague}`);
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

export { LEAGUES, ARCHETYPES, ORIGINS, PERSONALITIES };
