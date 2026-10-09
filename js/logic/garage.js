// garage.js - the player's robot and the parts they own, inside the career.
//
// The career used to fight Test Mule exactly as data/robots/player_default.json
// described it. From Stage 6 the player builds their own: the robot (name,
// body, build, paint, driver style) lives in `career.garage`, every part they
// own is counted there, and the shop sells more. Pure logic over the save, like
// the rest of career.js - the workshop screen (js/menu/workshop_ui.js) and the
// build advisor (advisor.js) only call in here.
//
//   garage = { name, body, build, livery, personality,
//              owned: { partId: count },   // fitted parts included
//              version: "1.0", log: [{ season, text }] }
//
// Rules of the shop (data/economy.json `shop`):
//  - a part's tier unlocks with the best league the player has reached;
//  - prices carry the career's parts discount (sponsors, Giant Nut deals);
//  - fitting a part you do not own buys it; spares sell back at `resale`.

import { assembleRobot, assemblePartner, checkMultibotWeight } from "./build.js";
import { pay } from "./ledger.js";

const SINGLE = ["chassis", "drive", "wheel", "motor", "battery", "electronics", "weaponMotor", "weapon", "srimech"];

/** Every part id a build fits, armour panels each counted. */
export function partsOf(build) {
  const out = [];
  for (const k of SINGLE) if (build[k]) out.push(build[k]);
  for (const id of build.armor || []) out.push(id);
  return out;
}

/** { partId: count } for a build. */
export function countParts(build) {
  const c = {};
  for (const id of partsOf(build)) c[id] = (c[id] || 0) + 1;
  return c;
}

/** Parts fitted across both units of a (possibly multibot) design. */
export function fittedCounts(build, partnerBuild = null) {
  const c = countParts(build);
  if (partnerBuild) for (const [id, n] of Object.entries(countParts(partnerBuild))) c[id] = (c[id] || 0) + n;
  return c;
}

/**
 * The second unit a robot becomes a multibot with, until the player changes
 * it: a minibot wedge, as the field's multibots run.
 */
export const DEFAULT_PARTNER = {
  name: "Minibot",
  body: { template: "wedge", params: { slope: 0.8 }, mount: "front", extras: [] },
  build: { chassis: "chassis_mini", drive: "drive_2wd_belt", wheel: "wheel_4_mini", motor: "motor_drive_mini",
    battery: "batt_4s_lipo", electronics: "ecu_mini", weapon: "wedge_mini", armor: ["armor_uhmw_front"] },
};

/** The archetype a build is, from its weapon - what the AI and the menus call it. */
export function archetypeOf(reg, build) {
  const cls = build.weapon ? reg.part(build.weapon).spec.class : "none";
  return cls === "static" ? "wedge" : cls;
}

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** A fresh garage: the robot file's robot, and its parts, owned. */
export function newGarage(reg) {
  const base = reg.robot(reg.playerId);
  // The test bots' plain "classic" box is not a workshop body: a career robot
  // starts sculpted, so the workshop can reshape it.
  const body = base.body?.template && base.body.template !== "classic" ? clone(base.body)
    : { template: archetypeOf(reg, base.build) === "wedge" ? "wedge" : "box", mount: base.build.weapon && reg.part(base.build.weapon).spec.class === "hammer" ? "top" : "front", extras: [] };
  return {
    name: base.name,
    body,
    build: clone(base.build),
    livery: clone(base.livery) || {},
    personality: base.personality || "opportunistic",
    owned: countParts(base.build),
    version: "1.0",
    log: [],
  };
}

/** The career's garage, made on first use (saves from before Stage 6 have none). */
export function garageOf(reg, career) {
  if (!career.garage) career.garage = newGarage(reg);
  // Garages made before the body rule above: sculpt the classic box once.
  const b = career.garage.body;
  if (!b?.template || b.template === "classic") career.garage.body = newGarage(reg).body;
  return career.garage;
}

/** The player's robot as a robot def - what fights, everywhere. */
export function playerDef(reg, career) {
  const base = reg.robot(career.playerId);
  const g = garageOf(reg, career);
  return {
    ...base,
    name: g.name, body: clone(g.body), build: clone(g.build), livery: clone(g.livery),
    personality: g.personality, archetype: archetypeOf(reg, g.build), version: g.version,
    // A multibot's second unit: it fights beside the main one, AI driven.
    partner: g.partner ? clone(g.partner) : undefined,
  };
}

/** The best league the player has ever been in (it unlocks the shop's tiers). */
export function bestLeague(reg, career) {
  const order = reg.league.leagues;
  let best = order.indexOf(career.membership[career.playerId]);
  for (const h of career.history || []) {
    for (const lg of [h.league, h.nextLeague]) if (lg) best = Math.max(best, order.indexOf(lg));
  }
  return order[Math.max(0, best)];
}

function shopCfg(reg) {
  return { tierFromLeague: { rookie: 1, pro: 2, elite: 3, world: 3 }, resale: 0.5, ...(reg.economy?.shop || {}) };
}

/** The highest part tier the shop will sell the player now. */
export function shopTier(reg, career) {
  const cfg = shopCfg(reg);
  let tier = cfg.tierFromLeague[bestLeague(reg, career)] ?? 1;
  // A Giant Nut deal can open the top shelf early.
  if ((career.unlocks || []).includes("tier3")) tier = Math.max(tier, 3);
  return tier;
}

/** The career's parts discount (sponsors and Giant Nut deals), 0..1. */
export function discountOf(reg, career) {
  let d = 0;
  for (const id of career.sponsors || []) d = Math.max(d, reg.economy.sponsors.find((s) => s.id === id)?.partsDiscount ?? 0);
  for (const p of career.perks || []) d = Math.max(d, p.partsDiscount ?? 0);
  return d;
}

/** What one part costs the player now. */
export function priceOf(reg, career, partId) {
  return Math.round(reg.part(partId).cost * (1 - discountOf(reg, career)));
}

/** What a spare part sells back for (list price x resale, no discount). */
export function resaleOf(reg, partId) {
  return Math.round(reg.part(partId).cost * shopCfg(reg).resale);
}

/** Owned parts not fitted to the robot right now. */
export function spares(reg, career) {
  const g = garageOf(reg, career);
  const fitted = fittedCounts(g.build, g.partner?.build);
  const out = {};
  for (const [id, n] of Object.entries(g.owned)) {
    const spare = n - (fitted[id] || 0);
    if (spare > 0) out[id] = spare;
  }
  return out;
}

/** Whether the player could buy this part now: { ok, reason }. */
export function canBuy(reg, career, partId) {
  const part = reg.part(partId);
  const tier = shopTier(reg, career);
  if ((part.tier ?? 1) > tier) {
    const need = Object.entries(shopCfg(reg).tierFromLeague).find(([, t]) => t >= part.tier)?.[0];
    return { ok: false, reason: `Tier ${part.tier} - unlocks when you reach the ${need ?? "top"} league.` };
  }
  return { ok: true, reason: "" };
}

/**
 * What it would take to fit `build`: the parts to buy (beyond what is owned),
 * what they cost, and anything the shop will not sell yet.
 */
export function quote(reg, career, build, partnerBuild = null) {
  const g = garageOf(reg, career);
  const need = fittedCounts(build, partnerBuild);
  const buy = [];
  const locked = [];
  let total = 0;
  for (const [id, n] of Object.entries(need)) {
    const short = n - (g.owned[id] || 0);
    if (short <= 0) continue;
    const price = priceOf(reg, career, id);
    buy.push({ id, n: short, price, name: reg.part(id).name });
    total += price * short;
    const c = canBuy(reg, career, id);
    if (!c.ok) locked.push({ id, name: reg.part(id).name, reason: c.reason });
  }
  return { buy, total, locked, affordable: total <= career.cash };
}

/**
 * Fit a new design: buy whatever it needs that is not owned, then make it the
 * robot. `draft` is { name?, body?, build, livery?, personality? }.
 * @returns { ok, errors: [text], bought, cost }
 */
export function applyDesign(reg, career, draft) {
  const g = garageOf(reg, career);
  const def = { ...playerDef(reg, career), ...pick(draft), id: career.playerId };
  if (draft.partner === null) delete def.partner;
  let a, pa = null;
  try {
    a = assembleRobot(reg, def);
    if (def.partner) pa = assemblePartner(reg, def);
  } catch (e) { return { ok: false, errors: [String(e.message || e)], bought: [], cost: 0 }; }
  // A multibot's units each pass inspection, and together make the weight.
  const errors = [...a.legality.errors, ...(pa ? pa.legality.errors.map((e) => `${def.partner.name}: ${e}`) : []),
    ...(pa ? checkMultibotWeight(reg, a, pa) : [])];
  const q = quote(reg, career, def.build, def.partner?.build);
  for (const l of q.locked) errors.push(`${l.name}: ${l.reason}`);
  if (!q.affordable) errors.push(`The new parts cost $${q.total.toLocaleString()}; you have $${Math.round(career.cash).toLocaleString()}.`);
  if (errors.length) return { ok: false, errors, bought: q.buy, cost: q.total };

  for (const b of q.buy) {
    g.owned[b.id] = (g.owned[b.id] || 0) + b.n;
    pay(career, -b.price * b.n, `Workshop: ${b.n > 1 ? `${b.n}x ` : ""}${b.name}`);
  }
  // Damage goes where the part goes (Stage 7): a damaged part that stays on
  // the robot keeps its damage, wherever it is fitted now; a damaged part
  // taken off is scrapped for salvage rather than kept as a spare.
  const carried = carryCondition(reg, g, def.build);
  for (const id of carried.scrapped) {
    g.owned[id] = Math.max(0, (g.owned[id] || 0) - 1);
    const credit = Math.round((reg.rules.pit?.salvageCreditFraction ?? 0.4) * reg.part(id).cost * carried.scrapCondition[id].shift());
    if (credit) pay(career, credit, `Scrapped a damaged ${reg.part(id).name}`);
  }
  g.condition = carried.condition;
  // The second unit's damage the same way; a unit taken off sends its
  // damaged parts to the scrap bin and the rest to the spares.
  const pc = carryCondition(reg, { build: g.partner?.build || {}, condition: g.partnerCondition || {} }, def.partner?.build || {});
  for (const id of pc.scrapped) {
    g.owned[id] = Math.max(0, (g.owned[id] || 0) - 1);
    const credit = Math.round((reg.rules.pit?.salvageCreditFraction ?? 0.4) * reg.part(id).cost * pc.scrapCondition[id].shift());
    if (credit) pay(career, credit, `Scrapped a damaged ${reg.part(id).name}`);
  }
  g.partnerCondition = pc.condition;
  const changed = describeChange(reg, g.build, def.build);
  if (!g.partner !== !def.partner) changed.push(def.partner ? `became a multibot with ${def.partner.name}` : "no longer a multibot");
  else if (def.partner && JSON.stringify(def.partner.build) !== JSON.stringify(g.partner.build)) changed.push(`${def.partner.name} refitted`);
  Object.assign(g, { name: def.name, body: clone(def.body), build: clone(def.build), livery: clone(def.livery), personality: def.personality,
    partner: def.partner ? clone(def.partner) : null });
  if (changed.length) {
    g.version = bumpVersion(g.version, changed.some((c) => c.startsWith("weapon") || /multibot/.test(c)));
    g.log.push({ season: career.seasonIndex, version: g.version, text: changed.join("; ") });
    if (g.log.length > 40) g.log.splice(0, g.log.length - 40);
  }
  return { ok: true, errors: [], bought: q.buy, cost: q.total };
}

/**
 * Map the robot's damage from its old build onto a new one by part: each
 * fitting of the new build takes the condition of an unused fitting of the
 * same part in the old one (fresh if there is none). Damaged parts left over
 * are scrapped.
 */
export function carryCondition(reg, g, newBuild) {
  const cond = g.condition || {};
  const keysOf = (build) => {
    const out = [];
    for (const k of SINGLE) if (build[k]) out.push({ key: k, id: build[k] });
    (build.armor || []).forEach((id, i) => out.push({ key: `armor.${i}`, id }));
    return out;
  };
  const old = keysOf(g.build).map((f) => ({ ...f, c: cond[f.key] ?? 1, used: false }));
  const condition = {};
  for (const f of keysOf(newBuild)) {
    // Prefer the same fitting, then any unused one of the same part.
    const same = old.find((o) => !o.used && o.id === f.id && o.key === f.key) || old.find((o) => !o.used && o.id === f.id);
    if (!same) continue;
    same.used = true;
    if (same.c < 0.999) condition[f.key] = same.c;
  }
  const scrapped = [], scrapCondition = {};
  for (const o of old) {
    if (o.used || o.c >= 0.999) continue;
    scrapped.push(o.id);
    (scrapCondition[o.id] ||= []).push(o.c);
  }
  return { condition, scrapped, scrapCondition };
}

/** Sell one spare of a part back to the shop. */
export function sellPart(reg, career, partId) {
  const sp = spares(reg, career)[partId] || 0;
  if (sp <= 0) return { ok: false, refund: 0 };
  const g = garageOf(reg, career);
  g.owned[partId]--;
  if (g.owned[partId] <= 0) delete g.owned[partId];
  const refund = resaleOf(reg, partId);
  pay(career, refund, `Sold ${reg.part(partId).name}`);
  return { ok: true, refund };
}

function pick(d) {
  const out = {};
  for (const k of ["name", "body", "build", "livery", "personality", "partner"]) if (d[k] !== undefined && d[k] !== null) out[k] = clone(d[k]);
  if (out.name !== undefined) out.name = String(out.name).trim().slice(0, 28) || "Unnamed";
  return out;
}

/** "weapon: Wedge -> 26in Horizontal Bar" style notes for the build log. */
export function describeChange(reg, before, after) {
  const notes = [];
  for (const k of SINGLE) {
    if ((before[k] || null) === (after[k] || null)) continue;
    const nm = (id) => (id ? reg.part(id).name : "none");
    notes.push(`${k === "weaponMotor" ? "weapon motor" : k}: ${nm(before[k])} -> ${nm(after[k])}`);
  }
  const ba = [...(before.armor || [])].sort().join(), aa = [...(after.armor || [])].sort().join();
  if (ba !== aa) notes.push("armour refitted");
  return notes;
}

/** 1.0 -> 1.1 for a refit, -> 2.0 for a new weapon. */
function bumpVersion(v, major) {
  const [M, m] = String(v || "1.0").split(".").map(Number);
  return major ? `${M + 1}.0` : `${M}.${(m || 0) + 1}`;
}
