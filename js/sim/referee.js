// referee.js - watches the physics and tells the match what happened.
//
// The match (js/logic/match.js) and the judges (js/logic/judging.js) are pure
// logic and never see Rapier. Each step this works out, for each robot:
//
//   - can it drive?        upright, wheels on the floor, drive alive
//   - is it trying / moving under its own power?
//   - is it advancing on the opponent, or pushing it around?
//   - is one robot pinning the other?
//
// and routes every hit to the scorebook - crediting hazard damage to whoever
// drove the victim into the hazard.
//
// main.js and js/sim/bout.js both use this, so the browser and the headless
// season simulation cannot disagree about the rules.

import { EV } from "../core/bus.js";
import { yawOfQuat } from "../core/vec.js";

// Fallback only. Robots touch when Rapier says their colliders touch; this
// body-box gap misses wedge noses and armour, which stick out past the chassis
// dims - it read 0.35 m apart for two robots shoving each other across the box.
const CONTACT_GAP_M = 0.05;

/**
 * @param sides  exactly two: { id, robotSim, weapon } for a single robot, or
 *               { id, units: [{ id, robotSim, weapon }] } for a multibot. Hits
 *               arrive with UNIT ids and are scored to the side.
 * @param world  the Rapier world, to ask who is actually touching whom. Optional:
 *               without it, contact falls back to the body-box gap.
 */
export function makeReferee({ match, bus, sides: sidesIn, world = null, arena = null }) {
  const sides = sidesIn.map((s) => ({ id: s.id, units: s.units || [{ id: s.id, robotSim: s.robotSim, weapon: s.weapon }] }));
  const [A, B] = sides;
  const byId = new Map(sides.map((s) => [s.id, s]));
  const sideOfUnit = new Map(sides.flatMap((s) => s.units.map((u) => [u.id, s])));
  const other = (id) => (id === A.id ? B : A);
  let t = 0;
  let lastContactT = -Infinity;
  let lastFacts = null;
  // Two robots locked together - weapons hooked, one wedged on the other -
  // both trying to get away and neither moving. On the show the referee
  // stops the fight and pulls them apart; so does this one.
  const LOCK_S = match.config?.separateAfterS ?? 6;
  let lockedS = 0;

  const offHit = bus.on(EV.HIT, (e) => {
    if (match.phase !== "live") return;      // test drives before the bell do not score
    const hp = (e.hits || []).reduce((s, h) => s + (h.hpLost || 0), 0);
    const failures = (e.failures || []).length;
    const attacker = sideOfUnit.get(e.attackerId)?.id ?? e.attackerId;
    const defender = sideOfUnit.get(e.defenderId)?.id ?? e.defenderId;
    let creditTo = null;
    // Driven into a hazard: the damage is the pusher's, if they were just in
    // contact.
    if (e.kind === "hazard" && t - lastContactT <= match.scorebook.cfg.hazardCreditS) {
      creditTo = other(defender)?.id ?? null;
    }
    match.scorebook.recordHit({ kind: e.kind, attackerId: attacker, defenderId: defender, hp, failures, creditTo });
  });

  /** How far a robot's body reaches along a world direction, from its centre. */
  function extentAlong(unit, dir) {
    const d = unit.robotSim.assembled.dims;
    const yaw = yawOfQuat(unit.robotSim.body.rotation());
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);       // forward is local +X
    const c = Math.abs(fx * dir.x + fz * dir.z);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    return c * d.lengthM / 2 + s * d.widthM / 2;
  }

  /** Do any of unit a's colliders have live contact points with unit b's body? */
  function touching(a, b) {
    if (!world) return false;
    const bBody = b.robotSim.body.handle;
    let hit = false;
    for (const h of a.robotSim.colliderToFitting.keys()) {
      const c = world.getCollider(h);
      if (!c) continue;
      world.contactPairsWith(c, (o) => {
        if (hit || o.parent()?.handle !== bBody) return;
        world.contactPair(c, o, (manifold) => { if (manifold.numContacts() > 0) hit = true; });
      });
      if (hit) break;
    }
    return hit;
  }

  function mobility(unit, drive) {
    const sim = unit.robotSim;
    const v = sim.body.linvel();
    const w = sim.body.angvel();
    const eff = sim.effective();
    const wheelsDown = sim.telemetry.filter((x) => x.grounded).length;
    const upright = sim.uprightness();
    // An invertible robot running on its back is driving, not flipped.
    const onItsWheels = upright > 0.45 || !!sim.inverted;
    // Below the deck can only mean down a pit (the floor is y = 0 everywhere
    // else): out on the spot, as on Robot Wars.
    const pitted = sim.body.translation().y < -0.25;
    return {
      able: !pitted && !eff.immobile && eff.wheelCount > 0 && onItsWheels && wheelsDown >= 2,
      out: pitted,
      // Why not, for the referee's call and the results screen.
      cause: pitted ? "pitted"
           : eff.immobile || eff.wheelCount <= 0 ? "disabled"
           : !onItsWheels ? "flipped"
           : wheelsDown < 2 ? "beached" : "stuck",
      trying: Math.abs(drive?.throttle ?? 0) > 0.25 || Math.abs(drive?.steer ?? 0) > 0.35,
      moving: Math.hypot(v.x, v.z) > 0.2 || Math.abs(w.y) > 0.6,
      vel: { x: v.x, z: v.z },
      speed: Math.hypot(v.x, v.z),
      throttle: drive?.throttle ?? 0,
      yaw: yawOfQuat(sim.body.rotation()),
    };
  }

  /**
   * A side's mobility. One robot: its own. A multibot is out when more than
   * half its weight cannot drive (the show's rule); it is trying and moving if
   * any working unit is. The `lead` unit - the one doing the fighting - is
   * the working unit nearest the other side.
   */
  function sideMobility(side, per, lead) {
    if (side.units.length === 1) return per.get(side.units[0]);
    const total = side.units.reduce((s, u) => s + u.robotSim.assembled.weightLb, 0);
    const down = side.units.filter((u) => !per.get(u).able);
    const downW = down.reduce((s, u) => s + u.robotSim.assembled.weightLb, 0);
    const working = side.units.filter((u) => per.get(u).able);
    const heaviestDown = down.slice().sort((x, y) => y.robotSim.assembled.weightLb - x.robotSim.assembled.weightLb)[0];
    const pittedW = down.filter((u) => per.get(u).out).reduce((s, u) => s + u.robotSim.assembled.weightLb, 0);
    return {
      ...per.get(lead),
      able: downW / total <= 0.5,
      // A multibot is out on the spot only if more than half of it is down the pit.
      out: pittedW / total > 0.5,
      cause: heaviestDown ? per.get(heaviestDown).cause : "stuck",
      trying: working.some((u) => per.get(u).trying),
      moving: working.some((u) => per.get(u).moving),
    };
  }

  /** The closest pair of opposing units, preferring ones that still work. */
  function closestPair(per) {
    const pool = (s) => { const w = s.units.filter((u) => per.get(u).able); return w.length ? w : s.units; };
    let best = null;
    for (const a of pool(A)) {
      for (const b of pool(B)) {
        const pa = a.robotSim.body.translation(), pb = b.robotSim.body.translation();
        const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        if (!best || d < best.d) best = { a, b, d, pa, pb };
      }
    }
    return best;
  }

  /** Pull two locked robots apart along the line between them, and stop them. */
  function separate(ua, ub, ab) {
    const push = 0.35;
    for (const [u, k] of [[ua, -1], [ub, 1]]) {
      const b = u.robotSim.body, p = b.translation();
      b.setTranslation({ x: p.x + ab.x * push * k, y: p.y + 0.05, z: p.z + ab.z * push * k }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  return {
    /** The last step's facts, for the HUD and tests. */
    get facts() { return lastFacts; },

    /**
     * Call once per physics step, after world.step and combat.resolve.
     * @param drives  { [botId]: DriveInput } - what each driver asked for
     */
    step(dt, drives) {
      t += dt;
      const per = new Map([...A.units, ...B.units].map((u) => [u, mobility(u, drives[u.id])]));
      const { a: ua, b: ub, pa, pb } = closestPair(per);
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const dist = Math.hypot(dx, dz) || 1e-6;
      const ab = { x: dx / dist, z: dz / dist };
      const gap = dist - extentAlong(ua, ab) - extentAlong(ub, ab);
      const contact = gap < CONTACT_GAP_M || touching(ua, ub);
      if (contact) lastContactT = t;

      const mA = sideMobility(A, per, ua);
      const mB = sideMobility(B, per, ub);

      // Closing speed of each robot toward the other, and how fast each is
      // being carried along the line between them.
      const towardA = mA.vel.x * ab.x + mA.vel.z * ab.z;        // A toward B
      const towardB = -(mB.vel.x * ab.x + mB.vel.z * ab.z);     // B toward A
      const facing = (m, dir) => Math.cos(m.yaw) * dir.x - Math.sin(m.yaw) * dir.z;
      const drivingAt = (m, dir) => m.throttle * facing(m, dir) > 0.3;

      const facts = {};
      facts[A.id] = {
        advancing: mA.trying && gap < 4 && towardA > 0.35,
        pushing: contact && drivingAt(mA, ab) && towardA > 0.15 && -towardB > 0.05,
        disabled: !mA.able,
      };
      const ba = { x: -ab.x, z: -ab.z };
      facts[B.id] = {
        advancing: mB.trying && gap < 4 && towardB > 0.35,
        pushing: contact && drivingAt(mB, ba) && towardB > 0.15 && -towardA > 0.05,
        disabled: !mB.able,
      };

      // Pinning: holding the other robot in place while it tries to get away -
      // shoved against a wall, or held while it tries to drive somewhere else.
      // Two robots shoving nose to nose in the open is a fight, not a pin.
      const againstWall = (unit, pos, dir) => {
        if (!arena) return false;
        const reach = extentAlong(unit, dir) + 0.45;
        return (dir.x > 0.5 && arena.halfX - pos.x < reach) || (dir.x < -0.5 && pos.x + arena.halfX < reach) ||
               (dir.z > 0.5 && arena.halfZ - pos.z < reach) || (dir.z < -0.5 && pos.z + arena.halfZ < reach);
      };
      const pinning = (me, them, dir, themUnit, themPos) => contact && me.able && drivingAt(me, dir) &&
        them.speed < 0.3 && them.trying &&
        (againstWall(themUnit, themPos, dir) || !drivingAt(them, { x: -dir.x, z: -dir.z }));
      let pinner = null, pinned = null;
      if (pinning(mA, mB, ab, ub, pb)) { pinner = A.id; pinned = B.id; }
      else if (pinning(mB, mA, ba, ua, pa)) { pinner = B.id; pinned = A.id; }
      match.reportPin(pinner, pinned, dt);

      // A pin is one robot holding the other against a WALL (the pin rule
      // covers it). Two robots both driving and getting nowhere in open floor
      // are locked - the pin read flickers between them, so ignore it there.
      // Against a wall it IS a pin - until the pinner has had its warning and
      // its release window and still cannot (or will not) let go.
      const byWall = (p) => arena && (Math.abs(p.x) > arena.halfX - 0.9 || Math.abs(p.z) > arena.halfZ - 0.9);
      const wallPin = !!pinner && (byWall(pa) || byWall(pb));
      const stuckTogether = contact && match.phase === "live" &&
        mA.trying && mB.trying && mA.speed < 0.08 && mB.speed < 0.08 && mA.able && mB.able;
      lockedS = stuckTogether ? lockedS + dt : 0;
      const cfgM = match.config || {};
      const limit = wallPin ? (cfgM.pinLimitS ?? 10) + (cfgM.pinReleaseS ?? 3) + LOCK_S : LOCK_S;
      if (lockedS >= limit) {
        lockedS = 0;
        separate(ua, ub, ab);
        bus.emit(EV.SEPARATE, { a: A.id, b: B.id });
      }

      match.reportMobility(A.id, { ...mA, pinned: pinned === A.id, engaged: contact }, dt);
      match.reportMobility(B.id, { ...mB, pinned: pinned === B.id, engaged: contact }, dt);
      if (match.phase === "live") {
        match.scorebook.recordStep(A.id, facts[A.id], dt);
        match.scorebook.recordStep(B.id, facts[B.id], dt);
      }
      lastFacts = { gap, contact, pinner, pinned, mobility: { [A.id]: mA, [B.id]: mB }, ...facts };
    },

    reset() { t = 0; lastContactT = -Infinity; lastFacts = null; lockedS = 0; },
    dispose() { offHit(); },
    side: (id) => byId.get(id),
  };
}
