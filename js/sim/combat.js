// combat.js - turning physics contacts into damage.
//
// The bridge between the simulation and the pure damage model. It owns no
// damage rules of its own: it works out WHO hit WHAT, HOW SQUARELY and WITH
// HOW MUCH ENERGY, then hands that to js/logic/damage.js and applies whatever
// impulse comes back.
//
// Routing is geometric throughout. Stage 1 built a collider-handle -> fitting
// map for every robot; this file adds hazard colliders to the same index, so a
// hit is attributed to the exact panel that was struck rather than guessed at
// from a bounding box.

import { RAPIER } from "./physics.js";
import { resolveHit, resolveRam } from "../logic/damage.js";
import { familyOf, FAMILY } from "../logic/weapon.js";
import { EV } from "../core/bus.js";
import { sub, dot, len, normalize, scale, cross, add, applyQuat } from "../core/vec.js";

// Two bodies in contact generate events constantly. One exchange per pair per
// this interval keeps a scrape from being resolved as forty separate hits.
const PAIR_COOLDOWN_S = 0.22;

export function makeCombat({ sim, rules, rng, bus }) {
  const world = sim.world;
  // How each weapon class acts on what it hits, beyond hp: the throw, the
  // flip, the lift, the grip. All data (rules.json `weapons`).
  const W = rules.weapons || {};
  const eventQueue = new RAPIER.EventQueue(true);

  // colliderHandle -> { kind: "bot"|"hazard", id, key }
  const index = new Map();
  const bots = new Map();      // botId -> { robotSim, assembled, weapon }
  const hazards = new Map();   // hazardId -> hazard
  const cooldowns = new Map(); // "a|b" -> seconds remaining

  let clockS = 0;
  const log = [];

  // Counters, for working out WHERE a contact got dropped. Cheap, and the only
  // practical way to debug "the hazard clearly hit it but nothing happened".
  const stats = {
    rawStarted: 0, unindexed: 0, botVsBot: 0, hazardVsBot: 0,
    notLive: 0, noEnergy: 0, cooldown: 0, resolved: 0,
  };

  /**
   * @param team  robots on the same team (a multibot's units) can bump into
   *              each other but never damage each other. Default: its own.
   */
  function registerBot(botId, robotSim, weapon, team = botId) {
    const hull = [];
    let radius = 0;
    for (const piece of robotSim.shape?.pieces || []) {
      const key = robotSim.routes?.get(piece.id) || "chassis";
      for (const q of piece.points) { hull.push({ q, key }); radius = Math.max(radius, len(q)); }
    }
    bots.set(botId, { robotSim, assembled: robotSim.assembled, weapon, team, hull, radius, zone: strikeZone(robotSim) });
    for (const [handle, key] of robotSim.colliderToFitting) {
      index.set(handle, { kind: "bot", id: botId, key, slot: robotSim.slotForCollider?.(handle) || null });
    }
  }

  // ---- strike zones. A hammer, flipper, lifter or crusher acts on whatever
  // is in front of it when it fires - its parked collider is somewhere else
  // entirely (a hammer head waits up over the nose, above most robots). So
  // while one is swinging or closed, each step looks for the opponent's
  // hull in the volume the weapon sweeps, in the attacker's own frame.
  function strikeZone(robotSim) {
    const w = robotSim.shape?.weapon, v = w?.visual;
    if (!w || !v) return null;
    const m = W.zoneMarginM ?? 0.06;
    if (w.class === "hammer" && v.kind === "arm") {
      const hx = v.pivot.x + v.reach;
      return { kind: "hammer", x0: v.pivot.x + v.reach * 0.3, x1: hx + Math.max(0.04, v.head.l / 2) + m,
        z: Math.max(0.06, v.head.w / 2) + m, y1: v.pivot.y + 0.05 };
    }
    if (v.kind === "plate" || v.kind === "jaw") {
      return { kind: w.class, x0: v.center.x - v.size.l * 0.5 - 0.03, x1: v.center.x + v.size.l * 0.5 + m * 2,
        z: v.size.w / 2 + m, y1: v.center.y + v.size.h / 2 + 0.12 };
    }
    return null;
  }

  const conj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
  const toWorld = (rs, q) => add(rs.body.translation(), applyQuat(q, rs.body.rotation()));
  const toLocal = (rs, p) => applyQuat(sub(p, rs.body.translation()), conj(rs.body.rotation()));

  /** The point of Y the weapon of X finds in its zone, or null. */
  function inZone(X, Y) {
    const z = X.zone;
    const px = X.robotSim.body.translation(), py = Y.robotSim.body.translation();
    if (Math.hypot(px.x - py.x, px.z - py.z) > Math.max(Math.abs(z.x0), Math.abs(z.x1)) + z.z + Y.radius) return null;
    let best = null;
    for (const h of Y.hull) {
      const at = toWorld(Y.robotSim, h.q);
      const l = toLocal(X.robotSim, at);
      if (l.x < z.x0 || l.x > z.x1 || Math.abs(l.z) > z.z || l.y > z.y1 || l.y < -0.6) continue;
      // A hammer finds the highest point under it; the rest the nearest.
      const score = z.kind === "hammer" ? l.y : -l.x;
      if (!best || score > best.score) best = { score, key: h.key, at, local: l };
    }
    return best;
  }

  /** Output left in a damaged weapon, 0..1. */
  const outputOf = (X) => {
    const rated = X.assembled.stats.weapon.energyJ || 0;
    const ew = X.robotSim.effective().weapon;
    if (ew.dead) return 0;
    return rated > 0 ? Math.min(1, ew.energyJ / rated) : 1;
  };

  /** Land one strike from a zone: damage, then the class's own effect. */
  function zoneStrike(xid, X, yid, Y, hit, squareness) {
    const stored = X.weapon.strike(X.robotSim.effective());
    if (!(stored > 0)) return false;
    const r = resolveHit({
      attacker: X.assembled, defender: Y.assembled, targetKey: hit.key,
      storedEnergyJ: stored, squareness, rules, rng,
    });
    Y.robotSim.invalidate();
    X.robotSim.invalidate();
    const fwd = applyQuat({ x: 1, y: 0, z: 0 }, X.robotSim.body.rotation());
    const spec = X.assembled.parts.weapon.spec;
    if (X.zone.kind === "flipper") {
      // The launch: the rated impulse through the point the plate caught,
      // so an off-centre catch turns the robot over as it goes up.
      const j = (spec.impulseNs || 0) * (W.flipperLaunch ?? 1) * outputOf(X) * (0.6 + 0.4 * squareness);
      const dir = normalize({ x: fwd.x * (W.flipperForward ?? 0.35), y: 1, z: fwd.z * (W.flipperForward ?? 0.35) });
      Y.robotSim.body.applyImpulseAtPoint(scale(dir, j), hit.at, true);
    } else if (X.zone.kind !== "lifter") {
      applyImpulse(Y.robotSim, X.robotSim.pose().pos, r.impulseNs);
    }
    emit(r, { kind: "weapon", attackerId: xid, defenderId: yid, targetKey: hit.key, at: hit.at, normal: { x: 0, y: 1, z: 0 } });
    return true;
  }

  function zones(dt) {
    for (const [xid, X] of bots) {
      if (!X.zone || !X.weapon) continue;
      const phase = X.weapon.phase;
      if (phase !== "striking" && phase !== "closed") continue;
      for (const [yid, Y] of bots) {
        if (Y.team === X.team) continue;
        const hit = inZone(X, Y);
        if (!hit) continue;
        const kind = X.zone.kind;
        const spec = X.assembled.parts.weapon.spec;
        if (kind === "lifter" && phase === "striking") {
          // A lifter does not throw: it raises the near edge over the
          // stroke, tipping the robot or taking its wheels off the floor.
          const f = (spec.liftForceN || 0) * (W.lifterLift ?? 1) * outputOf(X);
          const fwd = applyQuat({ x: 1, y: 0, z: 0 }, X.robotSim.body.rotation());
          const dir = normalize({ x: fwd.x * 0.25, y: 1, z: fwd.z * 0.25 });
          Y.robotSim.body.applyImpulseAtPoint(scale(dir, f * dt), hit.at, true);
        }
        if (kind === "crusher" && phase === "closed") grip(X, Y, hit, dt);
        // Discrete weapons land once per swing; a closed jaw bites at its rate.
        if ((phase === "striking" && X.weapon.state.unspent) || phase === "closed") {
          const sq = kind === "hammer" ? (W.hammerSquareness ?? 0.85) * (0.9 + rng.next() * 0.2) : 0.7;
          zoneStrike(xid, X, yid, Y, hit, Math.min(1, sq));
        }
      }
    }
  }

  /**
   * A closed jaw holds what it bit: the victim is carried with the crusher
   * (its velocity pulled toward the jaw's) and its near end lifted, so its
   * wheels lose the floor and it cannot drive out.
   */
  function grip(X, Y, hit, dt) {
    const bx = X.robotSim.body, by = Y.robotSim.body;
    const vX = bx.linvel(), wX = bx.angvel();
    const vJaw = add(vX, cross(wX, sub(hit.at, bx.translation())));
    const vY = by.linvel();
    const k = W.crusherHold ?? 0.25;
    const mY = Y.assembled.massKg;
    by.applyImpulseAtPoint({ x: (vJaw.x - vY.x) * mY * k, y: 0, z: (vJaw.z - vY.z) * mY * k }, hit.at, true);
    by.applyImpulseAtPoint({ x: 0, y: mY * 9.81 * (W.crusherLift ?? 0.35) * dt, z: 0 }, hit.at, true);
  }

  function registerHazards(hazardSet) {
    for (const h of hazardSet.all) {
      hazards.set(h.id, h);
      for (const c of h.colliders || []) {
        index.set(c.handle, { kind: "hazard", id: h.id, key: h.type });
      }
    }
  }

  /**
   * How square a hit was, 0..1.
   *
   * Uses the contact normal against the closing velocity: a head-on collision
   * scores 1, a graze along the surface scores near 0. This is the single
   * biggest source of variance between two otherwise identical hits.
   */
  function squarenessOf(bodyA, bodyB, normal) {
    const vA = bodyA ? bodyA.linvel() : { x: 0, y: 0, z: 0 };
    const vB = bodyB ? bodyB.linvel() : { x: 0, y: 0, z: 0 };
    const rel = sub(vA, vB);
    const speed = len(rel);
    if (speed < 0.05) return 0.25;      // barely moving: a lean, not a hit
    return Math.min(1, Math.abs(dot(normalize(rel), normalize(normal))));
  }

  function closingSpeed(bodyA, bodyB) {
    const vA = bodyA ? bodyA.linvel() : { x: 0, y: 0, z: 0 };
    const vB = bodyB ? bodyB.linvel() : { x: 0, y: 0, z: 0 };
    return len(sub(vA, vB));
  }

  /**
   * Contact normal AND world-space contact point for a collider pair.
   *
   * The point is what the render layer needs: sparks and debris have to come
   * off the place that was actually struck, not off the middle of the robot.
   */
  function contactInfo(h1, h2) {
    const c1 = world.getCollider(h1);
    const c2 = world.getCollider(h2);
    if (!c1 || !c2) return null;
    let out = null;
    world.contactPair(c1, c2, (manifold) => {
      if (out) return;
      const normal = manifold.normal();
      let at = null;
      if (manifold.numSolverContacts() > 0) {
        at = manifold.solverContactPoint(0);
      }
      out = { normal, at };
    });
    if (!out) return null;
    // Fall back to the midpoint of the two colliders if the manifold had no
    // solver contact this step.
    if (!out.at) {
      const a = c1.translation(), b = c2.translation();
      out.at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    }
    return out;
  }

  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  function onCooldown(a, b) {
    const k = pairKey(a, b);
    return (cooldowns.get(k) || 0) > clockS;
  }
  function setCooldown(a, b) {
    cooldowns.set(pairKey(a, b), clockS + PAIR_COOLDOWN_S);
  }

  /**
   * A rotor's hit throws what it hits - through the point it struck, so the
   * robot tumbles - and kicks the spinner back the other way. A vertical
   * throws up; a horizontal sideways, and it takes the bigger kick itself.
   * Off a wedge, the spinner is the one thrown, up and back.
   */
  function throwFrom(atk, def, cls, deliveredJ, at, wedge) {
    const j = (deliveredJ / 1000) * (W.kineticImpulsePerKJ ?? 0);
    if (!(j > 0)) return;
    const pa = atk.robotSim.body.translation(), pd = def.robotSim.body.translation();
    const away = normalize({ x: pd.x - pa.x, y: 0, z: pd.z - pa.z });
    const lift = W.kineticLift?.[cls] ?? 0.3;
    def.robotSim.body.applyImpulseAtPoint(scale(normalize({ x: away.x, y: lift, z: away.z }), j), at || pd, true);
    const back = scale({ x: -away.x, y: 0, z: -away.z }, j * (W.recoil?.[cls] ?? 0.4));
    if (wedge) back.y = j * (W.wedgeDeflect?.liftAttacker ?? 0.5) * (cls === "spinner_h" ? 1 : 0.4);
    atk.robotSim.body.applyImpulse(back, true);
  }

  /** Push the defender away from the attacker after a hit lands. */
  function applyImpulse(defenderSim, attackerPos, impulseNs) {
    if (!(impulseNs > 0)) return;
    const p = defenderSim.pose().pos;
    const away = normalize(sub(p, attackerPos));
    // A little upward component, because big hits pitch bots into the air.
    const dir = normalize({ x: away.x, y: away.y + 0.45, z: away.z });
    defenderSim.body.applyImpulse(scale(dir, impulseNs), true);
  }

  function emit(result, meta) {
    stats.resolved++;
    const entry = { t: clockS, ...meta, ...summarise(result) };
    log.push(entry);
    bus?.emit(EV.HIT, entry);
    for (const f of result.failures || []) {
      bus?.emit(EV.PART_FAILED, {
        t: clockS, botId: meta.defenderId, at: meta.at, normal: meta.normal, ...f,
      });
    }
    return entry;
  }

  function summarise(r) {
    return {
      deliveredJ: r.deliveredJ,
      severity: r.severity,
      hits: (r.hits || []).map((h) => ({
        key: h.key, category: h.category, hpLost: h.hpLost,
        conditionAfter: h.conditionAfter, failed: h.failed, throughArmor: !!h.throughArmor,
      })),
      failures: (r.failures || []).map((f) => ({ key: f.key, name: f.name, category: f.category })),
    };
  }

  /**
   * Weapon on weapon: who wins the exchange?
   *
   * More stored energy wins. Near a tie - two identical spinners both at full
   * speed are EXACTLY equal - the one driving into the hit wins, then a seeded
   * coin. This used to be `A.energy >= B.energy`, so every tie went to
   * whichever bot was registered first: AI bouts between identical spinners
   * had the red corner winning ~75% regardless of driver skill.
   */
  function aWinsClash(A, B) {
    const eA = A.weapon.energyJ, eB = B.weapon.energyJ;
    if (Math.abs(eA - eB) > 0.03 * Math.max(eA, eB)) return eA > eB;
    const pa = A.robotSim.body.translation(), pb = B.robotSim.body.translation();
    const ab = normalize({ x: pb.x - pa.x, y: 0, z: pb.z - pa.z });
    const va = A.robotSim.body.linvel(), vb = B.robotSim.body.linvel();
    const intoA = dot(va, ab), intoB = -dot(vb, ab);
    if (Math.abs(intoA - intoB) > 0.3) return intoA > intoB;
    return rng.next() < 0.5;
  }

  /** Resolve one bot-on-bot contact. */
  function botVsBot(aInfo, bInfo, normal, at) {
    const A = bots.get(aInfo.id), B = bots.get(bInfo.id);
    if (!A || !B || A === B) return;
    if (A.team === B.team) return;            // teammates: physics only
    if (onCooldown(aInfo.id, bInfo.id)) return;

    const sq = squarenessOf(A.robotSim.body, B.robotSim.body, normal);

    // Whoever landed their WEAPON on the other is the attacker. If both did,
    // the one with more stored energy wins the exchange.
    const aArmed = aInfo.key === "weapon" && !!A.weapon?.armed;
    const bArmed = bInfo.key === "weapon" && !!B.weapon?.armed;

    let atk = null, def = null, targetKey = null;
    if (aArmed && (!bArmed || aWinsClash(A, B))) {
      atk = A; def = B; targetKey = bInfo.key;
    } else if (bArmed) {
      atk = B; def = A; targetKey = aInfo.key;
    }

    if (atk) {
      const eff = atk.robotSim.effective();
      const stored = atk.weapon.strike(eff);
      if (stored > 0) {
        const kinetic = atk.weapon.family === FAMILY.KINETIC;
        const cls = atk.assembled.stats.weapon.class;
        // A horizontal rotor striking a wedge glances up off it: wedges are
        // what horizontal spinners fear.
        const defSlot = (def === A ? aInfo : bInfo).slot;
        // How hard it glances depends on the rotor: a vertical's tooth bites
        // a wedge's lip, a horizontal bar rides straight up it.
        const wd = W.wedgeDeflect || {};
        const wedge = kinetic && wd.transfer?.[cls] != null && (defSlot === "wedge" ||
          (defSlot === "weapon" && def.assembled.stats.weapon.class === "static"));
        const r = resolveHit({
          attacker: atk.assembled, defender: def.assembled,
          targetKey, storedEnergyJ: wedge ? stored * wd.transfer[cls] : stored, squareness: sq, rules, rng,
        });
        // A landed hit costs a rotor most of its spin, not just what went in:
        // the respool is the price of a spinner (weapons.rotorSpend).
        if (kinetic) atk.weapon.absorbRecoil(Math.max(r.deliveredJ, stored * (W.rotorSpend?.[cls] ?? 0)));
        else atk.weapon.absorbRecoil(r.deliveredJ);
        def.robotSim.invalidate();
        atk.robotSim.invalidate();
        if (kinetic) throwFrom(atk, def, cls, r.deliveredJ, at, wedge);
        else applyImpulse(def.robotSim, atk.robotSim.pose().pos, r.impulseNs);
        setCooldown(aInfo.id, bInfo.id);
        emit(r, {
          kind: "weapon",
          attackerId: atk === A ? aInfo.id : bInfo.id,
          defenderId: def === A ? aInfo.id : bInfo.id,
          targetKey, at, normal,
        });
        return;
      }
    }

    // No live weapon involved: it is a shove. Worth far less damage, but it is
    // what aggression and control points are made of.
    const speed = closingSpeed(A.robotSim.body, B.robotSim.body);
    const aFaster = len(A.robotSim.body.linvel()) >= len(B.robotSim.body.linvel());
    const ram = aFaster
      ? { atk: A, def: B, key: bInfo.key, atkId: aInfo.id, defId: bInfo.id }
      : { atk: B, def: A, key: aInfo.key, atkId: bInfo.id, defId: aInfo.id };

    const r = resolveRam({
      attacker: ram.atk.assembled, defender: ram.def.assembled,
      targetKey: ram.key, relativeSpeedMps: speed, rules, rng,
    });
    if (r.ignored) return;
    ram.def.robotSim.invalidate();
    setCooldown(aInfo.id, bInfo.id);
    emit(r, { kind: "ram", attackerId: ram.atkId, defenderId: ram.defId, targetKey: ram.key, at, normal });
  }

  /** Resolve a hazard striking a bot. */
  function hazardVsBot(hInfo, bInfo, normal, at) {
    const haz = hazards.get(hInfo.id);
    const B = bots.get(bInfo.id);
    if (!haz || !B) return;
    if (onCooldown(hInfo.id, bInfo.id)) { stats.cooldown++; return; }

    // Each hazard decides for itself whether it is dangerous right now - see
    // the `live` getters in hazards.js. Gating on state names here was how
    // pulverizer hits got missed entirely, and how killsaws were never
    // dangerous at all.
    if (!haz.live) { stats.notLive++; return; }

    const energyJ = haz.def.impactEnergyJ || 0;
    if (energyJ <= 0) { stats.noEnergy++; return; }

    const sq = squarenessOf(haz.body, B.robotSim.body, normal);

    // Hazards are modelled as an attacker with no robot of their own, so a
    // minimal stand-in carries just the fields resolveHit reads.
    const pseudoAttacker = {
      massKg: 500,
      parts: { weapon: null },
      condition: {},
      fittings: [],
      stats: { weapon: { concentration: haz.def.concentration || 2.0, selfDamageFraction: 0 } },
    };

    const r = resolveHit({
      attacker: pseudoAttacker, defender: B.assembled,
      targetKey: bInfo.key, storedEnergyJ: energyJ,
      squareness: Math.max(0.5, sq), rules, rng,
    });
    B.robotSim.invalidate();
    applyImpulse(B.robotSim, haz.body.translation(), r.impulseNs * 2);
    setCooldown(hInfo.id, bInfo.id);
    emit(r, { kind: "hazard", hazardId: haz.id, hazardType: haz.type,
              defenderId: bInfo.id, targetKey: bInfo.key, at, normal });
  }

  return {
    eventQueue,
    registerBot,
    registerHazards,
    get log() { return log; },
    get stats() { return stats; },
    /** How many colliders are indexed, and under what ids. */
    debugIndex: () => {
      const out = {};
      for (const v of index.values()) {
        const k = `${v.kind}:${v.id}`;
        out[k] = (out[k] || 0) + 1;
      }
      return out;
    },

    /** Call immediately AFTER world.step(combat.eventQueue). */
    resolve(dt) {
      clockS += dt;

      zones(dt);

      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        stats.rawStarted++;
        const a = index.get(h1), b = index.get(h2);
        if (!a || !b) { stats.unindexed++; return; } // arena geometry: ignore

        const info = contactInfo(h1, h2) || { normal: { x: 0, y: 1, z: 0 }, at: null };
        const normal = info.normal;
        const at = info.at;

        if (a.kind === "bot" && b.kind === "bot") { stats.botVsBot++; botVsBot(a, b, normal, at); }
        else if (a.kind === "hazard" && b.kind === "bot") { stats.hazardVsBot++; hazardVsBot(a, b, normal, at); }
        else if (b.kind === "hazard" && a.kind === "bot") { stats.hazardVsBot++; hazardVsBot(b, a, normal, at); }
      });

      // Expire old cooldowns so the map does not grow without bound.
      if (cooldowns.size > 64) {
        for (const [k, t] of cooldowns) if (t < clockS) cooldowns.delete(k);
      }
    },

    reset() {
      clockS = 0;
      log.length = 0;
      cooldowns.clear();
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
  };
}
