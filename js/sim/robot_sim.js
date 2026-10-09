// robot_sim.js - the physical robot: one rigid body plus a raycast wheel model.
//
// Why not Rapier's built-in vehicle controller? It assumes steered front
// wheels. Battlebots are skid-steer (tank drive): both sides are driven
// independently and the bot pivots by scrubbing its tyres sideways. So we run
// our own four-wheel model:
//
//   per wheel, each step:
//     1. raycast down from the suspension mount
//     2. spring + damper force along the contact normal   -> ride height, weight transfer
//     3. longitudinal force toward the commanded track speed  -> drive and engine braking
//     4. lateral force opposing sideways scrub, capped      -> lets the bot pivot and drift
//     5. clamp (3) and (4) into the friction circle         -> grip runs out believably
//
// It is about 80 lines of vector maths with no engine-specific calls, which is
// exactly what we want to carry over to Godot or Unity later.
//
// Every tunable number comes from the assembled build (js/logic/build.js), so
// fitting bigger wheels or stronger motors changes the handling with no code
// edits.

import { makeRng, hashSeed } from "../core/rng.js";
import { RAPIER } from "./physics.js";
import { ROBOT_FILTER } from "./world.js";
import { effectiveStats } from "../logic/condition.js";
import { buildShape, routeFittings } from "../logic/shape.js";
import { bounds, flatten } from "../core/hull.js";
import {
  computeWheelForces, suspensionRates, skidSteerMix, taperSteerForYawRate, ROLLING_RESIST_COEFF,
  SUSPENSION_PRELOAD, wheelLayout,
} from "./wheel_model.js";
import { v3, add, sub, scale, dot, cross, normalize, len, applyQuat, quatFromYaw, quatFromAxisAngle } from "../core/vec.js";

const GRAVITY = 9.81;

const DAMPING_RATIO = 0.7;

/**
 * Instantiate an assembled robot in the physics world.
 * @param {object} sim        from buildArena()
 * @param {object} assembled  from assembleRobot()
 * @param {object} spawn      { pos: {x,y,z} in metres, yaw: radians }. pos.y lifts the
 *                            bot above its rest height (a drop test); 0 is on its wheels.
 * @param {object} rules      rulebook, for reading damage condition
 */
export function createRobotSim(sim, assembled, spawn, rules, { seed = 1 } = {}) {
  const { world } = sim;
  // Signal dropouts from failing electronics change how the bot drives, so
  // they change results - they get their own seeded stream like everything
  // else. (This was Math.random(), "cosmetic": it made otherwise identical
  // fights end differently from one run to the next.)
  const dropRng = makeRng(hashSeed(`dropout:${assembled.id}:${seed}`));
  const { dims, massKg, comLocalM, inertia, stats } = assembled;

  // ---- ride height. The chassis floor should clear the ground by the build's
  // ground clearance once the springs have settled to their preload.
  const layout = wheelLayout(assembled);
  const { restLength, clearance } = layout;
  if (clearance <= restLength * SUSPENSION_PRELOAD) {
    console.warn(
      `[sim] ${assembled.id}: ground clearance ${(clearance * 1000).toFixed(0)} mm is less than ` +
      `the resting suspension compression - the chassis will drag on the floor.`
    );
  }
  // Spawn exactly at rest height. Dropping the bot in from above put the
  // wheel mounts beyond their rays' reach, so the first contact arrived as a
  // slam rather than a settle.
  const spawnY = layout.spawnY;

  // ---- body.
  //
  // Mass, centre of mass and principal inertia come from the build, so the
  // workshop's numbers are the numbers the physics actually uses.
  //
  // IMPORTANT: they are set on the CHASSIS COLLIDER via setMassProperties(),
  // not on the body via setAdditionalMassProperties(). In Rapier 0.21 the
  // "additional" mass routes leave mass() and invMass() at zero - gravity
  // still accelerates the body, but applied forces do nothing at all, so the
  // entire wheel model silently does nothing. Verified in tests/sim.test.js
  // ("forces can actually accelerate the body"). Do not switch back.
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawn.pos.x, spawnY + (spawn.pos.y || 0), spawn.pos.z)
    .setRotation(quatFromYaw(spawn.yaw))
    .setLinearDamping(0.08)
    .setAngularDamping(0.35)
    .setCcdEnabled(true);

  const body = world.createRigidBody(bodyDesc);

  // ---- colliders, from the robot's shape (js/logic/shape.js): one per
  // convex piece, each routed to the fitting a hit on it damages, plus the
  // weapon's swept volume. The renderer draws the same pieces.
  //
  // Every collider but the chassis core is density 0, so the core's explicit
  // mass properties are the body's entire mass budget.
  const shape = buildShape(assembled);
  const routes = routeFittings(shape, assembled);
  const colliderToFitting = new Map();
  // Which shape slot each collider is (a wedge, a fork, armour...) - combat
  // asks, because a rotor striking a wedge glances off it.
  const colliderToSlot = new Map();
  const addCollider = (desc, fittingKey, slot = null) => {
    const c = world.createCollider(
      desc.setDensity(0)
        .setCollisionGroups(ROBOT_FILTER)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body
    );
    colliderToFitting.set(c.handle, fittingKey);
    if (slot) colliderToSlot.set(c.handle, slot);
    return c;
  };

  // A piece's collider. The classic box-and-panels look is made of boxes and
  // keeps exact cuboids, so the original bots handle exactly as they did.
  const pieceDesc = (piece) => {
    if (shape.template === "classic" && piece.points.length === 8) {
      const b = bounds(piece.points);
      return RAPIER.ColliderDesc.cuboid((b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2, (b.max.z - b.min.z) / 2)
        .setTranslation((b.max.x + b.min.x) / 2, (b.max.y + b.min.y) / 2, (b.max.z + b.min.z) / 2);
    }
    const desc = RAPIER.ColliderDesc.convexHull(flatten(piece.points));
    if (!desc) console.warn(`[sim] ${assembled.id}: convex hull failed for piece "${piece.id}"`);
    return desc;
  };

  // The chassis core carries the build's mass properties. It sits in the body
  // frame unrotated, so comLocalM needs no transform.
  const corePiece = shape.pieces.find((x) => x.id === "core");
  const chassisCollider = world.createCollider(
    pieceDesc(corePiece)
      .setMassProperties(massKg, comLocalM, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.5)
      .setRestitution(0.1)
      .setCollisionGroups(ROBOT_FILTER)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body
  );
  colliderToFitting.set(chassisCollider.handle, "chassis");

  for (const piece of shape.pieces) {
    if (piece === corePiece) continue;
    const desc = pieceDesc(piece);
    if (!desc) continue;
    // The wedge is slick so opponents ride up it; armour a touch grippier.
    const slick = piece.slot === "weapon" || piece.slot === "wedge";
    addCollider(desc.setFriction(slick ? 0.18 : 0.45).setRestitution(slick ? 0.1 : 0.15), routes.get(piece.id), piece.slot);
  }

  // --- powered weapons need a physical presence, or nothing can ever be hit
  // by one. These sit in the weapon's swept volume rather than spinning as
  // separate bodies: for damage routing that is enough, and it keeps a 150 m/s
  // rim from needing its own joint and CCD budget. A bar genuinely sticks out
  // past the chassis, so it catches walls too - which is correct.
  for (const c of shape.weapon?.colliders || []) {
    let desc;
    if (c.type === "cylinder") {
      desc = RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius).setTranslation(c.center.x, c.center.y, c.center.z);
      // Rapier cylinders run along local Y; a lateral (Z) axle is a quarter turn about X.
      if (c.axis === "z") desc.setRotation(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2));
      else if (c.axis === "x") desc.setRotation(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2));
    } else if (c.type === "cuboid") {
      desc = RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z).setTranslation(c.center.x, c.center.y, c.center.z);
    } else {
      desc = RAPIER.ColliderDesc.convexHull(flatten(c.points));
    }
    if (desc) addCollider(desc.setFriction(0.35).setRestitution(0.3), "weapon", "rotor");
  }
  const wedgeInfo = shape.weapon?.wedge || null;

  // ---- wheels. Positions come from the chassis footprint; which ones are
  // powered comes from the drive part.
  const wheels = layout.wheels;
  const powered = choosePoweredWheels(wheels, stats.drivenWheels);

  // Spring rate sized so the preload exactly carries the bot's weight.
  const { springK, springC } = suspensionRates({
    massKg,
    wheelCount: wheels.length,
    restLength,
    preload: SUSPENSION_PRELOAD,
    dampingRatio: DAMPING_RATIO,
    gravity: GRAVITY,
  });

  const driveGain = stats.forcePerWheelN / Math.max(0.5, stats.topSpeedMps * 0.25);
  const latGain = massKg * GRAVITY * 1.8;

  // Effective stats reflect damage (see js/logic/condition.js). Cached because
  // recomputing per wheel per step would be wasteful, and invalidated whenever
  // something hits the bot.
  let effCache = null;
  const effective = () => {
    if (!effCache) effCache = effectiveStats(assembled, rules);
    return effCache;
  };
  const invalidate = () => { effCache = null; };

  // Electronics failing cause intermittent dropouts before they quit entirely.
  let dropoutUntilS = 0;
  let simClockS = 0;

  // ---- inverted running. An invertible body (tyres proud of it top and
  // bottom - shape.js derives that) drives on the other face of its tyres
  // when it is upside down: the wheel mounts mirror about the axle, the rays
  // point the other way, and left and right swap so that "turn left" still
  // turns left as the driver sees it. Hysteresis stops it flickering on edge.
  const axleDrop = restLength * (1 - SUSPENSION_PRELOAD);
  const invertedAnchors = wheels.map((w) => ({ ...w.anchor, y: w.anchor.y - 2 * axleDrop }));
  let inverted = false;

  // ---- self-righting: a srimech, or a flipper/hammer/lifter pushing off the
  // floor (build.js deriveSelfRight). A hop and a roll put it back on its
  // wheels, from its back or its side.
  const selfRightSpec = stats.selfRight || { via: "none" };
  let selfRightReadyS = 0;
  let upsideDownS = 0;
  const canSelfRight = () => {
    if (selfRightSpec.via === "none" || shape.invertible) return false;
    if (effective().immobile) return false;
    return (assembled.condition[selfRightSpec.fitting] ?? 0) > 0;
  };
  const rightRng = makeRng(hashSeed(`selfright:${assembled.id}:${seed}`));
  function trySelfRight() {
    if (!canSelfRight() || simClockS < selfRightReadyS) return false;
    // An unreliable method (a gyro dance) can fail and still costs its wait.
    if (selfRightSpec.chance != null && rightRng.next() > selfRightSpec.chance) {
      selfRightReadyS = simClockS + selfRightSpec.cooldownS;
      return false;
    }
    const rot = body.rotation();
    const upW = applyQuat({ x: 0, y: 1, z: 0 }, rot);
    if (upW.y > 0.45) return false;              // already on its wheels
    // Roll toward upright: about the axis that carries the robot's up toward
    // the world's, or about its long axis when it is flat on its back. The
    // push off the floor sets how long it is airborne; the twist is sized from
    // the robot's real inertia to turn exactly as far as it needs in that time
    // - a quarter turn from its side, a half turn from its back. (A fixed
    // twist spun bots through two or three turns and landed them anywhere.)
    let axis = cross(upW, { x: 0, y: 1, z: 0 });
    if (len(axis) < 0.05) axis = applyQuat({ x: 1, y: 0, z: 0 }, rot);
    axis = normalize(axis);
    const j = selfRightSpec.impulseNs * (massKg / 100);
    const vUp = Math.min(3.2, j / massKg);
    const airS = (2 * vUp) / GRAVITY;
    const angle = Math.acos(Math.max(-1, Math.min(1, upW.y)));
    // Inertia about that axis, from the build's principal moments.
    const aBody = applyQuat(axis, { x: -rot.x, y: -rot.y, z: -rot.z, w: rot.w });
    const iAxis = aBody.x * aBody.x * inertia.x + aBody.y * aBody.y * inertia.y + aBody.z * aBody.z * inertia.z;
    const omega = (angle / Math.max(0.15, airS)) * 1.05;
    body.applyImpulse({ x: 0, y: vUp * massKg, z: 0 }, true);
    body.applyTorqueImpulse(scale(axis, iAxis * omega), true);
    selfRightReadyS = simClockS + selfRightSpec.cooldownS;
    sState.selfRights = (sState.selfRights || 0) + 1;
    return true;
  }

  const sState = {
    body,
    assembled,
    colliderToFitting,
    wheels,
    // The renderer needs the travel length to place wheels from compression.
    suspension: { restLength, springK, springC, preload: SUSPENSION_PRELOAD },
    wedgeInfo,
    // The convex pieces the renderer draws - the same ones collided above.
    shape,
    routes,
    spawn: { pos: { ...spawn.pos, y: spawnY }, yaw: spawn.yaw },
    // Per-wheel telemetry the renderer and HUD read (load, slip, grounded).
    telemetry: wheels.map(() => ({ grounded: false, load: 0, compression: 0, spin: 0, slip: 0 })),
  };

  /** Apply one step of drive forces. `input` is {throttle, steer, brake}. */
  // Sanity limits on the body itself (rules.json `limits`). A pulverizer
  // landing on two robots wedged together in a corner once had the solver
  // push one out at 20 m/s and 55 rad/s - clean over the wall. Nothing a
  // real fight does gets near these, so they only ever catch a glitch.
  const LIM = { maxSpeedMps: 12, maxUpMps: 6.5, maxSpinRadS: 28, ...(rules.limits || {}) };
  function clampMotion() {
    const v = body.linvel(), w = body.angvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    let nv = v;
    if (sp > LIM.maxSpeedMps) nv = scale(v, LIM.maxSpeedMps / sp);
    if (nv.y > LIM.maxUpMps) nv = { x: nv.x, y: LIM.maxUpMps, z: nv.z };
    if (nv !== v) { body.setLinvel(nv, true); sState.clamped = (sState.clamped || 0) + 1; }
    const ws = Math.hypot(w.x, w.y, w.z);
    if (ws > LIM.maxSpinRadS) { body.setAngvel(scale(w, LIM.maxSpinRadS / ws), true); sState.clamped = (sState.clamped || 0) + 1; }
  }

  function step(input, dt) {
    body.resetForces(false);
    body.resetTorques(false);
    simClockS += dt;
    clampMotion();

    const eff = effective();

    // A destroyed chassis, dead electronics or no wheels left means no drive at
    // all. The bot still slides around; it just cannot do anything about it.
    if (eff.immobile) {
      sState.groundedCount = 0;
      for (const t of sState.telemetry) { t.grounded = false; t.load = 0; t.compression = 0; }
      return;
    }

    // Failing electronics drop the signal intermittently. The bot coasts
    // through a dropout, which is exactly how a dying receiver feels.
    if (eff.dropoutHz > 0) {
      if (simClockS < dropoutUntilS) {
        input = { throttle: 0, steer: 0, brake: false, weapon: 0 };
      } else if (dropRng.next() < eff.dropoutHz * dt) {
        dropoutUntilS = simClockS + eff.dropoutS;
      }
    }

    const pos = body.translation();
    const rot = body.rotation();
    const linvel = body.linvel();
    const angvel = body.angvel();

    const up = applyQuat({ x: 0, y: 1, z: 0 }, rot);
    const fwd = applyQuat({ x: 1, y: 0, z: 0 }, rot);

    if (shape.invertible) {
      if (!inverted && up.y < -0.25) inverted = true;
      else if (inverted && up.y > 0.25) inverted = false;
    }
    sState.inverted = inverted;
    upsideDownS = up.y < 0.45 ? upsideDownS + dt : 0;
    // Self-right on request - the weapon button while flipped, or the AI's
    // explicit call - once it has settled on its back for a moment.
    if ((input.selfRight || (input.weapon || 0) > 0.5) && upsideDownS > 0.4) trySelfRight();

    // Skid steer: mix throttle and steer into a per-side command, after
    // tapering steering authority near the bot's yaw-rate limit. Inverted,
    // the yaw axis is upside down too, so the steer sense flips.
    const steer = taperSteerForYawRate(
      (input.steer || 0) * (inverted ? -1 : 1), angvel.y * (inverted ? -1 : 1), eff.maxYawRateRadS
    );
    const mix = skidSteerMix(input.throttle || 0, steer);

    let groundedCount = 0;

    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const tele = sState.telemetry[i];

      // --- plumbing: where is the ground under this wheel's mount?
      const anchorWorld = add(pos, applyQuat(inverted ? invertedAnchors[i] : w.anchor, rot));
      const down = inverted ? up : scale(up, -1);
      const maxDist = restLength + eff.wheelRadiusM;

      const ray = new RAPIER.Ray(anchorWorld, down);
      const hit = world.castRayAndGetNormal(
        ray, maxDist, true, undefined, undefined, undefined, body
      );

      if (!hit) {
        tele.grounded = false; tele.load = 0; tele.compression = 0; tele.slip = 0;
        continue;
      }
      groundedCount++;

      const normal = normalize(hit.normal);
      const contact = add(anchorWorld, scale(down, hit.timeOfImpact));

      // Contact-point velocity, and the tyre's frame on the contact plane.
      const r = sub(contact, pos);
      const pointVel = add(linvel, cross(angvel, r));
      const fwdOnPlane = normalize(sub(fwd, scale(normal, dot(fwd, normal))));
      const latOnPlane = normalize(cross(normal, fwdOnPlane));

      // --- maths: pure, testable, engine-agnostic (see wheel_model.js)
      const res = computeWheelForces({
        rayDistance: hit.timeOfImpact,
        wheelRadiusM: eff.wheelRadiusM,
        restLength,
        springK,
        springC,
        // Compression grows as the mount moves DOWN toward the ground, so the
        // rate is the contact velocity along the ray, not against it. This was
        // inverted, which turned the damper into an energy source and made the
        // bot pogo until it drifted across the floor on its own.
        compressionRate: dot(pointVel, down),
        vFwd: dot(pointVel, fwdOnPlane),
        vLat: dot(pointVel, latOnPlane),
        grip: eff.grip,
        lateralGripFraction: eff.lateralGripFraction,
        cmd: w.side === "left" ? mix.left : mix.right,
        // Wheels are lost as the set is destroyed, so a battered bot loses
        // drive on some corners entirely.
        powered: powered.has(i) && i < eff.drivenWheels,
        topSpeedMps: eff.topSpeedMps,
        forcePerWheelN: eff.forcePerWheelN,
        driveGain,
        latGain,
        rollingResistCoeff: ROLLING_RESIST_COEFF,
        brake: !!input.brake,
      });

      tele.grounded = true;
      tele.load = res.loadN;
      tele.compression = res.compression / restLength;
      tele.slip = Math.abs(dot(pointVel, latOnPlane));
      tele.spin += (dot(pointVel, fwdOnPlane) / Math.max(1e-3, eff.wheelRadiusM)) * dt;

      // --- plumbing: push along the contact normal, then drive/corner in-plane.
      body.addForceAtPoint(scale(normal, res.loadN), contact, true);
      body.addForceAtPoint(
        add(scale(fwdOnPlane, res.fLong), scale(latOnPlane, res.fLat)),
        contact,
        true
      );
    }

    sState.groundedCount = groundedCount;
  }

  return {
    ...sState,
    step,
    /** Apply the sanity limits now - call after world.step, so a solver spike never shows. */
    clampMotion,
    /** Current pose, for the renderer. */
    pose: () => ({ pos: body.translation(), quat: body.rotation() }),
    effective,
    /** Call after anything changes this robot's condition. */
    invalidate,
    speedMps: () => len(body.linvel()),
    /** Horizontal speed only. This is what the immobilisation count watches:
     *  a bot being bounced by a hazard is not driving anywhere. */
    groundSpeedMps: () => {
      const v = body.linvel();
      return Math.hypot(v.x, v.z);
    },
    /** How upright the bot is: 1 = level, 0 = on its side, -1 = fully inverted. */
    uprightness: () => applyQuat({ x: 0, y: 1, z: 0 }, body.rotation()).y,
    isGrounded: () => (sState.groundedCount || 0) > 0,
    /** Running on the other face of its tyres right now. */
    get inverted() { return inverted; },
    /** Where wheel i is mounted right now - mirrored while running inverted. */
    wheelAnchor: (i) => (inverted ? invertedAnchors[i] : wheels[i].anchor),
    get selfRights() { return sState.selfRights || 0; },
    /** Can it get itself back over if flipped? (invertible bots never need to) */
    canSelfRight,
    invertible: shape.invertible,
    trySelfRight,
    fittingForCollider: (handle) => colliderToFitting.get(handle) || null,
    slotForCollider: (handle) => colliderToSlot.get(handle) || null,

    /** Put the bot back on its wheels at its spawn - debug/driving aid. */
    reset(pose) {
      const p = pose?.pos || sState.spawn.pos;
      const yaw = pose?.yaw ?? sState.spawn.yaw;
      body.setTranslation({ x: p.x, y: sState.spawn.pos.y, z: p.z }, true);
      body.setRotation(quatFromYaw(yaw), true);
      body.setLinvel(v3(), true);
      body.setAngvel(v3(), true);
      body.resetForces(true);
      body.resetTorques(true);
    },
  };
}

/** 4WD powers everything; 2WD powers the rear axle. */
function choosePoweredWheels(wheels, drivenCount) {
  if (drivenCount >= wheels.length) return new Set(wheels.map((_, i) => i));
  const rear = wheels.map((w, i) => [w, i]).filter(([w]) => w.axle === "rear").map(([, i]) => i);
  return new Set(rear.slice(0, drivenCount));
}
