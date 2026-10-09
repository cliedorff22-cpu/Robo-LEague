// ai_bridge.js - physics state -> the plain perception js/logic/ai.js reads.
//
// The AI lives in js/logic and so may not touch Rapier or the hazard objects.
// This is the one place that looks at them on its behalf and flattens them
// into numbers. A port to another engine rewrites this file and nothing in
// the AI.

import { applyQuat } from "../core/vec.js";
import { ftToM } from "../core/units.js";

/** Front-mounted weapons: the end of the bot you do not want to meet. */
const FRONT_WEAPONS = new Set(["spinner_v", "drum", "hammer", "flipper", "lifter", "crusher", "static"]);

/**
 * One bot as the AI sees it.
 * @param robotSim  js/sim/robot_sim.js
 * @param weapon    js/logic/weapon.js
 */
export function perceiveBot(robotSim, weapon) {
  const a = robotSim.assembled;
  const t = robotSim.body.translation();
  const v = robotSim.body.linvel();
  const eff = robotSim.effective();
  const ws = a.stats.weapon;
  return {
    id: a.id,
    pos: { x: t.x, z: t.z },
    vel: { x: v.x, z: v.z },
    // Heading of the robot's nose, read off its forward axis so it stays right
    // when an invertible bot is running on its back.
    yaw: headingOf(robotSim.body.rotation()),
    speed: Math.hypot(v.x, v.z),
    yawRate: robotSim.body.angvel().y,
    wheelsDown: robotSim.telemetry.filter((w) => w.grounded).length,
    upright: robotSim.uprightness(),
    inverted: !!robotSim.inverted,
    canSelfRight: !!robotSim.canSelfRight?.(),
    archetype: a.archetype,
    family: weapon?.family ?? "none",
    weaponReady: !!weapon?.ready,
    weaponPhase: weapon?.phase ?? "idle",
    weaponDead: !!eff.weapon?.dead,
    spinPct: weapon?.spinPct ?? 0,
    energyJ: weapon?.energyJ ?? 0,
    // Horizontal spinners hit across their whole front arc and much of their
    // sides; everything else only matters from straight ahead.
    frontWeapon: FRONT_WEAPONS.has(ws.class) || ws.class === "spinner_h",
    reachM: ws.reachM ?? 0.15,
    halfLenM: a.dims.lengthM / 2,
    health: healthOf(a),
    topSpeed: eff.topSpeedMps ?? a.stats.topSpeedMps,
  };
}

function headingOf(q) {
  const f = applyQuat({ x: 1, y: 0, z: 0 }, q);
  return Math.atan2(-f.z, f.x);
}

/**
 * Hazards as danger zones: { kind, center, radius, danger 0..1, segment? }.
 * `remainingS` lets the AI see killsaws that are ABOUT to come up.
 */
export function perceiveHazards(hazards, remainingS) {
  const out = [];
  const upNext = hazards.killsawActiveAt?.(remainingS - 0.6) ?? new Set();
  for (const h of hazards.all) {
    if (h.type === "pulverizer" || h.type === "hammer") {
      const danger = h.state === "armed" ? 1 : h.state === "swinging" ? 1 : h.state === "retracting" ? 0.5 : 0.15;
      out.push({
        kind: "pulverizer",
        center: { x: ftToM(h.def.pos[0]), z: ftToM(h.def.pos[2]) },
        radius: ftToM(h.def.headSize[0]) * 0.6,
        danger,
      });
    } else if (h.type === "killsaw") {
      const p = h.pieces[0];
      const danger = Math.max(h.travel ?? 0, upNext.has(h.id) ? 0.9 : 0);
      if (danger < 0.05) continue;
      out.push({ kind: "killsaw", center: { x: p.pos.x, z: p.pos.z }, radius: p.slotLength / 2, danger });
    } else if (h.type === "pit") {
      // Nothing to fear until the lights start flashing; once it is going
      // down, the most dangerous thing in the box - and the best place to
      // shove the other robot.
      const danger = h.travel > 0 ? 1 : h.warning > 0 ? 0.4 + 0.5 * h.warning : 0;
      if (danger < 0.05) continue;
      const r = h.rect;
      out.push({ kind: "pit", center: { x: r.cx, z: r.cz }, radius: Math.max(r.hw, r.hl) * 1.05, danger });
    } else if (h.type === "screw") {
      const p = h.pieces[0];
      const half = p.length / 2;
      const dx = Math.sin(p.yaw) * half, dz = Math.cos(p.yaw) * half;
      out.push({
        kind: "screw",
        center: { x: p.pos.x, z: p.pos.z },
        segment: [{ x: p.pos.x - dx, z: p.pos.z - dz }, { x: p.pos.x + dx, z: p.pos.z + dz }],
        radius: p.spacing / 2 + p.radius,
        danger: 0.6,
      });
    }
  }
  return out;
}

/**
 * How much robot is left, 0..1: the hp-weighted average of every part, pulled
 * down hard by the worst of the parts that keep it in the fight. A bot with
 * perfect armour and a dying battery is not healthy.
 */
const VITAL = new Set(["chassis", "electronics", "motor", "battery", "drive", "wheel"]);
export function healthOf(assembled) {
  let have = 0, full = 0, worstVital = 1;
  for (const f of assembled.fittings) {
    const c = assembled.condition[f.key] ?? 1;
    have += f.part.hp * c;
    full += f.part.hp;
    if (VITAL.has(f.part.category)) worstVital = Math.min(worstVital, c);
  }
  const avg = full > 0 ? have / full : 1;
  return 0.6 * avg + 0.4 * worstVital;
}

/**
 * Everything one AI needs for one decision.
 * @param lead  -1..1, who the judges would favour right now (scorebook.lead)
 */
export function perceive({ selfSim, selfWeapon, oppSim, oppWeapon, hazards, arenaDims, remainingS, lead = 0 }) {
  return {
    self: perceiveBot(selfSim, selfWeapon),
    opponent: perceiveBot(oppSim, oppWeapon),
    hazards: perceiveHazards(hazards, remainingS ?? 999),
    arena: { halfX: arenaDims.halfX, halfZ: arenaDims.halfZ },
    remainingS,
    lead,
  };
}
