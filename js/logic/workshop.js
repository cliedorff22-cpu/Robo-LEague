// workshop.js - editing a robot design: its slots, the parts that fit each
// one, what a swap does to the numbers, and a body that suits the weapon.
//
// Pure logic, no DOM: the workshop screen (js/menu/workshop_ui.js) draws
// these, the build advisor (advisor.js) searches with them, and the tests
// drive them directly. A design is a robot def's look-and-build:
//   { name, body, build, livery, personality }
// Nothing here spends money - garage.js prices and fits a finished design.

import { assembleRobot } from "./build.js";
import { buildShape, BODY_TEMPLATES, EXTRA_TYPES } from "./shape.js";
import { canBuy, priceOf, garageOf, countParts } from "./garage.js";

/** One part per slot for these; armour is a list of panels by face. */
export const SINGLE_SLOTS = ["chassis", "drive", "wheel", "motor", "battery", "electronics", "weaponMotor", "weapon", "srimech"];
/** Slots a robot can leave empty. */
export const OPTIONAL = new Set(["weaponMotor", "srimech"]);
export const SLOT_NAMES = {
  chassis: "Chassis", drive: "Drivetrain", wheel: "Wheels", motor: "Drive motors", battery: "Battery",
  electronics: "Electronics", weaponMotor: "Weapon motor", weapon: "Weapon", srimech: "Self-righter",
  front: "Front armour", side: "Side armour", top: "Top armour", rear: "Rear armour",
};
const FACES = ["front", "side", "top", "rear"];

/**
 * Where each weapon class can be mounted (shape.js `mount`), best first.
 * A shell spinner is its own case (mountsFor): it needs the round body it wraps.
 */
export const MOUNTS = {
  spinner_h: ["front", "low", "overhead"], spinner_v: ["front"], drum: ["front"],
  hammer: ["top"], flipper: ["front", "lid"], lifter: ["front"], crusher: ["front"], static: ["front"],
};
/** The mounts on offer for this build's weapon (a shell spinner has only one). */
export function mountsFor(reg, build) {
  if (build.weapon && reg.part(build.weapon).spec.style === "shell") return ["shell"];
  return MOUNTS[weaponClassOf(reg, build)] || ["front"];
}
export const MOUNT_NAMES = {
  front: "Front", low: "Low (undercutter)", overhead: "Overhead (on a mast)", shell: "Full-body shell",
  top: "Over the top", lid: "Lid (whole top flips)",
};
/** Body templates a player can pick (the test bots' "classic" and hand-drawn "custom" are not offered). */
export const TEMPLATES = BODY_TEMPLATES.filter((t) => t !== "classic" && t !== "custom");
export const TEMPLATE_NAMES = {
  box: "Box", wedge: "Wedge", slab: "Slab (invertible)", round: "Round", dart: "Arrowhead", hex: "Hex",
  bullet: "Bullet", tent: "Tent", cab: "Deck and cab", twin: "Twin pods",
};
/** Body extras offered in the workshop (shape.js EXTRA_TYPES has the full list). */
export const EXTRAS = ["forks", "plow", "wheelGuards", "bumper", "spikes", "horns", "eyes", "fin", "cage", "dome", "spines"]
  .filter((x) => EXTRA_TYPES.includes(x));

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/**
 * The parts a player's robot can fit in a category. The minibot kit
 * (spec.minibot) is for the small half of a multibot, which the workshop
 * does not build; drive-motor slots take drive motors only.
 */
export function partsFor(reg, category, face = null, { minibot = false } = {}) {
  // The minibot kit is for a multibot's second unit only.
  let list = reg.partsIn(category).filter((p) => minibot || !p.spec.minibot);
  if (category === "armor" && face) list = list.filter((p) => p.spec.slot === face);
  if (category === "motor") list = list.filter((p) => p.spec.role === "drive");
  return list;
}

/** The weapon class a build carries ("none" without one). */
export const weaponClassOf = (reg, build) => (build.weapon ? reg.part(build.weapon).spec.class : "none");

/**
 * Every slot of a design, in workshop order, with what is fitted. Armour
 * slots come from the chassis (front 1, side 2, top 1, rear 1 on most).
 * @returns [{ key, category, face?, index?, partId, optional, label }]
 */
export function slotsOf(reg, build) {
  const out = SINGLE_SLOTS.map((cat) => ({
    key: cat, category: cat, partId: build[cat] || null, optional: OPTIONAL.has(cat), label: SLOT_NAMES[cat],
  }));
  const limits = reg.part(build.chassis).spec.armorSlots || { front: 1, side: 2, top: 1, rear: 1 };
  const armour = [];
  for (const face of FACES) {
    for (let i = 0; i < (limits[face] || 0); i++) {
      armour.push({ key: `armor:${face}:${i}`, category: "armor", face, index: i, partId: null, optional: true,
        label: (limits[face] || 0) > 1 ? `${SLOT_NAMES[face]} ${i ? "R" : "L"}` : SLOT_NAMES[face] });
    }
  }
  // `fitIndex` is the panel's place in build.armor - its fitting is
  // "armor.<fitIndex>", which is what damage and the 3D view are keyed by.
  (build.armor || []).forEach((id, i) => {
    const face = reg.part(id).spec.slot;
    const free = armour.find((s) => s.face === face && !s.partId);
    if (free) { free.partId = id; free.fitIndex = i; }
  });
  return [...out, ...armour];
}

/** Armour panels in a stable order (front, side L, side R, top, rear) - fitting keys follow it. */
function armourFromSlots(slots) {
  return slots.filter((s) => s.category === "armor" && s.partId).map((s) => s.partId);
}

/**
 * A new build with one slot changed (partId null to empty an optional one).
 * Changing the chassis drops panels it has no room for; changing the weapon
 * fits or drops a weapon motor to suit.
 */
export function setSlot(reg, build, key, partId) {
  const b = clone(build);
  if (!key.startsWith("armor:")) {
    if (partId) b[key] = partId; else delete b[key];
    // A powered weapon needs a motor (the cheapest, until one is chosen); a
    // wedge or no weapon needs none.
    if (key === "weapon") {
      const powered = partId && reg.part(partId).spec.powered;
      if (!powered) delete b.weaponMotor;
      else if (!b.weaponMotor) b.weaponMotor = partsFor(reg, "weaponMotor").sort((x, y) => x.cost - y.cost)[0]?.id;
    }
    if (key === "chassis") b.armor = armourFromSlots(slotsOf(reg, b));
    return b;
  }
  const slots = slotsOf(reg, b);
  const s = slots.find((x) => x.key === key);
  if (!s) return b;
  s.partId = partId || null;
  b.armor = armourFromSlots(slots);
  return b;
}

/**
 * A body that works with the build's weapon: keeps the player's template and
 * extras where it can, and fixes the mount (and the template, for a shell).
 */
export function fitBody(reg, body, build) {
  const b = clone(body) || {};
  const cls = weaponClassOf(reg, build);
  const mounts = mountsFor(reg, build);
  if (!b.template || b.template === "classic" || !TEMPLATES.includes(b.template)) b.template = cls === "static" ? "wedge" : "box";
  // A shell spinner IS the body's outside: it needs a round body to wrap.
  const shell = build.weapon && reg.part(build.weapon).spec.style === "shell";
  if (shell) { b.template = "round"; b.mount = "shell"; }
  else if (b.mount === "shell") b.mount = mounts[0];
  if (!mounts.includes(b.mount)) b.mount = mounts[0];
  b.extras = (b.extras || []).filter((e) => EXTRA_TYPES.includes(e.type));
  return b;
}

/** The numbers a builder watches, for one design. */
export function summarize(reg, def) {
  const a = assembleRobot(reg, def);
  const s = a.stats, w = s.weapon;
  let shape = null;
  try { shape = buildShape(a); } catch { shape = null; }
  const cap = reg.rules.weightClass.cap;
  return {
    weightLb: Math.round(a.weightLb * 10) / 10,
    capLb: cap,
    spareLb: Math.round((cap - a.weightLb) * 10) / 10,
    legal: a.legality.errors.length === 0,
    errors: a.legality.errors,
    warnings: a.legality.warnings,
    topSpeedMph: round1(s.topSpeedMph),
    accelMps2: round1(s.accelMps2),
    pushRatio: Math.round(s.pushRatio * 100) / 100,
    pivot: Math.round(s.pivotAuthority * 100) / 100,
    weaponClass: w.class,
    weaponName: a.parts.weapon?.name ?? "None",
    energyKJ: round1((w.energyJ || 0) / 1000),
    spinUpS: isFinite(w.spinUpS) ? round1(w.spinUpS) : null,
    armourHp: Math.round(s.armorHp),
    totalHp: Math.round(a.fittings.reduce((t, f) => t + f.part.hp, 0)),
    invertible: !!shape?.invertible,
    selfRight: s.selfRight.via,
    clearanceIn: round1(s.groundClearanceM / 0.0254),
    listPrice: a.fittings.reduce((t, f) => t + f.part.cost, 0),
  };
}

/** b minus a, for the numbers that matter in a swap. */
export function delta(a, b) {
  const out = {};
  for (const k of ["weightLb", "topSpeedMph", "pushRatio", "energyKJ", "spinUpS", "armourHp", "totalHp"]) {
    if (a[k] != null && b[k] != null) out[k] = Math.round((b[k] - a[k]) * 100) / 100;
  }
  return out;
}

/**
 * The parts that could go in a slot, each with what it would do to the design.
 * `career` may be null (a sandbox): then nothing is owned, locked or priced.
 * `opts.minibot`: the slot is on a multibot's second unit (the minibot kit fits).
 * @returns [{ part, fitted, owned, spare, price, locked, reason, after, delta, legal }]
 */
export function candidates(reg, career, design, key, opts = {}) {
  const slot = slotsOf(reg, design.build).find((s) => s.key === key);
  if (!slot) return [];
  const before = summarize(reg, defOf(reg, design));
  const owned = career ? garageOf(reg, career).owned : {};
  const fitted = countParts(design.build);
  const parts = partsFor(reg, slot.category, slot.face, opts);
  const out = parts.map((part) => {
    const build = setSlot(reg, design.build, key, part.id);
    const d = { ...design, build, body: key === "weapon" ? fitBody(reg, design.body, build) : design.body };
    let after = null;
    try { after = summarize(reg, defOf(reg, d)); } catch { after = null; }
    const buy = career ? canBuy(reg, career, part.id) : { ok: true, reason: "" };
    const have = owned[part.id] || 0;
    return {
      part, fitted: slot.partId === part.id,
      owned: have, spare: Math.max(0, have - (fitted[part.id] || 0)),
      price: career ? priceOf(reg, career, part.id) : part.cost,
      locked: !buy.ok && have <= (fitted[part.id] || 0), reason: buy.reason,
      after, delta: after ? delta(before, after) : null, legal: !!after?.legal,
    };
  });
  return out.sort((a, b) => (a.part.tier ?? 1) - (b.part.tier ?? 1) || a.part.cost - b.part.cost);
}

/** A design as a full robot def the build and shape code accept. */
export function defOf(reg, design, base = reg.robot(reg.playerId)) {
  return { ...base, id: base.id, name: design.name ?? base.name, body: design.body ?? base.body, build: design.build,
    livery: design.livery ?? base.livery, personality: design.personality ?? base.personality };
}

const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- shared by the advisor and the AI teams

/** Upgrade the panel on `face` to the toughest that fits, trimming other faces if needed. */
export function reinforce(reg, design, face, protect) {
  const slots = slotsOf(reg, design.build).filter((s) => s.category === "armor" && s.face === face);
  if (!slots.length) return null;
  const options = partsFor(reg, "armor", face).sort((a, b) => b.hp - a.hp);
  for (const part of options) {
    let build = design.build;
    let changed = false;
    for (const s of slots) {
      if (s.partId && reg.part(s.partId).hp >= part.hp) continue;
      build = setSlot(reg, build, s.key, part.id); changed = true;
    }
    if (!changed) continue;
    const d = fitWithin(reg, { ...design, build }, ["rear", "top", "side", "front"].filter((f) => f !== face && !protect.includes(f)));
    if (d) return d;
  }
  return null;
}

/**
 * Make a design legal on weight by stepping down panels on the given faces
 * (least important first). Returns null if it cannot.
 */
export function fitWithin(reg, design, faces) {
  let d = clone(design);
  for (let i = 0; i < 8; i++) {
    let sum;
    try { sum = summarize(reg, defOf(reg, d)); } catch { return null; }
    if (sum.legal) return d;
    if (!sum.errors.some((e) => /overweight/i.test(e))) return null;
    let stepped = false;
    for (const face of faces) {
      const s = slotsOf(reg, d.build).find((x) => x.category === "armor" && x.face === face && x.partId);
      if (!s) continue;
      const cur = reg.part(s.partId);
      const lighter = partsFor(reg, "armor", face).filter((p) => p.weight < cur.weight).sort((a, b) => b.weight - a.weight)[0];
      d.build = setSlot(reg, d.build, s.key, lighter ? lighter.id : null);
      stepped = true;
      break;
    }
    if (!stepped) return null;
  }
  return null;
}

export function uniqExtras(list) {
  const seen = new Set();
  return list.filter((e) => EXTRAS.includes(e.type) && !seen.has(e.type) && seen.add(e.type));
}
