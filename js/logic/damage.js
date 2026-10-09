// damage.js - resolving one impact into part-level damage.
//
// Pure logic. The simulation tells it "this weapon, with this much stored
// energy, hit that fitting, this squarely"; it decides what broke. No physics
// calls, no rendering, no Math.random - all variance comes from a seeded RNG so
// a replay or a saved season reproduces exactly.
//
// Routing is geometric, not guessed: Stage 1 already maps every collider handle
// to a fitting key, so a hit that lands on the left side panel damages
// `armor.1` and not some abstract "side". Armour then passes a fraction of the
// blow through to ONE internal part, which is where "that hit took out his
// drive" comes from.

import { partStatus, STATUS } from "./condition.js";

/** Energy a moving mass carries, for ram damage. */
export const kineticEnergyJ = (massKg, speedMps) => 0.5 * massKg * speedMps * speedMps;

/**
 * Convert delivered energy into raw hit points.
 *
 * `concentration` is what separates archetypes: a hammer tip puts 2 kJ through
 * a small area and punches a hole, while a bar spreads 20 kJ over a wide arc.
 * Same currency, very different feel.
 */
export function energyToHp(deliveredJ, concentration, rules) {
  return (deliveredJ / 1000) * rules.damage.hpPerKilojoule * concentration;
}

/**
 * How much of a weapon's stored energy a given hit actually delivers.
 * `squareness` is 0 for a glancing graze and 1 for a dead-square hit.
 */
export function energyTransfer(squareness, rules, rng) {
  const t = rules.damage.transfer;
  const sq = clamp01(squareness);
  let frac = t.min + (t.max - t.min) * sq;
  if (sq > 0.9) frac *= t.squareHitBonus;
  // +/-15% so identical-looking hits are not identical.
  frac *= 0.85 + (rng ? rng.next() : 0.5) * 0.3;
  return clamp(frac, t.min * 0.6, 1);
}

/** Label a hit by how much of the struck part it took. */
export function severityOf(hpLost, partHp, rules) {
  const s = rules.damage.severity;
  const frac = partHp > 0 ? hpLost / partHp : 0;
  if (frac >= s.catastrophic) return "catastrophic";
  if (frac >= s.heavy) return "heavy";
  if (frac >= s.hit) return "hit";
  if (frac >= s.glance) return "glance";
  return "scratch";
}

/**
 * Apply hp of damage to one fitting. Mutates `assembled.condition`.
 * Returns a record of what happened, or null if the fitting does not exist.
 */
export function damageFitting(assembled, key, hp, rules) {
  const fitting = assembled.fittings.find((f) => f.key === key);
  if (!fitting) return null;

  const th = rules.damage.thresholds;
  const partHp = fitting.part.hp;
  const before = assembled.condition[key] ?? 1;
  const statusBefore = partStatus(before, th);

  // Damage beyond what the part has left is wasted on it, not carried over.
  const hpAvailable = partHp * before;
  const hpLost = Math.min(hp, hpAvailable);
  const after = partHp > 0 ? clamp01(before - hpLost / partHp) : 0;

  assembled.condition[key] = after;
  const statusAfter = partStatus(after, th);

  return {
    key,
    partId: fitting.part.id,
    name: fitting.part.name,
    category: fitting.part.category,
    hpLost,
    hpOverkill: Math.max(0, hp - hpAvailable),
    conditionBefore: before,
    conditionAfter: after,
    statusBefore,
    statusAfter,
    failed: statusAfter === STATUS.FAILED && statusBefore !== STATUS.FAILED,
    degraded: statusAfter !== statusBefore,
    severity: severityOf(hpLost, partHp, rules),
  };
}

/** Internal parts that a blow through the armour can find. */
const INTERNALS = ["electronics", "battery", "motor", "drive", "weaponMotor", "srimech", "chassis"];

/**
 * Pick which internal part a pass-through blow damages, weighted by how
 * vulnerable each is. The chassis is the fallback, so a blow always lands
 * somewhere.
 */
export function pickInternal(assembled, rules, rng) {
  const vuln = rules.damage.vulnerability;
  const candidates = assembled.fittings.filter(
    (f) => INTERNALS.includes(f.part.category) && (assembled.condition[f.key] ?? 1) > 0
  );
  if (!candidates.length) return null;

  const weights = candidates.map((f) => vuln[f.part.category] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = (rng ? rng.next() : 0.5) * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i].key;
  }
  return candidates[candidates.length - 1].key;
}

/**
 * Resolve one weapon impact.
 *
 * @param {object} o
 * @param {object} o.attacker    assembled robot dealing the hit
 * @param {object} o.defender    assembled robot taking it (condition mutated)
 * @param {string} o.targetKey   fitting struck, from the collider map
 * @param {number} o.storedEnergyJ  energy the weapon has RIGHT NOW
 * @param {number} o.squareness  0..1
 * @param {object} o.rules
 * @param {object} o.rng         seeded
 * @returns a result describing every part affected, plus the impulse and the
 *          energy the attacker's weapon lost - the simulation needs both.
 */
export function resolveHit({ attacker, defender, targetKey, storedEnergyJ, squareness = 0.5, rules, rng }) {
  const d = rules.damage;
  const w = attacker.stats.weapon;

  const transfer = energyTransfer(squareness, rules, rng);
  const deliveredJ = Math.max(0, storedEnergyJ) * transfer;
  // The balance pass's per-class lever (rules.json damage.classScale).
  const rawHp = energyToHp(deliveredJ, w.concentration, rules) * (d.classScale?.[w.class] ?? 1);

  const result = {
    deliveredJ,
    transfer,
    rawHp,
    squareness,
    hits: [],
    selfHit: null,
    impulseNs: 0,
    severity: "scratch",
    failures: [],
    defenderImmobilised: false,
  };

  if (deliveredJ <= 0 || rawHp <= 0) return result;

  const struck = defender.fittings.find((f) => f.key === targetKey);
  const targetIsArmor = struck && struck.part.category === "armor";

  let passThroughHp;

  if (targetIsArmor) {
    const spec = struck.part.spec;
    const panelCondition = defender.condition[targetKey] ?? 1;

    // Hard armour resists; springy armour deflects energy back out as impulse.
    const absorbedHp = rawHp / Math.max(0.2, spec.hardness);
    const rec = damageFitting(defender, targetKey, absorbedHp, rules);
    if (rec) result.hits.push(rec);

    result.impulseNs += deliveredJ * d.deflectionImpulseFraction * (spec.deflection ?? 1) * 0.01;

    // An intact panel keeps most of the blow out. A destroyed one keeps none.
    // A concentrated blow (a hammer's spike, a crusher's beak) punches more
    // of itself through than a wide one: `pierce` per unit of concentration
    // over 1.5.
    const pierce = 1 + (d.pierce ?? 0) * Math.max(0, (w.concentration ?? 1) - 1.5);
    const through = panelCondition > 0 ? Math.min(0.9, d.armorPassThrough * pierce) : 1.0;
    passThroughHp = rawHp * through;
  } else {
    // A bare face, or a direct hit on the weapon or the chassis.
    const vuln = d.vulnerability[struck ? struck.part.category : "chassis"] ?? 1;
    const rec = damageFitting(defender, targetKey, rawHp * vuln, rules);
    if (rec) result.hits.push(rec);
    result.impulseNs += deliveredJ * 0.004;
    passThroughHp = 0;
  }

  // Blow through the armour into something that matters.
  if (passThroughHp > 0.5) {
    const internalKey = pickInternal(defender, rules, rng);
    if (internalKey) {
      const f = defender.fittings.find((x) => x.key === internalKey);
      const vuln = d.vulnerability[f.part.category] ?? 1;
      const rec = damageFitting(defender, internalKey, passThroughHp * vuln, rules);
      if (rec) {
        rec.throughArmor = true;
        result.hits.push(rec);
      }
    }
  }

  // Hitting things breaks your own weapon too. Spinners pay the most for it,
  // which is why a bar that lands a huge hit often loses a tooth doing it.
  if (d.selfDamageOnHit && attacker.parts.weapon) {
    const selfHp = rawHp * (w.selfDamageFraction ?? 0.1) * (d.vulnerability.weapon ?? 1);
    const rec = damageFitting(attacker, "weapon", selfHp, rules);
    if (rec) result.selfHit = rec;
  }

  // Summarise.
  result.severity = result.hits.reduce(
    (worst, h) => (SEVERITY_ORDER[h.severity] > SEVERITY_ORDER[worst] ? h.severity : worst),
    "scratch"
  );
  result.failures = result.hits.filter((h) => h.failed);
  result.energyConsumedJ = deliveredJ;

  return result;
}

/**
 * Resolve a ram - two bots colliding with no weapon involved.
 *
 * Deliberately much weaker per joule than a weapon hit (`rammingHpPerKilojoule`
 * vs `hpPerKilojoule`): shoving is for control and aggression points, not for
 * taking someone apart. Below `minRamEnergyJ` nothing happens at all, so bots
 * nudging each other does not grind them down.
 */
export function resolveRam({ attacker, defender, targetKey, relativeSpeedMps, rules, rng }) {
  const d = rules.damage;
  const massKg = Math.min(attacker.massKg, defender.massKg);
  const energyJ = kineticEnergyJ(massKg, relativeSpeedMps);

  if (energyJ < d.minRamEnergyJ) {
    return { deliveredJ: 0, hits: [], severity: "none", failures: [], impulseNs: 0, ignored: true };
  }

  // A wedge rams better than a flat face.
  const concentration = attacker.stats.weapon.concentration || 0.4;
  const rawHp = (energyJ / 1000) * d.rammingHpPerKilojoule * concentration;

  const result = { deliveredJ: energyJ, rawHp, hits: [], selfHit: null, failures: [], impulseNs: energyJ * 0.002 };
  const struck = defender.fittings.find((f) => f.key === targetKey);
  const vuln = d.vulnerability[struck ? struck.part.category : "chassis"] ?? 1;

  const rec = damageFitting(defender, targetKey || "chassis", rawHp * vuln, rules);
  if (rec) result.hits.push(rec);

  result.severity = rec ? rec.severity : "none";
  result.failures = result.hits.filter((h) => h.failed);
  return result;
}

/** Restore everything to factory condition - used by the pit and by tests. */
export function repairAll(assembled) {
  for (const f of assembled.fittings) assembled.condition[f.key] = 1;
}

const SEVERITY_ORDER = { scratch: 0, glance: 1, hit: 2, heavy: 3, catastrophic: 4 };
export { SEVERITY_ORDER };

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
