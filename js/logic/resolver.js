// resolver.js - a whole fight in a few milliseconds, with no physics.
//
// A season is hundreds of AI-vs-AI fights; a refereed physics bout takes about
// a second each. The resolver plays the same fight at the level of EXCHANGES:
// every half second the robots may engage, and when they do each one gets a
// chance to land its weapon, ram, flip or drive the other into a hazard. What
// a landed hit does is decided by the real damage model (damage.js) on the
// real assembled robots, damaged parts slow them down through condition.js,
// and a fight that goes the distance is scored by the real judges
// (judging.js). So a resolved fight leaves the same kind of record a physics
// fight does - winner, method, cards, and part-level damage that carries out
// of the match.
//
// Every tunable number is in rules.json `resolver`, calibrated against real
// physics bouts with tools/calibrate.js. Pure logic, seeded: the same seed
// always resolves the same fight.
//
// Multibots: a side is one or more units. A unit is chosen to attack and to
// be attacked by its share of the side's weight, and a side is knocked out
// when more than half its weight is disabled - the show's rule.

import { assembleRobot, assemblePartner } from "./build.js";
import { buildShape } from "./shape.js";
import { effectiveStats } from "./condition.js";
import { resolveHit, resolveRam, damageFitting } from "./damage.js";
import { familyOf, FAMILY } from "./weapon.js";
import { aiProfile } from "./ai.js";
import { judgingConfig, judgeCards } from "./judging.js";
import { makeRng, hashSeed } from "../core/rng.js";

const DEFAULTS = {
  tickS: 0.5,
  engageRate: 0.34,            // chance per tick of an exchange, at average aggression
  hitBase: 0.36,               // chance a ready weapon lands, per exchange, at skill 0.5
  skillSpread: 0.9,            // how much skill moves the hit chance
  agilityWeight: 0.35,         // a faster, nimbler target is harder to hit
  ramChance: 0.45,             // a weaponless (or unready) unit rams instead
  ramSpeedFrac: [0.35, 0.8],   // of top speed, on a ram
  flipChance: 0.55,            // a landed flipper/lifter hit turns the target over
  hammerFlipChance: 0.1,
  selfRightChance: { srimech: 0.92, weapon: 0.75, gyro: 0.45 },   // per attempt
  hazardChance: 0.05,          // per exchange, the stronger pusher shoves the other into a hazard
  hazardHp: 70,
  squareness: [0.15, 0.95],    // range, centred higher with skill
  crusherBiteFrac: 0.6,        // of a bite's energy delivered when held
  driveFloor: 0.18,            // tractive force below this share of rated = cannot move
  countS: 10,
  // How well each weapon class lands its hits in practice, relative to 1.
  // Physics, not theory: a hammer has to be lined up and timed, a bar just
  // has to be pointed roughly the right way.
  classEdge: { spinner_h: 1.5, spinner_v: 1.0, drum: 1.0, hammer: 0.5, flipper: 0.8, lifter: 0.5, crusher: 0.6, static: 1.0, none: 0.6 },
  // Beaching: getting under a robot and leaving it on top of you, wheels off
  // the floor. Chance per exchange by the attacker's class, and per tick that
  // a beached robot drives itself off.
  beachChance: { static: 0.12, flipper: 0.06, lifter: 0.06, spinner_h: 0.04, drum: 0.02, spinner_v: 0.02, hammer: 0.01, crusher: 0.03, none: 0.02 },
  forksBeachBonus: 0.04,
  // Each unit of a multibot is a smaller robot with less of everything: it
  // lands less and gets shoved and beached more. Not calibrated against
  // physics yet (physics fights a multibot as its main unit), so set to put
  // multibots near an even record.
  multibotEdge: 0.6,
  multibotExposure: 1.4,       // ...and is easier to hit, beach and flip
  adaptCap: 0.15,              // the most a driver learns to dodge in one fight
  beachEscape: 0.12,
  wedgePushS: 1.0,             // extra control a wedge earns per exchange
};

/** Resolver config: rules.json `resolver` over the defaults. */
export function resolverConfig(rules) {
  return { ...DEFAULTS, ...(rules.resolver || {}) };
}

/** Assemble a side's units from a robot def (a multibot brings its partner). */
export function sideUnits(reg, def, conditions = null) {
  const units = [assembleRobot(reg, def)];
  if (def.partner) units.push(assemblePartner(reg, def));
  if (conditions) units.forEach((u, i) => Object.assign(u.condition, conditions[i] || {}));
  return units;
}

/**
 * Resolve one fight.
 * @param reg
 * @param a, b         robot DEFS (ratings, leagues and personalities as fielded)
 * @param opts.seed
 * @param opts.conditionA/B  per-unit condition maps to start from (a robot
 *                     that shows up damaged); default factory fresh
 * @returns { winnerId, loserId, method, cause, elapsedS, decision, cards, votes,
 *            tally, sides: { [id]: { hpDealt, hpTaken, hitsLanded, flips, ko,
 *            condition: [per unit] } } }
 */
export function resolveFight(reg, a, b, { seed = 1, conditionA = null, conditionB = null } = {}) {
  const rules = reg.rules;
  const cfg = resolverConfig(rules);
  const jcfg = judgingConfig(rules);
  const wpn = rules.weapons || {};
  const rng = makeRng(hashSeed(`resolve:${seed}:${a.id}:${b.id}`));

  const side = (def, conds) => {
    const units = sideUnits(reg, def, conds).map((assembled) => unitState(assembled, def, rules));
    return {
      id: def.id, def, units,
      weightLb: units.reduce((s, u) => s + u.a.weightLb, 0),
      tally: { damage: 0, hpDealt: 0, failures: 0, hazardHp: 0, advancingS: 0, attacks: 0,
        pushingS: 0, oppDisabledS: 0, ownDisabledS: 0, selfHazard: 0, hitsLanded: 0, flips: 0 },
      hpTaken: 0,
      out: false, outAt: null, cause: null,
    };
  };
  const A = side(a, conditionA), B = side(b, conditionB);

  const live = (s) => s.units.filter((u) => !u.disabled);
  const disabledShare = (s) => s.units.filter((u) => u.disabled).reduce((t, u) => t + u.a.weightLb, 0) / s.weightLb;
  const pickByWeight = (units) => {
    const tot = units.reduce((t, u) => t + u.a.weightLb, 0);
    let r = rng.next() * tot;
    for (const u of units) { r -= u.a.weightLb; if (r <= 0) return u; }
    return units[units.length - 1];
  };

  const duration = rules.match?.durationS ?? 180;
  let t = 0;
  let ended = null;

  const credit = (atk, def, res, kind) => {
    const hp = (res.hits || []).reduce((s, h) => s + h.hpLost, 0);
    const failures = (res.failures || []).length;
    atk.tally.damage += hp + failures * jcfg.failureBonusHp;
    atk.tally.hpDealt += hp;
    atk.tally.failures += failures;
    if (kind === "hazard") atk.tally.hazardHp += hp;
    else { atk.tally.hitsLanded++; atk.tally.attacks += kind === "weapon" ? 1 : 0.5; }
    def.hpTaken += hp;
  };

  // A unit whose drive is gone, or that is upside down with no way back, is
  // disabled for good; the count runs from then.
  const checkDisabled = (u) => {
    if (u.disabled) return;
    const e = effectiveStats(u.a, rules);
    u.eff = e;
    const driveShare = e.tractiveForceN / Math.max(1, u.a.stats.forcePerWheelN * u.a.stats.drivenWheels);
    if (e.immobile || driveShare < cfg.driveFloor) {
      u.disabled = true;
      u.cause = e.chassisGone ? "chassis" : e.electronicsGone ? "electronics" : e.wheelCount <= 0 ? "wheels" : "drive";
      u.disabledAt = t;
    }
  };

  for (; t < duration && !ended; t += cfg.tickS) {
    for (const s of [A, B]) {
      for (const u of s.units) {
        if (u.disabled) continue;
        // Kinetic weapons spool between exchanges.
        if (u.family === FAMILY.KINETIC && u.eff.weapon.energyJ > 0 && isFinite(u.eff.weapon.spinUpS)) {
          u.spool = Math.min(1, u.spool + cfg.tickS / Math.max(0.3, u.eff.weapon.spinUpS));
        }
        u.reload = Math.max(0, u.reload - cfg.tickS);
        // Beached: try to drive off whatever it is stranded on.
        if (u.beached) {
          u.beachT += cfg.tickS;
          if (rng.bool(cfg.beachEscape * Math.min(1.5, 0.5 + (u.eff.tractiveForceN || 0) / Math.max(1, u.a.massKg * 9.81)))) { u.beached = false; u.beachT = 0; }
          else if (u.beachT >= cfg.countS + 1) { u.disabled = true; u.cause = "beached"; u.disabledAt = t; }
        }
        // Flipped and trying to get back over.
        if (u.flipped) {
          u.flipT += cfg.tickS;
          const via = u.a.stats.selfRight.via;
          if (via !== "none" && u.flipT >= 1 && rng.bool(cfg.selfRightChance[via] ?? 0.7)) { u.flipped = false; u.flipT = 0; }
          else if (u.flipT >= cfg.countS + 1) { u.disabled = true; u.cause = "flipped"; u.disabledAt = t; }
        }
      }
    }

    // Is a side out? More than half its weight disabled, counted out.
    for (const [s, o] of [[A, B], [B, A]]) {
      const share = disabledShare(s);
      if (share > 0.5) {
        const since = Math.max(...s.units.filter((u) => u.disabled).map((u) => u.disabledAt));
        s.tally.ownDisabledS += cfg.tickS; o.tally.oppDisabledS += cfg.tickS;
        if (t - since >= cfg.countS && !ended) {
          ended = { winner: o, loser: s, method: "ko", cause: s.units.find((u) => u.disabled).cause };
        }
      }
    }
    if (ended) break;

    const free = (u) => !u.flipped && !u.beached;
    const la = live(A).filter(free), lb = live(B).filter(free);
    if (!la.length || !lb.length) continue;

    // An exchange this tick? Aggressive drivers start more of them.
    const aggr = (units) => units.reduce((m, u) => Math.max(m, u.aggression), 0);
    const pEngage = cfg.engageRate * (aggr(la) + aggr(lb)) / 2;
    if (!rng.bool(pEngage)) continue;

    // Who drove it: initiative goes to the keener, quicker driver.
    const initA = aggr(la) * (0.7 + speed(la) * 0.06) * (0.6 + skillOf(la));
    const initB = aggr(lb) * (0.7 + speed(lb) * 0.06) * (0.6 + skillOf(lb));
    const leader = rng.next() < initA / (initA + initB) ? A : B;
    leader.tally.advancingS += cfg.tickS * 2;

    // Pushing: the stronger pusher controls where it goes.
    const pushA = push(la), pushB = push(lb);
    const pusher = rng.next() < pushA / (pushA + pushB) ? A : B;
    pusher.tally.pushingS += cfg.tickS * 2;

    // Both sides swing, the leader first.
    for (const [s, o] of leader === A ? [[A, B], [B, A]] : [[B, A], [A, B]]) {
      const atk = pickByWeight(live(s).filter(free));
      const targets = live(o).filter(free);
      if (!atk || !targets.length) continue;
      const def = pickByWeight(targets);
      attack(atk, def, s, o);
      checkDisabled(def);
      checkDisabled(atk);
    }

    // The arena bites: the pusher drives the other into a hazard.
    const victimSide = pusher === A ? B : A;
    const hazardP = cfg.hazardChance * (0.5 + skillOf(live(pusher)));
    if (rng.bool(hazardP) && live(victimSide).length) {
      const v = pickByWeight(live(victimSide));
      const key = pickTarget(v.a, rng, "hazard");
      const rec = damageFitting(v.a, key, cfg.hazardHp * rng.float(0.6, 1.4), rules);
      if (rec) credit(pusher, victimSide, { hits: [rec], failures: rec.failed ? [rec] : [] }, "hazard");
      checkDisabled(v);
    }
  }

  function attack(atk, def, s, o) {
    const w = atk.eff.weapon;
    const prof = atk.prof;
    const skill = prof.skill;
    const agility = Math.min(2, (def.eff.topSpeedMps || 1) / 6 + (def.a.stats.pivotAuthority > 1.5 ? 0.2 : 0));
    const edge = (cfg.classEdge[w.class] ?? 1) * (s.units.length > 1 ? cfg.multibotEdge : 1);
    const exposed = o.units.length > 1 ? cfg.multibotExposure : 1;
    // `def.adapt`: what the defending driver has learned this fight about
    // keeping out of this weapon's way (see below).
    const pHit = clampN(cfg.hitBase * edge * exposed * (1 + (skill - 0.5) * cfg.skillSpread) * (1 - cfg.agilityWeight * (agility - 0.8)) * (1 - def.adapt), 0.03, 0.92);
    // Getting underneath: the defender is left stranded on the attacker.
    const pBeach = ((cfg.beachChance[w.class] ?? 0.02) + (atk.forks ? cfg.forksBeachBonus : 0)) * exposed;
    if (!def.invertible && rng.bool(pBeach)) {
      def.beached = true; def.beachT = 0;
      s.tally.pushingS += cfg.tickS * 2;
      s.tally.attacks += 0.5;
      return;
    }
    const sq = cfg.squareness[0] + (cfg.squareness[1] - cfg.squareness[0]) * clampN(rng.next() * 0.6 + skill * 0.4, 0, 1);
    const ready = !w.dead && (atk.family === FAMILY.KINETIC ? atk.spool > 0.35
      : atk.family === FAMILY.DISCRETE ? atk.reload <= 0
      : atk.family === FAMILY.CRUSHER ? atk.reload <= 0 : false);

    if (ready && rng.bool(pHit)) {
      const key = pickTarget(def.a, rng, w.class);
      let stored = w.energyJ;
      if (atk.family === FAMILY.KINETIC) stored *= atk.spool;
      if (atk.family === FAMILY.CRUSHER) stored *= cfg.crusherBiteFrac;
      // A rotor that meets a wedge face-on glances off it (weapons.wedgeDeflect).
      const glance = wpn.wedgeDeflect?.transfer?.[w.class];
      if (atk.family === FAMILY.KINETIC && glance != null && def.a.stats.weapon.class === "static" && rng.bool(cfg.wedgeFaceChance ?? 0.5)) stored *= glance;
      const res = resolveHit({ attacker: atk.a, defender: def.a, targetKey: key, storedEnergyJ: stored, squareness: sq, rules, rng });
      credit(s, o, res, "weapon");
      // Learning in the fight: every hit taken teaches the driver a little
      // more about how this weapon comes in (ai.js does the same in physics).
      def.adapt = Math.min(cfg.adaptCap, def.adapt + def.learn);
      // Every landed hit costs a rotor at least its class's share of spin.
      if (atk.family === FAMILY.KINETIC) atk.spool = Math.max(0, atk.spool - Math.max((res.energyConsumedJ || 0) / Math.max(1, w.energyJ), wpn.rotorSpend?.[w.class] ?? 0.25));
      else atk.reload = atk.family === FAMILY.CRUSHER ? (w.biteIntervalS || 0.7) * 2 : Math.max(cfg.tickS, w.cycleS || 1.5);
      // Flippers and lifters throw; hammers occasionally turn a bot over too.
      // Flippers throw, lifters tip, verticals launch, hammers occasionally
      // turn a bot over: a chance per landed hit, by class (fitted).
      const flipP = typeof cfg.flipChance === "object" ? cfg.flipChance[w.class] ?? 0
        : w.class === "flipper" ? cfg.flipChance : w.class === "lifter" ? cfg.flipChance * 0.7 : w.class === "hammer" ? cfg.hammerFlipChance : 0;
      if (flipP && !def.invertible && rng.bool(flipP)) {
        def.flipped = true; def.flipT = 0;
        s.tally.flips++;
        s.tally.attacks += 0.5;
      }
      return;
    }
    // No weapon ready: drive into them instead.
    if (rng.bool(cfg.ramChance * (w.class === "static" || w.class === "none" ? 1.6 : 1))) {
      const v = atk.eff.topSpeedMps * rng.float(cfg.ramSpeedFrac[0], cfg.ramSpeedFrac[1]);
      const res = resolveRam({ attacker: atk.a, defender: def.a, targetKey: pickTarget(def.a, rng, "ram"), relativeSpeedMps: v, rules, rng });
      if (!res.ignored) credit(s, o, res, "ram");
      // A good wedge gets under and shoves for control.
      if (w.class === "static") s.tally.pushingS += cfg.wedgePushS;
    }
  }

  const elapsedS = Math.min(t, duration);
  let result;
  if (ended) {
    result = { method: "ko", cause: ended.cause, winnerId: ended.winner.id, loserId: ended.loser.id, decision: null, cards: null, votes: null };
  } else {
    const raw = {};
    for (const [s, o] of [[A, B], [B, A]]) {
      raw[s.id] = {
        damage: s.tally.damage,
        aggression: s.tally.advancingS + s.tally.attacks * 1.5,
        control: Math.max(0, s.tally.pushingS + s.tally.oppDisabledS * 0.8 + s.tally.hazardHp * 0.03 +
          o.tally.selfHazard * 0.6 - s.tally.ownDisabledS * 0.5),
      };
    }
    const j = judgeCards(raw, [A.id, B.id], jcfg, seed);
    result = { method: "decision", cause: null, winnerId: j.winnerId, loserId: j.loserId, decision: j.decision, cards: j.cards, votes: j.votes, raw };
  }
  const sides = {};
  for (const s of [A, B]) {
    sides[s.id] = {
      hpDealt: Math.round(s.tally.hpDealt), hpTaken: Math.round(s.hpTaken),
      damageScore: Math.round(s.tally.damage),
      hitsLanded: s.tally.hitsLanded, flips: s.tally.flips,
      ko: result.method === "ko" && result.loserId === s.id,
      condition: s.units.map((u) => ({ ...u.a.condition })),
    };
  }
  return { ...result, elapsedS, sides };
}

function unitState(a, def, rules) {
  const prof = aiProfile(def);
  const shape = buildShape(a);
  const eff = effectiveStats(a, rules);
  const aggression = { aggressive: 1.25, opportunistic: 1.0, defensive: 0.78 }[prof.personality] ?? 1;
  return {
    a, prof, eff, aggression,
    invertible: shape.invertible,
    family: familyOf(a.stats.weapon.class),
    spool: 0.4,                 // spinners have spun up in the opening seconds
    adapt: 0,                   // learned this fight: how much harder it is to hit
    learn: (def.learnRate ?? 0.7) * 0.012 * (0.5 + prof.skill),
    reload: 0,
    flipped: false, flipT: 0,
    beached: false, beachT: 0,
    forks: (a.def?.body?.extras || []).some((e) => e.type === "forks" || e.type === "plow"),
    disabled: false, disabledAt: null, cause: null,
  };
}

/** Where a hit lands: mostly armour, sometimes the wheels, the weapon or bare chassis. */
function pickTarget(a, rng, kind) {
  const w = [];
  for (const f of a.fittings) {
    if (f.part.category !== "armor") continue;
    const slot = f.part.spec.slot;
    const top = kind === "hammer" || kind === "crusher" || kind === "hazard";
    w.push([f.key, slot === "front" ? 2.2 : slot === "side" ? 1 : slot === "top" ? (top ? 2.2 : 0.5) : 0.4]);
  }
  w.push(["wheel", kind === "spinner_h" ? 0.7 : 0.35]);
  if (a.parts.weapon) w.push(["weapon", 0.35]);
  w.push(["chassis", w.length <= 3 ? 1.5 : 0.3]);
  const tot = w.reduce((s, x) => s + x[1], 0);
  let r = rng.next() * tot;
  for (const [k, x] of w) { r -= x; if (r <= 0) return k; }
  return "chassis";
}

const speed = (units) => units.reduce((m, u) => Math.max(m, u.eff.topSpeedMps || 0), 0);
const skillOf = (units) => (units.length ? units.reduce((m, u) => Math.max(m, u.prof.skill), 0) : 0);
const push = (units) => units.reduce((s, u) => s + (u.eff.tractiveForceN || 0) * (0.6 + u.prof.skill * 0.4), 0) + 1;
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
