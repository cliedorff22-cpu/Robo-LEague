// hazards.js - the arena's moving parts: floor screws, corner hammers and the
// pulverizer.
//
// All three are KINEMATIC position-based bodies: we drive their transform each
// step and Rapier works out the impulse they impart. That makes them
// unstoppable (a 250 lb bot cannot stall a hammer) which is how the real
// hazards behave.
//
// Each hazard runs a small state machine - armed -> swinging -> retracting ->
// cooldown - triggered by a bot entering its trigger radius. Geometry and
// timings all come from arena.json.

import { RAPIER } from "./physics.js";
import { ftToM, degToRad, lbToKg, rpmToRadps } from "../core/units.js";
import { quatFromYaw, quatFromAxisAngle, quatMul, applyQuat } from "../core/vec.js";
import { EV } from "../core/bus.js";
import { makeRng, hashSeed } from "../core/rng.js";
import { pitRects } from "./world.js";

const STATE = {
  ARMED: "armed", SWINGING: "swinging", RETRACTING: "retracting", COOLDOWN: "cooldown",
  // Killsaw states: below the deck until the last minute of the match.
  STOWED: "stowed", RISING: "rising", SPINNING: "spinning", LOWERING: "lowering",
};

/**
 * @param opts.seed  match seed. The rotating killsaw draw comes from it, so a
 *                   replayed match brings up the same saws at the same times.
 */
export function buildHazards(world, arena, bus, opts = {}) {
  const hazards = [];
  const sawRota = makeSawRotation(arena, opts.seed ?? 1);

  for (const def of arena.hazards) {
    if (def.enabled === false) continue;
    const posM = { x: ftToM(def.pos[0]), y: ftToM(def.pos[1]), z: ftToM(def.pos[2]) };
    const yaw = degToRad(def.yaw);

    if (def.type === "screw") hazards.push(makeScrew(world, def, posM, yaw, arena));
    else if (def.type === "killsaw") hazards.push(makeKillsaw(world, def, posM, yaw, arena.killsaw || {}, bus));
    else if (def.type === "pit") hazards.push(makePit(world, def, posM, arena, bus));
    else hazards.push(makeSwinger(world, def, posM, yaw, bus));
  }

  return {
    all: hazards,
    /**
     * Advance every hazard.
     * @param {number} dt
     * @param {Array} botPositions  {x,y,z} in metres
     * @param {object} ctx  { remainingS } - the killsaws deploy off the match clock
     */
    update(dt, botPositions, ctx = {}) {
      const sawCtx = { ...ctx, killsawActive: sawRota.activeAt(ctx.remainingS) };
      for (const h of hazards) h.update(dt, botPositions, sawCtx);
    },
    /** Ids of the killsaws that should be up with `remainingS` on the clock. */
    killsawActiveAt: (remainingS) => sawRota.activeAt(remainingS),
    /** Render-facing description, built once. */
    pieces: () => hazards.flatMap((h) => h.pieces),
    /** Live transforms for the renderer to copy each frame. */
    transforms: () => hazards.flatMap((h) => h.transforms()),
  };
}

// ---------------------------------------------------------------- screw
// A PAIR of augers lying side by side along the wall, each a shaft with a
// raised helical flight. Both turn so their upper faces run AWAY from the wall:
// a bot that lands on them gets chewed for a moment and thrown back out into
// the arena.
//
// They stand PROUD of the deck, sitting half-sunk in a solid steel cradle that
// runs back to the kickplate. They used to be buried in a pit with only a sliver
// of crown showing, which a bot could only really find by driving onto it. Up
// here a bot can be rammed into them or thrown up onto them. The cradle is what
// keeps that sane: it fills the space under and behind the augers, so a wedge
// cannot slide in underneath and a bot thrown over them lands on steel, not in a
// gap against the wall.
//
// They used to counter-rotate and pinch toward the middle. That held a bot in
// place for bite after bite - AI bouts measured rookies losing 400-500 hp to
// the screws alone in 40 seconds.
//
// Each auger is its own kinematic body, because each spins about its OWN axis;
// two colliders on one body would orbit each other instead.
function makeScrew(world, def, posM, yaw, arena) {
  const lengthM = ftToM(def.length);
  const radiusM = ftToM(def.radius);
  const count = def.augerCount ?? 2;
  const omega = Math.abs(rpmToRadps(def.rpm));
  const spacingM = ftToM(def.augerSpacing ?? def.radius * 2.2);

  // Auger axis height above the deck; the cradle comes up to it, so the lower
  // half of each auger is enclosed and the upper half is out in the open.
  const centerY = ftToM(def.axisHeight ?? def.radius);

  // Rapier cylinders run along local Y, so tilt -90 deg about X to lay it
  // along local Z, then yaw it to run along its wall.
  const qYaw = quatFromYaw(yaw);
  const qLay = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);
  const qBase = quatMul(qYaw, qLay);

  // Spin sign that makes the top of the barrel move toward the arena centre.
  // For a positive spin about the laid axis, the top surface moves along
  // axis x up.
  const axis = applyQuat({ x: 0, y: 1, z: 0 }, qBase);
  const topX = -axis.z, topZ = axis.x;                  // axis x (0,1,0)
  const outward = topX * -posM.x + topZ * -posM.z >= 0 ? 1 : -1;

  const augers = [];
  const colliders = [];
  for (let i = 0; i < count; i++) {
    const lateral = (i - (count - 1) / 2) * spacingM;
    const off = applyQuat({ x: lateral, y: 0, z: 0 }, qYaw);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(posM.x + off.x, centerY, posM.z + off.z)
        // Born lying down. Left at identity, each auger stood upright for the
        // first step - a 9 ft pole - and was swung flat by the first update,
        // swatting anything near it across the arena.
        .setRotation(qBase)
    );
    // The flights are VISUAL ONLY - the collider is the smooth outer envelope.
    //
    // They used to be thin rotating boxes, and at a 120 Hz step a 24 mm blade
    // sweeping into a 100 kg body tunnels straight through it. Rapier then
    // depenetrates with an enormous impulse and fires the bot through the arena
    // wall. A kinematic cylinder spinning against a bot drags it by friction,
    // which is the behaviour we want, and it is numerically stable.
    colliders.push(world.createCollider(
      RAPIER.ColliderDesc.cylinder(lengthM / 2, radiusM)
        // High friction, no bounce: it should grab a bot, not punt it.
        .setFriction(1.4)
        .setRestitution(0.0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body
    ));
    // `hand` mirrors the flights so the pair reads as a matched set.
    augers.push({ body, dir: outward, hand: i % 2 === 0 ? 1 : -1, part: `auger${i}` });
  }

  // The cradle: a fixed steel box from just in front of the inner auger back to
  // the wall, as tall as the auger axis. Local frame: X across the unit (toward
  // the wall is +X once `toWall` is applied), Z along it.
  const lateral = applyQuat({ x: 1, y: 0, z: 0 }, qYaw);
  const along = lateral.x * posM.x + lateral.z * posM.z;
  const toWall = along >= 0 ? 1 : -1;
  const wallHalf = Math.abs(lateral.x) > Math.abs(lateral.z)
    ? ftToM(arena.floor.size[0]) / 2 : ftToM(arena.floor.size[1]) / 2;
  // The inner auger overhangs the cradle face by a centimetre. Set back even a
  // few centimetres, a flat-nosed bot hits the steel box and never touches the
  // teeth; any more overhang and a wedge can slide in under the auger.
  const overhang = 0.01;
  const front = -toWall * (spacingM * (count - 1) / 2 + radiusM - overhang);   // arena side
  const back = toWall * (wallHalf - Math.abs(along) - 0.005);             // at the wall
  const cradleW = Math.abs(back - front);
  const cradleMid = (front + back) / 2;
  const cradleOff = applyQuat({ x: cradleMid, y: 0, z: 0 }, qYaw);
  const cradlePos = { x: posM.x + cradleOff.x, y: centerY / 2, z: posM.z + cradleOff.z };
  const cradleL = lengthM + 0.24;                  // room for the bearing blocks
  const cradle = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cradlePos.x, cradlePos.y, cradlePos.z)
  );
  cradle.setRotation(qYaw, false);
  // Not in `colliders`: combat treats those as the hazard's teeth, and the
  // cradle is just furniture - running into it does no damage.
  const cradleCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(cradleW / 2, centerY / 2, cradleL / 2)
      .setFriction(0.6).setRestitution(0.1),
    cradle
  );
  // Bearing blocks the shafts turn in, standing on the cradle at each end, up
  // to the crown. Solid, so the picture and the physics agree.
  const blockH = radiusM * 1.15, blockD = 0.1;
  for (const end of [-1, 1]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(cradleW / 2, blockH / 2, blockD / 2)
        .setTranslation(0, centerY / 2 + blockH / 2, end * (lengthM / 2 + blockD / 2 + 0.01))
        .setFriction(0.6).setRestitution(0.1),
      cradle
    );
  }

  let spin = 0;
  const pieces = [{
    kind: "screw", hazardId: def.id,
    radius: radiusM, length: lengthM,
    pos: { x: posM.x, y: 0, z: posM.z }, yaw, centerY,
    augers: augers.map((a) => ({ part: a.part, hand: a.hand })),
    spacing: spacingM,
    // Which way the wall is, across the unit (+1 or -1 along local X).
    toWall,
  }, {
    kind: "screwCradle", hazardId: def.id,
    size: [cradleW, centerY, cradleL], pos: cradlePos, yaw,
    endBlock: { height: blockH, depth: blockD, offset: lengthM / 2 + blockD / 2 + 0.01 },
  }];

  return {
    id: def.id, type: "screw", def,
    // `body` is the first auger: combat reads it for closing speed, and a
    // single representative body is all that needs.
    body: augers[0].body,
    bodies: augers.map((a) => a.body),
    pieces, colliders, cradleCollider,
    state: STATE.ARMED,
    // A screw never stops turning, so it is always dangerous.
    get live() { return true; },
    update(dt) {
      spin += omega * dt;
      for (const a of augers) {
        // Spin about the barrel's own axis: applied before the lay/yaw rotation.
        a.body.setNextKinematicRotation(
          quatMul(qBase, quatFromAxisAngle({ x: 0, y: 1, z: 0 }, spin * a.dir))
        );
      }
    },
    transforms: () => augers.map((a) => ({
      hazardId: def.id, part: a.part, pos: a.body.translation(), quat: a.body.rotation(),
    })),
  };
}

// ---------------------------------------------------------------- hammer / pulverizer
// Modelled on the real pulverizers: a steel pedestal standing on the deck in
// the corner, with the hammer arm hinged at its top. The arm waits standing
// up (leaning back toward the corner), then whips forward over the top and
// slams the head flat onto the floor in front of it - a sledgehammer, not a
// pendulum hung off the wall.
//
// `pos` is where the HEAD LANDS. The pivot sits `armLength` behind that,
// toward the corner, at `pivotHeight` above the deck.
//
// Angle convention, about the hinge (local X after yawing): 0 = arm pointing
// straight down, 180 = straight up, 270 = straight out over the floor. Local
// +Z faces into the arena, and the head hangs off the arm toward local -Z,
// which is "down" when the arm lies flat at 270.
//
// headSize = [width across the arm, length along the arm, depth of the face].
function makeSwinger(world, def, posM, yaw, bus) {
  const armLength = ftToM(def.armLength);
  const [hw, hl, hd] = def.headSize.map(ftToM);
  const pivotY = ftToM(def.pivotHeight);
  const restA = degToRad(def.restAngle);
  const strikeA = degToRad(def.strikeAngle);
  const triggerR = ftToM(def.triggerRadius);
  const headMassKg = lbToKg(def.headMass);
  const armW = ftToM(def.armWidth ?? 0.42);
  const armT = ftToM(def.armThickness ?? 0.5);

  const qYaw = quatFromYaw(yaw);
  const fwd = applyQuat({ x: 0, y: 0, z: 1 }, qYaw);
  const pivot = { x: posM.x - fwd.x * armLength, y: pivotY, z: posM.z - fwd.z * armLength };

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(pivot.x, pivot.y, pivot.z)
  );

  // The head is offset toward local -Z so that, with the arm flat, its face
  // sits under the arm and meets the deck. 0.35 of its depth hangs below the
  // arm's centreline per 0.5 - i.e. it rides slightly above the arm too.
  const headLocal = { x: 0, y: -armLength, z: -hd * 0.35 };

  const colliders = [];
  colliders.push(world.createCollider(
    RAPIER.ColliderDesc.cuboid(armW / 2, armLength / 2, armT / 2)
      .setTranslation(0, -armLength / 2, 0)
      .setFriction(0.5).setRestitution(0.2)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body
  ));
  // Heavy, but mass is irrelevant on a kinematic body - we keep it in the data
  // because the damage model computes impact energy from it.
  colliders.push(world.createCollider(
    RAPIER.ColliderDesc.cuboid(hw / 2, hl / 2, hd / 2)
      .setTranslation(headLocal.x, headLocal.y, headLocal.z)
      .setFriction(0.6).setRestitution(0.25)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body
  ));

  // The pedestal is solid: a bot driven into the corner hits steel. Static and
  // NOT in `colliders`, so touching it is not a hazard hit.
  const baseSize = (def.baseSize ?? [2.2, def.pivotHeight - 0.25, 1.6]).map(ftToM);
  const base = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(pivot.x, baseSize[1] / 2, pivot.z)
  );
  base.setRotation(qYaw, false);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(baseSize[0] / 2, baseSize[1] / 2, baseSize[2] / 2)
      .setFriction(0.5).setRestitution(0.1),
    base
  );
  let state = STATE.ARMED;
  let t = 0;                 // seconds spent in the current state
  let angle = restA;

  const setAngle = (a) => {
    angle = a;
    body.setNextKinematicRotation(quatMul(qYaw, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, a)));
  };
  setAngle(restA);

  // The trigger watches where the head LANDS (`pos`), not the pivot or the
  // cocked head. Measuring from anywhere else makes the hazard swing at bots
  // that are out of reach and ignore the ones standing in the kill zone.
  const triggerPoint = { x: posM.x, y: 0, z: posM.z };

  const pieces = [
    { kind: "swingerArm", hazardId: def.id, length: armLength, thickness: [armW, armT] },
    { kind: "swingerHead", hazardId: def.id, size: [hw, hl, hd], local: headLocal, armLength, headMassKg },
    { kind: "swingerPivot", hazardId: def.id, pos: pivot, quat: qYaw },
    { kind: "swingerBase", hazardId: def.id, size: baseSize, pos: { x: pivot.x, y: baseSize[1] / 2, z: pivot.z }, quat: qYaw },
  ];

  return {
    id: def.id, type: def.type, def, body, pieces, colliders,
    get state() { return state; },
    get angle() { return angle; },
    /** World centre of the head right now - for tests and the camera. */
    headCenter() {
      const t = body.translation();
      const o = applyQuat(headLocal, body.rotation());
      return { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z };
    },

    /**
     * Dangerous right now?
     *
     * Deliberately NOT just `state === "swinging"`. The swing completes and the
     * state flips to RETRACTING inside the same update that puts the head at its
     * lowest point - which is one physics step BEFORE the contact it causes gets
     * reported. Gating on "swinging" alone therefore missed every single hit.
     * The head is still travelling fast early in the retract, so that counts too.
     */
    get live() {
      return state === STATE.SWINGING ||
             (state === STATE.RETRACTING && t < Math.min(0.2, def.retractTimeS * 0.35));
    },

    update(dt, botPositions = []) {
      t += dt;
      switch (state) {
        case STATE.ARMED: {
          const near = botPositions.some((p) => {
            const dx = p.x - triggerPoint.x, dz = p.z - triggerPoint.z;
            return dx * dx + dz * dz < triggerR * triggerR;
          });
          if (near) {
            state = STATE.SWINGING; t = 0;
            bus?.emit(EV.HAZARD_FIRE, { id: def.id, type: def.type });
          }
          break;
        }
        case STATE.SWINGING: {
          // Ease-in: a falling hammer accelerates, so t^2 beats linear here.
          const u = Math.min(1, t / def.swingTimeS);
          setAngle(restA + (strikeA - restA) * (u * u));
          if (u >= 1) { state = STATE.RETRACTING; t = 0; }
          break;
        }
        case STATE.RETRACTING: {
          const u = Math.min(1, t / def.retractTimeS);
          setAngle(strikeA + (restA - strikeA) * easeInOut(u));
          if (u >= 1) { state = STATE.COOLDOWN; t = 0; }
          break;
        }
        case STATE.COOLDOWN: {
          if (t >= def.cooldownS) { state = STATE.ARMED; t = 0; }
          break;
        }
      }
    },

    transforms: () => [{ hazardId: def.id, part: "arm", pos: body.translation(), quat: body.rotation() }],
  };
}

const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

export { STATE as HAZARD_STATE };

// ---------------------------------------------------------------- killsaw
// Saw blades living in a slot under the deck. They sit below the floor for most
// of the match. In the last minute ("rotating", the default) a random handful
// come up, and every few seconds a fresh handful replaces them - so the safe
// ground keeps moving and the closing stretch is a genuinely different fight.
//
// Kinematic like the other hazards: their vertical travel is driven directly,
// so nothing can hold them down.
function makeKillsaw(world, def, posM, yaw, shared, bus) {
  const cfg = { ...shared, ...def };
  const bladeR = ftToM(cfg.bladeRadius ?? 1.1);
  const bladeT = ftToM(cfg.bladeThickness ?? 0.08);
  const count = cfg.bladeCount ?? 2;
  const spacing = ftToM(cfg.bladeSpacing ?? 1.1);
  const stowedY = -ftToM(cfg.stowedDepth ?? 1.3);
  const deployedY = ftToM(cfg.deployedHeight ?? 0.55) - bladeR;   // hub below the deck
  const riseS = cfg.riseS ?? 0.45;
  const omega = rpmToRadps(cfg.rpm ?? 1400);
  const triggerR = ftToM(cfg.triggerRadius ?? 4.0);
  const deployAt = cfg.deployAtRemainingS ?? 60;
  const mode = cfg.deploy ?? "rotating";
  const clocked = mode === "timed" || mode === "rotating";

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(posM.x, stowedY, posM.z)
  );

  // Blades are thin discs side by side on one axle running ACROSS the slot
  // (local X), each standing in the plane of the slot and coming up through its
  // own slit in the cover. They used to be offset along the slot instead, and
  // the body spun about the vertical, so the blades swung round like a
  // turntable rather than turning on their axle.
  const colliders = [];
  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * spacing;
    colliders.push(world.createCollider(
      RAPIER.ColliderDesc.cylinder(bladeT / 2, bladeR)
        .setTranslation(offset, 0, 0)
        .setRotation(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2))
        .setFriction(0.3)
        .setRestitution(0.35)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body
    ));
  }

  let state = STATE.STOWED;
  let spin = 0;
  let travel = 0;             // 0 = stowed, 1 = fully up
  let armedByClock = false;

  const setPose = () => {
    const y = stowedY + (deployedY - stowedY) * travel;
    body.setNextKinematicTranslation({ x: posM.x, y, z: posM.z });
    // Turn on the axle (local X), which runs through every blade's centre.
    body.setNextKinematicRotation(
      quatMul(quatFromYaw(yaw), quatFromAxisAngle({ x: 1, y: 0, z: 0 }, spin))
    );
  };
  setPose();

  const pieces = [{
    kind: "killsaw", hazardId: def.id,
    bladeRadius: bladeR, bladeThickness: bladeT, bladeCount: count, bladeSpacing: spacing,
    slotLength: ftToM(cfg.slotLength ?? 3.0),
    // How far the blade tops stand above the deck when fully up - the drawn
    // cover's slit has to be long enough for that chord.
    deployedHeight: ftToM(cfg.deployedHeight ?? 0.55),
    pos: { x: posM.x, y: 0, z: posM.z }, yaw,
  }];

  return {
    id: def.id, type: "killsaw", def: cfg, body, pieces, colliders,
    get state() { return state; },
    get deployed() { return travel > 0.5; },
    // Only dangerous once the blades are actually clear of the deck.
    get live() { return travel > 0.35; },
    get travel() { return travel; },

    update(dt, botPositions = [], ctx = {}) {
      // The clock decides whether these are live at all.
      const remaining = ctx.remainingS;
      if (clocked) {
        armedByClock = remaining !== undefined && remaining <= deployAt;
      } else {
        armedByClock = true;
      }

      let want;
      if (!armedByClock) {
        want = 0;
      } else if (mode === "rotating") {
        // The draw is made once for all saws in buildHazards - see makeSawRotation.
        want = ctx.killsawActive?.has(def.id) ? 1 : 0;
      } else if (mode === "timed") {
        want = 1;                       // up for the rest of the match
      } else {
        const near = botPositions.some((b) => {
          const dx = b.x - posM.x, dz = b.z - posM.z;
          return dx * dx + dz * dz < triggerR * triggerR;
        });
        want = near ? 1 : 0;
      }

      const before = travel;
      const rate = dt / Math.max(0.01, riseS);
      // Must hold still when already where it wants to be. This used to be a
      // bare `want > travel ? up : down`, so a saw at full height (want == travel
      // == 1) took the "down" branch every other step and chattered between
      // spinning and lowering for the whole last minute.
      if (want > travel) travel = Math.min(1, travel + rate);
      else if (want < travel) travel = Math.max(0, travel - rate);

      if (travel >= 1) state = STATE.SPINNING;
      else if (travel <= 0) state = STATE.STOWED;
      else state = want > before ? STATE.RISING : STATE.LOWERING;

      // Only spinning once they are actually out of the floor.
      if (travel > 0.05) spin += omega * dt;
      setPose();

      if (before <= 0.05 && travel > 0.05) {
        bus?.emit(EV.HAZARD_FIRE, { id: def.id, type: "killsaw" });
      }
    },

    transforms: () => [{ hazardId: def.id, part: "blades", pos: body.translation(), quat: body.rotation() }],
  };
}

// ---------------------------------------------------------------- pit
// A square of deck that sinks out of the floor late in the match and stays
// down: the Robot Wars pit. world.js has already cut the hole, lined it with
// steel and put a floor in it; this is the panel, a kinematic slab flush with
// the deck until `openAtRemainingS`, then lowered over `lowerS` to the bottom.
// A robot on it goes down with it. It does no damage itself - it has no
// colliders in the combat index - the referee rules a robot below the deck out.
function makePit(world, def, posM, arena, bus) {
  const rect = pitRects({ hazards: [def] })[0];
  const depth = rect.depth;
  const lidT = 0.1;
  const openAt = def.openAtRemainingS ?? 90;
  const lowerS = Math.max(0.1, def.lowerS ?? 2.5);
  const warnS = def.warnS ?? 4;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(rect.cx, -lidT / 2, rect.cz)
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(rect.hw - 0.005, lidT / 2, rect.hl - 0.005)
      .setFriction(arena.floor?.friction ?? 1).setRestitution(arena.floor?.restitution ?? 0.02),
    body
  );

  let travel = 0;            // 0 = flush with the deck, 1 = at the bottom
  let warning = 0;           // 0..1 while the edge lights flash before it opens
  let fired = false;
  const pieces = [{ kind: "pit", hazardId: def.id, pos: { x: rect.cx, y: 0, z: rect.cz }, hw: rect.hw, hl: rect.hl, depth, lidT }];

  return {
    id: def.id, type: "pit", def, body, pieces, colliders: [],
    get state() { return travel >= 1 ? "open" : travel > 0 ? "lowering" : warning > 0 ? "warning" : "closed"; },
    get travel() { return travel; },
    get warning() { return warning; },
    get open() { return travel > 0.3; },
    // Nothing here hurts; it is the drop that counts.
    get live() { return false; },
    rect,

    update(dt, botPositions, ctx = {}) {
      const remaining = ctx.remainingS;
      const due = remaining !== undefined && remaining <= openAt;
      warning = !due && remaining !== undefined && remaining <= openAt + warnS ? 1 - (remaining - openAt) / warnS : 0;
      if (due && travel < 1) {
        travel = Math.min(1, travel + dt / lowerS);
        if (!fired) { fired = true; bus?.emit(EV.HAZARD_FIRE, { id: def.id, type: "pit" }); }
      } else if (!due && travel > 0) {
        // A rematch winds the clock back: the panel comes back up.
        travel = 0; fired = false;
      }
      body.setNextKinematicTranslation({ x: rect.cx, y: -lidT / 2 - travel * (depth - lidT / 2 - 0.02), z: rect.cz });
    },

    transforms: () => [{ hazardId: def.id, part: "lid", pos: body.translation(), quat: body.rotation() }],
  };
}

// ---------------------------------------------------------------- killsaw rotation
// Which saws are up, as a pure function of the match clock. From
// `deployAtRemainingS` the last minute is cut into `rotateEveryS` windows; each
// window gets `activeCount` saws drawn from a stream seeded by the match seed,
// and no window repeats the exact set before it (otherwise a "rotation" would
// sometimes visibly do nothing).
//
// Deriving it from the clock rather than keeping a timer means pausing,
// scrubbing a replay or restarting the match can never desync it.
function makeSawRotation(arena, seed) {
  const cfg = arena.killsaw || {};
  const ids = arena.hazards
    .filter((h) => h.type === "killsaw" && h.enabled !== false)
    .map((h) => h.id);
  const empty = new Set();
  if ((cfg.deploy ?? "rotating") !== "rotating" || !ids.length) {
    return { activeAt: () => empty };
  }
  const every = Math.max(0.5, cfg.rotateEveryS ?? 5);
  const k = Math.max(1, Math.min(ids.length, cfg.activeCount ?? 3));
  const deployAt = cfg.deployAtRemainingS ?? 60;
  const rng = makeRng(hashSeed(`${arena.id}:killsaws:${seed}`));
  const windows = [];          // window index -> Set of ids, filled lazily in order

  const key = (set) => [...set].sort().join(",");
  function windowSet(i) {
    while (windows.length <= i) {
      const prev = windows[windows.length - 1];
      let next;
      // With k == ids.length there is only one possible set; do not spin.
      for (let tries = 0; tries < 8; tries++) {
        next = new Set(rng.shuffle(ids).slice(0, k));
        if (!prev || k === ids.length || key(next) !== key(prev)) break;
      }
      windows.push(next);
    }
    return windows[i];
  }

  return {
    activeAt(remainingS) {
      if (remainingS === undefined || remainingS > deployAt) return empty;
      return windowSet(Math.floor((deployAt - Math.max(0, remainingS)) / every));
    },
  };
}
