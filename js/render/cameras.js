// cameras.js - the camera rig: chase, overhead, fixed arena cams and replay.
//
// Camera definitions live in arena.json, so adding a broadcast angle is a data
// edit. All modes drive one PerspectiveCamera; switching is instant.

import * as THREE from "three";
import { ftToM, degToRad } from "../core/units.js";
import { yawOfQuat } from "../core/vec.js";
import { EV } from "../core/bus.js";

export function makeCameraRig(arena, bus, aspect = 16 / 9) {
  const defs = arena.cameras;
  const camera = new THREE.PerspectiveCamera(defs[0].fov || 60, aspect, 0.15, 220);

  let index = 0;
  // The chase cam carries its own yaw so a spinning bot does not whip the view
  // around. It eases toward the bot's heading instead of locking to it.
  let chaseYaw = 0;
  let chaseInit = false;
  const camPos = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const desired = new THREE.Vector3();
  let replayClock = 0;
  let versusInit = false;

  const current = () => defs[index];

  function announce() {
    const d = current();
    camera.fov = d.fov || 60;
    camera.updateProjectionMatrix();
    bus.emit(EV.CAMERA_CHANGED, { id: d.id, label: d.label });
  }

  /**
   * @param dt     seconds
   * @param focus  { pos, quat } of the bot to follow
   * @param opts   { replay: bool, pair: [pos, pos] - both corners, for the Versus cam }
   */
  function update(dt, focus, opts = {}) {
    const d = current();
    const target = focus.pos;
    lookTarget.set(target.x, target.y + 0.25, target.z);

    if (d.type === "chase" || (d.type === "replay" && !opts.replay)) {
      const botYaw = yawOfQuat(focus.quat);
      if (!chaseInit) { chaseYaw = botYaw; chaseInit = true; }
      // Shortest-arc easing, frame-rate independent.
      let delta = wrapPi(botYaw - chaseYaw);
      const k = 1 - Math.exp(-dt / Math.max(0.01, d.lag ?? 0.12));
      chaseYaw = wrapPi(chaseYaw + delta * k);

      const dist = ftToM(d.distance);
      const h = ftToM(d.height);
      // Bot forward is local +X, so world heading is (cos, -sin) in XZ.
      desired.set(
        target.x - Math.cos(chaseYaw) * dist,
        target.y + h,
        target.z + Math.sin(chaseYaw) * dist
      );
      camPos.lerp(desired, 1 - Math.exp(-dt / 0.1));
      camera.position.copy(camPos);
      camera.lookAt(lookTarget);

    } else if (d.type === "overhead") {
      camera.position.set(0, ftToM(d.height), 0.001);
      camera.lookAt(0, 0, 0);

    } else if (d.type === "fixed") {
      camera.position.set(...ftToMArr(d.pos));
      const la = d.lookAt ? ftToMArr(d.lookAt) : [0, 0.6, 0];
      // Fixed cams gently track the action rather than staring at the centre.
      lookTarget.set(
        la[0] * 0.35 + target.x * 0.65,
        la[1] * 0.4 + (target.y + 0.3) * 0.6,
        la[2] * 0.35 + target.z * 0.65
      );
      camera.lookAt(lookTarget);

    } else if (d.type === "versus" && opts.pair?.length === 2) {
      // Both robots in frame, side-on to the line between them - the
      // two-player camera. It stays on whichever side of that line it is
      // already on, so it never whips across the arena.
      const [a, b] = opts.pair;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const dx = b.x - a.x, dz = b.z - a.z;
      const sep = Math.hypot(dx, dz) || 0.001;
      let px = -dz / sep, pz = dx / sep;
      // It starts with red on the left, as the HUD has it; after that it
      // only crosses over once the robots have clearly swapped round.
      if (!versusInit) { versusInit = true; camPos.set(mx + px * 6, ftToM(d.height), mz + pz * 6); }
      if ((camPos.x - mx) * px + (camPos.z - mz) * pz < -1) { px = -px; pz = -pz; }
      const dist = ftToM(d.distance) + sep * (d.spread ?? 0.9);
      desired.set(mx + px * dist, ftToM(d.height) + sep * (d.rise ?? 0.3), mz + pz * dist);
      // Never into the stands: hold it within reach of the box.
      const lim = ftToM(d.limit ?? 32);
      desired.x = Math.max(-lim, Math.min(lim, desired.x));
      desired.z = Math.max(-lim, Math.min(lim, desired.z));
      camPos.lerp(desired, 1 - Math.exp(-dt / 0.35));
      camera.position.copy(camPos);
      lookTarget.set(mx, 0.3, mz);
      camera.lookAt(lookTarget);

    } else if (d.type === "replay") {
      replayClock += dt;
      const dist = ftToM(d.distance);
      const h = ftToM(d.height);
      const a = replayClock * degToRad((d.orbitRpm || 6) * 6);
      camera.position.set(
        target.x + Math.cos(a) * dist,
        target.y + h,
        target.z + Math.sin(a) * dist
      );
      camera.lookAt(lookTarget);
    }
  }

  // The rig starts the camera somewhere sensible so frame one is not at origin.
  camPos.set(-ftToM(14), ftToM(6), 0);
  camera.position.copy(camPos);

  return {
    camera,
    get id() { return current().id; },
    get label() { return current().label; },
    get isReplayCam() { return current().type === "replay"; },

    next() { index = (index + 1) % defs.length; announce(); return current(); },
    prev() { index = (index - 1 + defs.length) % defs.length; announce(); return current(); },
    select(id) {
      const i = defs.findIndex((d) => d.id === id);
      if (i >= 0 && i !== index) { index = i; announce(); }
      return current();
    },
    selectIndex(i) {
      if (i >= 0 && i < defs.length && i !== index) { index = i; announce(); }
      return current();
    },
    list: () => defs.map((d) => ({ id: d.id, label: d.label })),

    update,
    setAspect(a) { camera.aspect = a; camera.updateProjectionMatrix(); },
    resetChase() { chaseInit = false; },
  };
}

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ftToMArr = (a) => [ftToM(a[0]), ftToM(a[1]), ftToM(a[2])];
