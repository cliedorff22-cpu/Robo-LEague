// ailearn.js - AI teams that adapt and learn, the way real teams do.
//
// Every AI robot in a career has a MEMORY (career.ai[id]):
//
//   vs[class]   its record against each weapon class, how it lost, and the
//               tactics it has learned for that class (flank / press / herd)
//   setups[class][change]   how each pre-fight change has worked against
//               that class - +1 for a win with it fitted, -1 for a loss
//
// and it uses it at every step:
//
//   BEFORE a fight (prepareFor) it sets the robot up for that opponent:
//     a heavier or lighter rotor, a different blade shape, forks or a plow
//     against a horizontal spinner, armour moved to the face the opponent
//     hits, a self-righter against a flipper - and the tactics it has learned
//     for that weapon. Against the player it TESTS its options in trial fights
//     (how many is the difficulty); against other AI it judges them from its
//     memory and the measured matchups, and now and then tries something new.
//   IN the fight its driver learns as it goes (ai.js makeAI, resolver.js).
//   AFTER the fight (learnFromFight) it remembers the result, how it lost,
//     which setup it ran and what its driver learned.
//   IN the pit it fixes first what the NEXT opponent will hit (pitPrefer),
//   and in the OFF-SEASON it shops for what has been beating it
//   (learnedUpgrades, read by evolution.js).
//
// Pure logic over the career save, like the rest of js/logic.

import { assembleRobot } from "./build.js";
import { buildShape } from "./shape.js";
import { gauntlet } from "./trials.js";
import { setSlot, fitBody, fitWithin, reinforce, summarize, partsFor, mountsFor, uniqExtras, weaponClassOf } from "./workshop.js";
import { makeRng, hashSeed } from "../core/rng.js";

/** Where each weapon class mostly lands its hits. */
export const THREAT_FACES = {
  spinner_h: ["side", "front"], spinner_v: ["front", "top"], drum: ["front"], hammer: ["top"],
  crusher: ["top", "front"], flipper: ["front"], lifter: ["front"], static: ["front"], none: ["front"],
};
const FLIPS = new Set(["flipper", "lifter", "spinner_v"]);
const TIER_OF = { rookie: 1, pro: 2, elite: 3, world: 3 };
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** A robot's memory, made on first use. */
export function memoryOf(career, id) {
  career.ai ||= {};
  return (career.ai[id] ||= { vs: {}, setups: {}, fights: 0 });
}

/** The tactics a robot has learned against a weapon class. */
export function tacticsVs(career, id, oppClass) {
  const m = career.ai?.[id];
  const t = m?.vs?.[oppClass]?.t;
  return t ? { flank: t.flank || 0, aggression: t.aggression || 0, herd: t.herd || 0 } : null;
}

// ---------------------------------------------------------------- before a fight

/**
 * The changes a team could make to its robot for this opponent. Each is
 * { label, design, why } where design is the robot's { build, body,
 * personality }, legal and on weight.
 */
const optionCache = new Map();
export function setupOptions(reg, def, oppDef) {
  // The same robot against the same weapon class has the same options: a
  // season asks thousands of times, so remember them (not saved - derived).
  const oppCls0 = weaponClassOf(reg, oppDef.build);
  const key = `${def.id}|${def.league}|${JSON.stringify(def.build)}|${JSON.stringify(def.body)}|${oppCls0}`;
  if (optionCache.has(key)) return optionCache.get(key);
  if (optionCache.size > 4000) optionCache.clear();
  const result = computeOptions(reg, def, oppDef);
  optionCache.set(key, result);
  return result;
}
function computeOptions(reg, def, oppDef) {
  const oppCls = weaponClassOf(reg, oppDef.build);
  const myCls = weaponClassOf(reg, def.build);
  const tier = TIER_OF[def.league] ?? 1;
  const base = { name: def.name, build: clone(def.build), body: clone(def.body) || {}, livery: def.livery, personality: def.personality };
  const out = [];
  const add = (label, d, why) => {
    const fitted = fitWithin(reg, d, ["rear", "top", "side"]);
    if (!fitted) return;
    try { if (!summarize(reg, { ...def, ...fitted }).legal) return; } catch { return; }
    out.push({ label, design: fitted, why });
  };
  if (def.partner) return out;   // a multibot keeps its pair as built

  // 1. The weapon: a heavier or lighter rotor, a different blade - whatever
  //    of the same kind its body carries and the team can get at this level.
  const cur = def.build.weapon ? reg.part(def.build.weapon) : null;
  if (cur?.spec.powered) {
    const curE = energyOf(reg, def.build);
    for (const p of partsFor(reg, "weapon")) {
      if (p.id === cur.id || p.spec.class !== cur.spec.class || (p.tier ?? 1) > tier) continue;
      const build = setSlot(reg, def.build, "weapon", p.id);
      if (!mountsFor(reg, build).includes(def.body?.mount || "front")) continue;
      const e = energyOf(reg, build);
      const kind = (p.spec.style || "") !== (cur.spec.style || "") || p.spec.radiusIn !== cur.spec.radiusIn ? "a different" : "";
      const label = e > curE * 1.08 ? `heavier ${p.name}` : e < curE * 0.92 ? `lighter, faster-spinning ${p.name}` : `${kind || "another"} ${p.name}`;
      add(label, { ...base, build, body: fitBody(reg, base.body, build) },
        e > curE ? "more energy per hit" : "spins up faster between hits");
    }
  }
  // 2. A wedge on the front: forks or a plow make a horizontal bar glance
  //    off and get under pushers, lifters and flippers.
  if (["spinner_h", "static", "lifter", "flipper"].includes(oppCls)) {
    for (const type of ["forks", "plow"]) {
      if ((base.body.extras || []).some((e) => e.type === type)) continue;
      if (base.body.mount === "low" || myCls === "static") continue;
      add(`added ${type === "plow" ? "a plow" : "wedge forks"}`, { ...base, body: { ...base.body, extras: uniqExtras([...(base.body.extras || []), { type }]) } },
        oppCls === "spinner_h" ? "a horizontal bar glances off a wedge" : "gets under it first");
    }
  }
  // 3. Armour where this opponent hits.
  for (const face of THREAT_FACES[oppCls] || ["front"]) {
    const d = reinforce(reg, base, face, THREAT_FACES[oppCls]);
    if (d) add(`heavier ${face} armour`, d, `its ${oppCls.replace("_", " ")} hits the ${face}`);
  }
  // 4. A way back over, against something that flips.
  if (FLIPS.has(oppCls) && !def.build.srimech) {
    const a = assembleRobot(reg, def);
    let inv = false;
    try { inv = buildShape(a).invertible; } catch { inv = false; }
    if (!inv && a.stats.selfRight.via !== "weapon") {
      add("fitted a self-righter", { ...base, build: setSlot(reg, def.build, "srimech", "srimech_arm") }, "it wins by flipping");
    }
  }
  return out;
}

const energyOf = (reg, build) => {
  const w = build.weapon ? reg.part(build.weapon).spec : null;
  if (!w) return 0;
  if (w.impactEnergyJ) return w.impactEnergyJ;
  const r = (w.radiusIn || 6) * 0.0254;
  const om = (w.maxTipSpeedMps || 100) / r;
  return 0.5 * (w.rotorInertiaKgM2 || 0) * om * om;
};

/** How promising a change looks before any testing: memory first, then the matchup. */
function priorScore(reg, career, id, oppCls, opt, def) {
  const mem = career.ai?.[id]?.setups?.[oppCls]?.[keyOf(opt.label)] ?? 0;
  let s = mem * 0.25;
  const l = opt.label;
  if (/forks|plow/.test(l)) s += oppCls === "spinner_h" ? 0.35 : 0.12;
  if (/self-righter/.test(l)) s += 0.4;
  if (/armour/.test(l)) s += 0.15;
  if (/heavier/.test(l)) s += ["hammer", "crusher", "static", "lifter"].includes(oppCls) ? 0.2 : 0.05;
  if (/lighter/.test(l)) s += ["spinner_h", "spinner_v", "drum"].includes(oppCls) ? 0.12 : -0.05;
  return s;
}
/** Memory keys ignore the specific part ("heavier 34in bar" and "heavier 26in bar" are both "heavier"). */
const keyOf = (label) => label.split(" ")[0] === "heavier" || label.split(" ")[0] === "lighter," ? label.split(" ")[0].replace(",", "") : label.replace(/ \d.*$/, "");

/**
 * Set a robot up for one fight. Returns the def it fights as and the changes
 * made (for scouting and the results), and remembers it for learnFromFight.
 * @param opts.depth   0: judge from memory (AI vs AI, instant); n: test the
 *                     best n options in trial fights (against the player)
 * @param opts.fights  trial fights per option
 * @param opts.cond    { id: [conditions] } for the trial fights
 */
export function prepareFor(reg, career, id, def, oppDef, { depth = 0, fights = 12, salt = "", cond = null, explore = 0.15 } = {}) {
  const oppCls = weaponClassOf(reg, oppDef.build);
  const tactics = tacticsVs(career, id, oppCls);
  const fighting = (d) => ({ ...def, build: d.build, body: d.body, personality: d.personality, tactics, learnRate: def.learnRate });
  const opts = setupOptions(reg, def, oppDef).map((o) => ({ ...o, prior: priorScore(reg, career, id, oppCls, o, def) }))
    .sort((a, b) => b.prior - a.prior);
  let chosen = [];
  if (depth > 0 && opts.length) {
    // Test the best-looking options (and the best two together) against this opponent.
    const t = (d) => gauntlet(reg, fighting(d), [oppDef], { seeds: fights, salt: `prep:${salt}`, cond }).winRate;
    const base = t({ build: def.build, body: def.body, personality: def.personality });
    const tried = opts.slice(0, depth).map((o) => ({ ...o, win: t(o.design) }));
    tried.sort((a, b) => b.win - a.win);
    const good = tried.filter((o) => o.win > base + 0.04);
    if (good.length >= 2) {
      const both = combine(reg, def, good[0], good[1]);
      if (both) { const w = t(both.design); if (w > good[0].win + 0.03) chosen = [{ ...both, win: w }]; }
    }
    if (!chosen.length && good.length) chosen = [good[0]];
  } else if (opts.length) {
    // Judgement: the most promising change, if it looks worth making; and now
    // and then something new, which is how a team finds out.
    const rng = makeRng(hashSeed(`prep:${career.seed}:${salt}:${id}`));
    if (rng.next() < explore) chosen = [opts[Math.floor(rng.next() * opts.length)]];
    else if (opts[0].prior >= 0.15) chosen = [opts[0]];
  }
  const pick = chosen[0];
  const d = pick ? pick.design : { build: def.build, body: def.body, personality: def.personality };
  const changes = pick ? pick.label.split(" + ") : [];
  memoryOf(career, id).pending = { oppClass: oppCls, changes };
  return { def: fighting(d), changes, tactics };
}

/** Two changes made together, if they still fit. */
function combine(reg, def, a, b) {
  const build = clone(a.design.build);
  for (const k of Object.keys(b.design.build)) if (k !== "armor" && JSON.stringify(b.design.build[k]) !== JSON.stringify(def.build[k])) build[k] = b.design.build[k];
  if (JSON.stringify(b.design.build.armor) !== JSON.stringify(def.build.armor)) build.armor = b.design.build.armor;
  const body = { ...a.design.body, extras: uniqExtras([...(a.design.body.extras || []), ...(b.design.body.extras || [])]) };
  const d = fitWithin(reg, { ...a.design, build, body: fitBody(reg, body, build) }, ["rear", "top"]);
  return d ? { label: `${a.label} + ${b.label}`, design: d } : null;
}

// ---------------------------------------------------------------- after a fight

/**
 * Remember a fight: the record against that class, how it lost, whether the
 * setup it ran worked, and the tactics to try next time - including what its
 * driver learned during the fight (physics fights report it).
 * @param o { oppClass, won, method, cause, learned?: { flank, aggression }, learnRate }
 */
export function learnFromFight(career, id, { oppClass, won, method, cause, learned = null, learnRate = 0.7 }) {
  const m = memoryOf(career, id);
  const v = (m.vs[oppClass] ||= { f: 0, w: 0, lossBy: {}, t: { flank: 0, aggression: 0, herd: 0 } });
  v.f++; if (won) v.w++;
  m.fights++;
  const lr = 0.12 * learnRate;
  const how = method === "ko" ? `ko:${cause || "disabled"}` : method;
  if (!won) v.lossBy[how] = (v.lossBy[how] || 0) + 1;
  // Tactics: lost on points -> press harder; knocked out by a weapon -> come
  // in from the side; flipped or beached -> keep the nose away and herd.
  if (!won) {
    if (method === "decision") v.t.aggression += lr;
    else if (cause === "flipped" || cause === "beached") { v.t.flank += lr; v.t.herd -= lr * 0.5; }
    else if (method === "ko" || method === "tapout") v.t.flank += lr * 0.8;
  } else {
    v.t.aggression += lr * 0.2;
  }
  // What the driver learned in the fight carries over, partly.
  if (learned) {
    v.t.flank += (learned.flank || 0) * 0.3 * learnRate;
    v.t.aggression += (learned.aggression || 0) * 0.3 * learnRate;
  }
  for (const k of ["flank", "aggression", "herd"]) v.t[k] = clamp(v.t[k] * 0.97, -0.4, 0.4);   // slowly forgets
  // The setup it ran: credit or blame.
  const p = m.pending;
  if (p && p.oppClass === oppClass) {
    const s = (m.setups[oppClass] ||= {});
    for (const c of p.changes) s[keyOf(c)] = clamp((s[keyOf(c)] || 0) * 0.85 + (won ? 1 : -1), -4, 4);
    if (!p.changes.length) s.none = clamp((s.none || 0) * 0.85 + (won ? 1 : -1), -4, 4);
  }
  m.last = { oppClass, won, how, changes: p?.changes || [] };
  delete m.pending;
}

// ---------------------------------------------------------------- rebuilding

/** The pit's preferences before a fight against `oppClass`: the faces it hits, and a self-righter against a flipper. */
export function pitPrefer(oppClass) {
  if (!oppClass) return null;
  return { faces: THREAT_FACES[oppClass] || [], categories: FLIPS.has(oppClass) ? ["srimech"] : [] };
}

/** The weapon classes a robot has lost to most, worst first: [{ cls, losses, how }]. */
export function threatsOf(career, id) {
  const vs = career.ai?.[id]?.vs || {};
  return Object.entries(vs)
    .map(([cls, v]) => ({ cls, losses: v.f - v.w, f: v.f, how: Object.entries(v.lossBy).sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => b.losses - a.losses);
}

/**
 * Off-season ideas from experience: designs aimed at what has been beating
 * this robot. evolution.js tests them like any other upgrade.
 */
export function learnedUpgrades(reg, career, def) {
  const out = [];
  const base = { name: def.name, build: clone(def.build), body: clone(def.body) || {}, personality: def.personality };
  for (const t of threatsOf(career, def.id).slice(0, 2)) {
    if (t.how === "ko:flipped" && !def.build.srimech) {
      const d = fitWithin(reg, { ...base, build: setSlot(reg, def.build, "srimech", "srimech_arm") }, ["rear", "top", "side"]);
      if (d) out.push({ build: d.build, note: `fitted a self-righter after losing to ${t.cls.replace("_", " ")}s`, cost: reg.part("srimech_arm").cost });
    }
    for (const face of (THREAT_FACES[t.cls] || []).slice(0, 1)) {
      const d = reinforce(reg, base, face, THREAT_FACES[t.cls]);
      if (d) out.push({ build: d.build, note: `heavier ${face} armour against ${t.cls.replace("_", " ")}s`, cost: armourCost(reg, def.build, d.build) });
    }
    if (t.how === "decision" || t.how === "ko:beached") {
      const motors = partsFor(reg, "motor").filter((p) => p.cost > reg.part(def.build.motor).cost && (p.tier ?? 1) <= (TIER_OF[def.league] ?? 1));
      for (const p of motors.slice(0, 1)) {
        const d = fitWithin(reg, { ...base, build: setSlot(reg, def.build, "motor", p.id) }, ["rear", "top", "side"]);
        if (d) out.push({ build: d.build, note: `stronger drive after being out-pushed`, cost: p.cost });
      }
    }
  }
  return out;
}
const armourCost = (reg, a, b) => Math.max(0, (b.armor || []).reduce((t, id) => t + reg.part(id).cost, 0) - (a.armor || []).reduce((t, id) => t + reg.part(id).cost, 0) * 0.4);
