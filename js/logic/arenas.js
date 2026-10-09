// arenas.js - which arena a fight is in: the box (data/arena.json), one of the
// hazard LAYOUTS and a VENUE round it (data/arenas.json).
//
// Pure: no Three, no Rapier. Everything downstream - physics, hazards, the
// renderer, the AI's hazard map - takes the composed arena exactly as it took
// data/arena.json before, so a layout is nothing but data.

import { hashSeed } from "../core/rng.js";

export const DEFAULT_LAYOUT = "classic";
export const DEFAULT_VENUE = "pro";

/** Layout ids, in the file's order. */
export function layoutIds(reg) {
  return Object.keys(reg.arenas?.layouts || {}).filter((k) => !k.startsWith("_"));
}

/** Venue ids, in the file's order. */
export function venueIds(reg) {
  return Object.keys(reg.arenas?.venues || {}).filter((k) => !k.startsWith("_"));
}

export const layoutOf = (reg, id) => reg.arenas?.layouts?.[id] || null;
export const venueOf = (reg, id) => reg.arenas?.venues?.[id] || null;

/**
 * The hazards a layout runs. `like` copies a hazard from data/arena.json and
 * overrides only what is given, so the tuning of a pulverizer lives in one
 * place however many layouts use one.
 */
export function layoutHazards(reg, layoutId) {
  const base = reg.arena.hazards;
  const L = layoutOf(reg, layoutId);
  if (!L || !L.hazards) return base;
  return L.hazards.map((h) => {
    if (!h.like) return h;
    const src = base.find((b) => b.id === h.like);
    if (!src) throw new Error(`layout "${layoutId}": no hazard "${h.like}" in arena.json to copy`);
    const { like, ...over } = h;
    return { ...src, ...over };
  });
}

/**
 * The arena a fight is in: arena.json with the layout's hazards (and killsaw
 * settings) and the venue's lighting. The classic layout keeps arena.json's
 * id, so its killsaw draws - seeded by the arena id - replay exactly as they
 * always have.
 */
export function composeArena(reg, { layout = DEFAULT_LAYOUT, venue = null } = {}) {
  const base = reg.arena;
  const L = layoutOf(reg, layout) ? layout : DEFAULT_LAYOUT;
  const V = venueOf(reg, venue) ? venue : null;
  const lay = layoutOf(reg, L) || {};
  const ven = V ? venueOf(reg, V) : null;
  const lighting = { ...base.lighting };
  if (ven?.lighting) {
    const vl = ven.lighting;
    if (vl.background) lighting.background = vl.background;
    if (vl.fog) lighting.fog = { ...lighting.fog, ...vl.fog };
    if (vl.rigColor) lighting.rigs = (lighting.rigs || []).map((r) => ({ ...r, color: vl.rigColor }));
    if (vl.exposure) lighting.exposure = vl.exposure;
  }
  // A seat in the crowd: a camera up in the venue's first stand, looking in.
  let cameras = base.cameras;
  if (ven?.stands?.tiers?.length) {
    const st = ven.stands;
    const rows = st.tiers[0].rows;
    const out = base.floor.size[1] / 2 + st.gap + rows * st.rowDepth * 0.5;
    const up = 10 + rows * st.rowRise * 0.5;
    const side = st.sides.includes("s") ? 1 : -1;
    const stands = { id: "stands", label: "Stands Cam", type: "fixed", pos: [9, up, side * out], lookAt: [0, 1, 0], fov: 46 };
    // Before the Versus cam and the replay cam, so it keeps key 5.
    const at = cameras.findIndex((c) => c.type === "versus" || c.type === "replay");
    cameras = at < 0 ? [...cameras, stands] : [...cameras.slice(0, at), stands, ...cameras.slice(at)];
  }
  return {
    ...base,
    cameras,
    id: L === DEFAULT_LAYOUT ? base.id : `${base.id}:${L}`,
    name: lay.name || base.name,
    layout: L,
    venue: V,
    hazards: layoutHazards(reg, L),
    killsaw: { ...(base.killsaw || {}), ...(lay.killsaw || {}) },
    lighting,
  };
}

/** The venue for a league ("rookie".."world") or the Giant Nut. */
export function venueForLeague(reg, league) {
  if (venueOf(reg, league)) return league;
  return venueIds(reg).find((id) => venueOf(reg, id).league === league) || DEFAULT_VENUE;
}

/** A layout from the venue's pool, the same one every time for the same key. */
export function layoutForFight(reg, venueId, key) {
  const pool = (venueOf(reg, venueId)?.layouts || [DEFAULT_LAYOUT]).filter((id) => layoutOf(reg, id));
  if (!pool.length) return DEFAULT_LAYOUT;
  return pool[hashSeed(`layout:${key}`) % pool.length];
}

/**
 * Where a career fight is: the Giant Nut season at the Giant Nut's venue,
 * otherwise the player's league's. The layout is drawn from that venue's
 * pool by the fixture, so the scouting card and the fight agree.
 */
export function careerArena(reg, { seasonKind, league, fixtureId }) {
  const venue = seasonKind === "giantNut" ? venueForLeague(reg, "giantNut") : venueForLeague(reg, league);
  return { venue, layout: layoutForFight(reg, venue, fixtureId) };
}

/** Problems with data/arenas.json, as strings. */
export function validateArenas(reg, validateArena) {
  const errors = [];
  for (const id of layoutIds(reg)) {
    try {
      const a = composeArena(reg, { layout: id });
      const ids = a.hazards.map((h) => h.id);
      const dup = ids.find((x, i) => ids.indexOf(x) !== i);
      if (dup) errors.push(`layout "${id}": hazard id "${dup}" is used twice`);
      for (const e of validateArena ? validateArena(a) : []) errors.push(`layout "${id}": ${e}`);
    } catch (e) { errors.push(String(e.message || e)); }
  }
  for (const id of venueIds(reg)) {
    const v = venueOf(reg, id);
    for (const l of v.layouts || []) if (!layoutOf(reg, l)) errors.push(`venue "${id}": unknown layout "${l}"`);
    if (!v.stands?.tiers?.length) errors.push(`venue "${id}": no stands`);
  }
  return errors;
}
