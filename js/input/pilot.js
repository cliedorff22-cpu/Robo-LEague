// pilot.js - who is driving: the human or the AI.
//
// The brief wants control handoff at any time, including mid-match. Both
// pilots emit the same DriveInput shape, so handing over is just swapping
// which function gets called. The AI side is js/logic/ai.js, handed in as
// `brain`; it reads a perception of the fight (js/sim/ai_bridge.js).

import { yawOfQuat, clamp } from "../core/vec.js";
import { EV } from "../core/bus.js";

export const PILOT = { HUMAN: "human", AI: "ai" };

export function makePilot(bus, { initial = PILOT.HUMAN, brain = null } = {}) {
  let mode = initial;

  return {
    get mode() { return mode; },
    get brain() { return brain; },

    set(next, botId) {
      if (next === mode) return;
      mode = next;
      // Taking over from a human, the AI starts with a clean head - no stale
      // stuck timers or opponent history from the last time it drove.
      if (mode === PILOT.AI) brain?.reset();
      bus.emit(EV.CONTROL_CHANGED, { botId, pilot: mode });
    },

    toggle(botId) {
      this.set(mode === PILOT.HUMAN ? PILOT.AI : PILOT.HUMAN, botId);
      return mode;
    },

    /**
     * Produce this frame's DriveInput.
     * @param {object} human  DriveInput from input.js
     * @param {object} ctx    { perception, dt } for the AI brain; the old
     *                        { pose, arenaHalf, target } still drives the stub
     */
    read(human, ctx) {
      if (mode === PILOT.HUMAN) return human;
      if (brain && ctx.perception) return brain.drive(ctx.perception, ctx.dt);
      return driveStub(ctx);
    },
  };
}

/**
 * Fallback when there is no brain or no opponent to perceive: patrol the
 * arena, turn away from walls. The Stage 1 placeholder, kept as a safe floor.
 */
function driveStub(ctx) {
  const { pose, arenaHalf } = ctx;
  const target = ctx.target || { x: 0, z: 0 };

  const yaw = yawOfQuat(pose.quat);
  // Bot forward is local +X, so world heading is (cos yaw, -sin yaw) in XZ.
  const headingX = Math.cos(yaw);
  const headingZ = -Math.sin(yaw);

  let dx = target.x - pose.pos.x;
  let dz = target.z - pose.pos.z;

  // Back away from a wall rather than grinding along it.
  const margin = 1.2;
  if (Math.abs(pose.pos.x) > arenaHalf - margin) dx = -Math.sign(pose.pos.x);
  if (Math.abs(pose.pos.z) > arenaHalf - margin) dz = -Math.sign(pose.pos.z);

  const dist = Math.hypot(dx, dz);
  if (dist < 0.4) return { throttle: 0, steer: 0.4, brake: false, weapon: 0 };

  const nx = dx / dist, nz = dz / dist;
  // Signed angle from heading to target, in the XZ plane.
  const cross = headingX * nz - headingZ * nx;
  const dotp = headingX * nx + headingZ * nz;
  const bearing = Math.atan2(cross, dotp);

  const steer = clamp(-bearing * 1.6, -1, 1);
  // Ease off the throttle when sharply off-heading so it turns before charging.
  const throttle = clamp(Math.cos(bearing), -0.2, 1) * 0.85;

  return { throttle, steer, brake: false, weapon: 0 };
}
