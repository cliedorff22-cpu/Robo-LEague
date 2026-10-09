// world.js - builds the Rapier physics world from arena.json.
//
// Rapier is imported HERE and in the other js/sim files only. Logic never sees
// it; rendering only reads transforms back out. Swapping physics engines (or
// porting to Godot's) means rewriting js/sim and nothing else.

import { RAPIER } from "./physics.js";
import { ftToM, degToRad } from "../core/units.js";
import { quatFromYaw, quatFromAxisAngle, quatMul } from "../core/vec.js";

// Collision groups, as Rapier's packed (membership << 16) | filter.
export const GROUP = {
  ARENA:  0x0001,
  ROBOT:  0x0002,
  HAZARD: 0x0004,
};
const groups = (member, collidesWith) => ((member << 16) | collidesWith);

export const ARENA_FILTER  = groups(GROUP.ARENA,  GROUP.ROBOT | GROUP.HAZARD);
export const ROBOT_FILTER  = groups(GROUP.ROBOT,  GROUP.ARENA | GROUP.ROBOT | GROUP.HAZARD);
export const HAZARD_FILTER = groups(GROUP.HAZARD, GROUP.ROBOT | GROUP.ARENA);

// initPhysics lives in physics.js; re-exported here so callers have one import.
export { initPhysics } from "./physics.js";

/**
 * Build the arena: floor, four walls (angled steel kickplate + vertical lexan
 * above it), and a static frame. Hazards are added separately by hazards.js
 * because they move.
 *
 * Returns { world, RAPIER, dims, pieces } where `pieces` describes every static
 * body in metres so the renderer can mirror it without re-deriving geometry.
 */
export function buildArena(arena) {
  const world = new RAPIER.World({ x: 0, y: arena.physics.gravityMps2, z: 0 });
  world.timestep = arena.physics.fixedStepS;

  const [fxFt, fzFt] = arena.floor.size;
  const halfX = ftToM(fxFt) / 2;
  const halfZ = ftToM(fzFt) / 2;
  const floorThick = ftToM(arena.floor.thickness);
  const wallH = ftToM(arena.walls.height);
  const kickH = ftToM(arena.walls.kickplate.height);
  const kickAngle = degToRad(arena.walls.kickplate.angleFromVertical);
  const lexanT = ftToM(arena.walls.lexan.thickness);
  const kickT = 0.05;

  const pieces = [];

  // ---- floor: top surface sits exactly at y = 0, which every other system assumes.
  // A pit layout cuts holes in it: the slab is split into a grid along every
  // pit edge and the cells inside a pit are left out. With no pits that is one
  // cell, the slab it always was.
  const pits = pitRects(arena);
  const floorBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -floorThick / 2, 0)
  );
  const cuts = (lo, hi, edges) => [...new Set([lo, hi, ...edges.filter((e) => e > lo && e < hi)])].sort((a, b) => a - b);
  const xs = cuts(-halfX, halfX, pits.flatMap((p) => [p.cx - p.hw, p.cx + p.hw]));
  const zs = cuts(-halfZ, halfZ, pits.flatMap((p) => [p.cz - p.hl, p.cz + p.hl]));
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const mx = (xs[i] + xs[i + 1]) / 2, mz = (zs[j] + zs[j + 1]) / 2;
      if (pits.some((p) => Math.abs(mx - p.cx) < p.hw && Math.abs(mz - p.cz) < p.hl)) continue;
      world.createCollider(
        RAPIER.ColliderDesc.cuboid((xs[i + 1] - xs[i]) / 2, floorThick / 2, (zs[j + 1] - zs[j]) / 2)
          .setTranslation(mx, 0, mz)
          .setFriction(arena.floor.friction)
          .setRestitution(arena.floor.restitution)
          .setCollisionGroups(ARENA_FILTER),
        floorBody
      );
    }
  }
  // Each pit: steel walls lining the hole down to its floor, and the floor.
  // The sinking deck panel itself is a hazard (hazards.js) because it moves.
  const pitT = 0.15;
  for (const p of pits) {
    const wallY = -p.depth / 2 - 0.05;
    for (const [w, d, x, z] of [
      [p.hw + pitT, pitT / 2, p.cx, p.cz - p.hl - pitT / 2], [p.hw + pitT, pitT / 2, p.cx, p.cz + p.hl + pitT / 2],
      [pitT / 2, p.hl, p.cx - p.hw - pitT / 2, p.cz], [pitT / 2, p.hl, p.cx + p.hw + pitT / 2, p.cz],
    ]) {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, wallY, z));
      world.createCollider(RAPIER.ColliderDesc.cuboid(w, p.depth / 2 + 0.05, d)
        .setFriction(0.4).setRestitution(0.1).setCollisionGroups(ARENA_FILTER), b);
      pieces.push({ kind: "pitWall", hazardId: p.id, size: [w * 2, p.depth + 0.1, d * 2], pos: { x, y: wallY, z }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    }
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.cx, -p.depth - 0.15, p.cz));
    world.createCollider(RAPIER.ColliderDesc.cuboid(p.hw + pitT, 0.1, p.hl + pitT)
      .setFriction(arena.floor.friction).setCollisionGroups(ARENA_FILTER), fb);
  }
  pieces.push({
    kind: "floor", material: arena.floor.material,
    size: [halfX * 2, floorThick, halfZ * 2],
    pos: { x: 0, y: -floorThick / 2, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
  });

  // ---- walls. Built once in a canonical frame for the -Z side, then yawed
  // onto all four sides. The kickplate's bottom edge meets the floor at the
  // wall line and its top leans outward, so a bot shoved into the wall rides
  // up it instead of catching a square edge.
  //
  // Rotating the plate about local X by -kickAngle tips its top toward -Z.
  // Working through where that puts the bottom edge:
  const kickHalf = kickH / 2;
  const kickCosA = Math.cos(kickAngle);
  const kickSinA = Math.sin(kickAngle);
  const kickCenterY = kickHalf * kickCosA;            // bottom edge lands at y = 0
  const kickRun = kickH * kickSinA;                   // how far out the top leans
  const kickTilt = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -kickAngle);

  const lexanBottomY = kickH * kickCosA;
  const lexanHalfH = Math.max(0.01, (wallH - lexanBottomY) / 2);

  const sides = [
    { id: "north", yaw: 0,                half: halfZ, span: halfX },
    { id: "south", yaw: Math.PI,          half: halfZ, span: halfX },
    { id: "west",  yaw: Math.PI / 2,      half: halfX, span: halfZ },
    { id: "east",  yaw: -Math.PI / 2,     half: halfX, span: halfZ },
  ];

  for (const side of sides) {
    const qYaw = quatFromYaw(side.yaw);
    // Canonical positions on the -Z wall, then yawed into place.
    const place = (local) => rotateY(local, side.yaw);

    // Kickplate.
    const kickPos = place({ x: 0, y: kickCenterY, z: -side.half - kickHalf * kickSinA });
    const kickBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(kickPos.x, kickPos.y, kickPos.z)
    );
    const kickQuat = quatMul(qYaw, kickTilt);
    kickBody.setRotation(kickQuat, false);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(side.span, kickHalf, kickT / 2)
        .setFriction(0.4).setRestitution(0.1)
        .setCollisionGroups(ARENA_FILTER),
      kickBody
    );
    pieces.push({
      kind: "kickplate", material: arena.walls.kickplate.material, side: side.id,
      size: [side.span * 2, kickH, kickT], pos: kickPos, quat: kickQuat,
    });

    // Lexan panel above the kickplate, offset out by the kickplate's run.
    const lexPos = place({
      x: 0,
      y: lexanBottomY + lexanHalfH,
      z: -side.half - kickRun - lexanT / 2,
    });
    const lexBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(lexPos.x, lexPos.y, lexPos.z)
    );
    lexBody.setRotation(qYaw, false);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(side.span, lexanHalfH, lexanT / 2)
        .setFriction(arena.walls.friction)
        .setRestitution(arena.walls.restitution)
        .setCollisionGroups(ARENA_FILTER),
      lexBody
    );
    pieces.push({
      kind: "lexan", material: arena.walls.lexan.material, side: side.id,
      size: [side.span * 2, lexanHalfH * 2, lexanT], pos: lexPos, quat: qYaw,
    });

    // A solid backstop behind the lexan, floor to ceiling. The lexan is thin
    // and a fast tumbling bot can tunnel through it; this guarantees the box
    // actually contains the fight no matter what the solver does.
    if (arena.walls.containment?.enabled !== false) {
      const backT = ftToM(arena.walls.containment?.thickness ?? 1.0);
      const backPos = place({ x: 0, y: wallH / 2, z: -side.half - kickRun - lexanT - backT / 2 });
      const backBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(backPos.x, backPos.y, backPos.z)
      );
      backBody.setRotation(qYaw, false);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(side.span + backT, wallH / 2, backT / 2)
          .setFriction(0.3)
          .setRestitution(0.1)
          .setCollisionGroups(ARENA_FILTER),
        backBody
      );
      // Not pushed to `pieces`: it is invisible, and the renderer builds from
      // that list, so adding it there would draw a wall over the lexan.
    }

    // A ceiling-high lip so a flipped bot cannot pop out of the box.
    const lipPos = place({ x: 0, y: wallH, z: -side.half - kickRun - 0.25 });
    const lipBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(lipPos.x, lipPos.y, lipPos.z)
    );
    lipBody.setRotation(qYaw, false);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(side.span, 0.05, 0.25).setCollisionGroups(ARENA_FILTER),
      lipBody
    );
    pieces.push({
      kind: "lip", material: "steel", side: side.id,
      size: [side.span * 2, 0.1, 0.5], pos: lipPos, quat: qYaw,
    });
  }

  // The roof. The real box is closed over the top; this one is too, and
  // invisible (not in `pieces`). Nothing a fight can do should put a robot
  // outside the arena - one did, launched off a pulverizer strike into two
  // robots wedged in a corner, and fell for ever (tools/stress.js).
  const roofT = 0.5;
  const roofBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, wallH + roofT / 2, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(halfX + kickRun + 2, roofT / 2, halfZ + kickRun + 2)
      .setFriction(0.3).setRestitution(0.1).setCollisionGroups(ARENA_FILTER),
    roofBody
  );

  return {
    world,
    RAPIER,
    dims: { halfX, halfZ, wallH, kickH, kickRun, lexanBottomY, floorThick },
    pits,
    pieces,
  };
}

/**
 * The pits in a layout, in metres: centre, half-extents and depth. Pits sit
 * square to the walls (validate.js holds them to it), so a yaw of 90 just
 * swaps the sides.
 */
export function pitRects(arena) {
  return (arena.hazards || []).filter((h) => h.type === "pit" && h.enabled !== false).map((h) => {
    const turned = Math.abs(Math.round((h.yaw || 0) / 90)) % 2 === 1;
    const [w, l] = turned ? [h.size[1], h.size[0]] : h.size;
    return { id: h.id, cx: ftToM(h.pos[0]), cz: ftToM(h.pos[2]), hw: ftToM(w) / 2, hl: ftToM(l) / 2, depth: ftToM(h.depth) };
  });
}

/** Rotate a local offset about the Y axis - used to place the four walls. */
function rotateY(v, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}
