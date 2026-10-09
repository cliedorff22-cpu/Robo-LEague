// arena_view.js - the arena's visuals, mirrored from the physics pieces.
//
// buildArena() in js/sim/world.js returns a `pieces` list describing every
// static body in metres. We build meshes straight from that list, so the
// picture can never drift out of sync with the collision geometry - a class of
// bug that is otherwise very hard to spot.
//
// The one deliberate departure: the floor is DRAWN with a slit cut into it
// for each killsaw, while the physics floor stays a solid slab. The stowed
// blades then sit visibly down in the deck under a cover plate, the way they
// do in the real box, without giving bots a hole to fall into.

import * as THREE from "three";
import { ftToM } from "../core/units.js";

/**
 * Decals painted on the deck. polygonOffset rather than a few millimetres of
 * height: tiny height offsets lose the depth test at the far end of the box
 * and shimmer as the camera moves - that was part of the flicker along the far
 * wall.
 */
function decalMat(params) {
  return new THREE.MeshStandardMaterial({
    roughness: 0.8, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    ...params,
  });
}

/** Corners of an XZ rectangle centred at (cx, cz), yawed. */
function rectCorners(cx, cz, w, l, yaw) {
  // Width runs along local X, length along local Z (the same convention as
  // the hazards), and yaw rotates local into world as quatFromYaw does.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]
    .map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
}

export function buildArenaView(scene, arena, sim, hazards, mats) {
  const group = new THREE.Group();
  group.name = "arena";
  scene.add(group);

  const halfX = ftToM(arena.floor.size[0]) / 2;
  const halfZ = ftToM(arena.floor.size[1]) / 2;
  const wallH = ftToM(arena.walls.height);
  const cutaway = [];               // wall meshes that clear out of an outside camera's way

  // Holes to cut into the drawn deck: { corners, depth }. Only the killsaw
  // slits now - the screws stand up on the deck in their own cradles.
  const pits = [];
  for (const h of hazards.all) {
    if (h.type !== "killsaw") continue;
    const p = h.pieces[0];
    for (const slit of sawSlits(p)) {
      // The slit's centre, from slot-local X into the world.
      const cx = p.pos.x + slit.x * Math.cos(p.yaw), cz = p.pos.z - slit.x * Math.sin(p.yaw);
      pits.push({
        corners: rectCorners(cx, cz, slit.w, slit.l, p.yaw),
        depth: 0.35, w: slit.w, l: slit.l, cx, cz, piece: p,
      });
    }
  }

  // The pits' holes go right through the deck; the hole is lined by the
  // pitWall pieces below and closed by the moving panel.
  for (const r of sim.pits || []) {
    pits.push({
      corners: rectCorners(r.cx, r.cz, r.hw * 2, r.hl * 2, 0),
      depth: 0, w: r.hw * 2, l: r.hl * 2, cx: r.cx, cz: r.cz, pitHole: true,
    });
  }

  // ---- static pieces straight from the physics description
  for (const p of sim.pieces) {
    if (p.kind === "floor") {
      group.add(buildDeck(p, pits, halfX, halfZ, mats));
      continue;
    }
    const geo = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
    const mat = p.kind === "lexan" ? mats.polycarbonate
              : p.kind === "kickplate" ? mats.steel
              : mats.darkSteel;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    mesh.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
    // The wall above the kickplate - lexan and the lip along its top - can be
    // cut away on the camera's side (setViewpoint).
    if (p.side) mesh.userData.wall = { kind: p.kind, sides: [p.side] };
    if (p.side && (p.kind === "lexan" || p.kind === "lip")) cutaway.push(mesh);
    if (p.kind === "lexan") {
      // Drawn after the opaque arena and in a fixed order. Left to the
      // per-frame distance sort, the four panels swap order as the camera
      // moves and the far wall flickers where two panels overlap on screen.
      mesh.renderOrder = 2;
    } else {
      mesh.castShadow = true; mesh.receiveShadow = true;
    }
    group.add(mesh);
  }

  // Pit interiors: an open-topped steel tub under each hole.
  const tubMat = mats.darkSteel.clone();
  tubMat.side = THREE.BackSide;
  for (const pit of pits) {
    if (pit.pitHole) continue;
    // A hair inside the hole, so its walls do not z-fight the deck's cut edges.
    const tub = new THREE.Mesh(new THREE.BoxGeometry(pit.w - 0.02, pit.depth, pit.l - 0.02), tubMat);
    tub.position.set(pit.cx, -pit.depth / 2 - 0.001, pit.cz);
    tub.rotation.y = pit.piece.yaw;
    tub.receiveShadow = true;
    group.add(tub);
  }

  // ---- wall framing: uprights at the panel joints, for a built look
  const sidesAt = (x, z) => [z < -halfZ && "north", z > halfZ && "south", x < -halfX && "west", x > halfX && "east"].filter(Boolean);
  const postGeo = new THREE.BoxGeometry(0.12, wallH, 0.12);
  const postStep = halfX / 2;
  for (let i = -2; i <= 2; i++) {
    for (const [x, z] of [
      [i * postStep, -halfZ - 0.3], [i * postStep, halfZ + 0.3],
      // Not mid-wall on the east and west walls: that is dead on the line
      // from the corner camera and the chase cam at the start to the robots.
      ...(i === 0 ? [] : [[-halfX - 0.3, i * postStep], [halfX + 0.3, i * postStep]]),
    ]) {
      const post = new THREE.Mesh(postGeo, mats.darkSteel);
      post.position.set(x, wallH / 2, z);
      post.castShadow = true;
      // A corner post is on two walls (x is +-halfX exactly at the corners).
      post.userData.wall = { kind: "post", sides: sidesAt(Math.abs(x) >= halfX - 1e-6 ? x * 1.01 : x, z) };
      cutaway.push(post);
      group.add(post);
    }
  }

  // ---- floor markings, after the toy BattleBox and the real deck: a big red
  // and blue starting square on each side and a yellow line around the floor.
  const square = ftToM(8);
  for (const s of arena.spawns) {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(square, square),
      decalMat({ color: s.id === "red" ? 0xb31c22 : 0x1f8fd0, transparent: true, opacity: 0.82 })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(ftToM(s.pos[0]), 0.001, ftToM(s.pos[2]));
    pad.receiveShadow = true;
    group.add(pad);
  }
  const lineIn = ftToM(20.6), lineW = ftToM(0.35);
  const yellow = decalMat({ color: 0xd8b21a });
  for (const [w, l, x, z] of [
    [lineIn * 2 + lineW, lineW, 0, -lineIn], [lineIn * 2 + lineW, lineW, 0, lineIn],
    [lineW, lineIn * 2 - lineW, -lineIn, 0], [lineW, lineIn * 2 - lineW, lineIn, 0],
  ]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, l), yellow);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(x, 0.001, z);
    strip.receiveShadow = true;
    group.add(strip);
  }

  // ---- hazards. Meshes are built from the hazard `pieces` description and
  // their transforms are copied from physics each frame by update().
  const hazardMeshes = new Map();   // "<hazardId>:<part>" -> mesh
  // Up here, not beside buildPit: the hazard loop below runs first (the TDZ trap).
  const pitLamps = [];              // { h, mat } - the pits' warning lamps

  for (const h of hazards.all) {
    // Every type needs an explicit branch. An unknown type once fell through
    // to the swinger code, threw, and took the whole boot down with it - a
    // hazard that cannot be drawn should cost its own mesh and nothing else.
    if (h.type === "screw") buildScrew(h);
    else if (h.type === "killsaw") buildKillsaw(h);
    else if (h.type === "pulverizer" || h.type === "hammer") buildSwinger(h);
    else if (h.type === "pit") buildPit(h);
    else console.warn(`[arena_view] no visuals for hazard "${h.id}" of type "${h.type}"`);
  }

  // ---------------------------------------------------------------- screws
  // A pair of augers - shaft plus a raised helical flight - standing proud of
  // the deck, half-sunk in a steel cradle that runs back to the kickplate.
  function buildScrew(h) {
    const p = h.pieces[0];
    const cradlePiece = h.pieces.find((x) => x.kind === "screwCradle");
    const shaftR = p.radius * 0.42;
    for (const a of p.augers) {
      const auger = new THREE.Group();
      // Rapier and Three both run cylinders along local Y; the body's own
      // quaternion lays it down and spins it, so nothing is tilted here.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, p.length, 20), mats.darkSteel);
      shaft.castShadow = true;
      auger.add(shaft);
      const flight = new THREE.Mesh(
        helicoidGeometry(shaftR * 0.9, p.radius, p.length * 0.97, p.radius * 1.5, a.hand),
        mats.augerFlight
      );
      flight.castShadow = true;
      auger.add(flight);
      // Shaft ends.
      for (const end of [-1, 1]) {
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(shaftR * 1.5, shaftR * 1.5, 0.05, 16), mats.steel);
        collar.position.y = end * (p.length / 2 - 0.02);
        auger.add(collar);
      }
      group.add(auger);
      hazardMeshes.set(`${h.id}:${a.part}`, auger);
    }
    if (!cradlePiece) return;

    // The cradle, straight from its physics box. Built in the unit's own
    // frame: X across (toward the wall is p.toWall), Z along the wall.
    const [cw, ch, cl] = cradlePiece.size;
    const unit = new THREE.Group();
    unit.position.set(cradlePiece.pos.x, 0, cradlePiece.pos.z);
    unit.rotation.y = cradlePiece.yaw;
    const body = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, cl), mats.darkSteel);
    body.position.y = ch / 2;
    body.castShadow = true; body.receiveShadow = true;
    unit.add(body);
    // Hazard-striped face on the arena side, and a striped cap along its top
    // edge, so it reads as a hazard from anywhere in the box.
    const faceX = -p.toWall * (cw / 2 + 0.006);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.012, ch * 0.92, cl * 0.995), mats.hazardStripe);
    face.position.set(faceX, ch * 0.5, 0);
    face.receiveShadow = true;
    unit.add(face);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, cl), mats.steel);
    lip.position.set(-p.toWall * (cw / 2 - 0.03), ch + 0.015, 0);
    lip.castShadow = true;
    unit.add(lip);
    // Bearing blocks the shafts turn in, at each end - solid in physics too.
    const eb = cradlePiece.endBlock;
    for (const end of [-1, 1]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(cw, eb.height, eb.depth), mats.steel);
      block.position.set(0, ch + eb.height / 2, end * eb.offset);
      block.castShadow = true; block.receiveShadow = true;
      unit.add(block);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(cw * 1.01, 0.05, eb.depth * 1.02), mats.hazardStripe);
      cap.position.set(0, ch + eb.height - 0.025, end * eb.offset);
      unit.add(cap);
    }
    group.add(unit);
  }

  // ---------------------------------------------------------------- pulverizers
  // A steel pedestal rising off the deck in the corner, cheek plates carrying
  // the hinge, and a sledgehammer arm that stands up and slams forward.
  function buildSwinger(h) {
    const armPiece = h.pieces.find((p) => p.kind === "swingerArm");
    const headPiece = h.pieces.find((p) => p.kind === "swingerHead");
    const pivotPiece = h.pieces.find((p) => p.kind === "swingerPivot");
    const basePiece = h.pieces.find((p) => p.kind === "swingerBase");
    if (!armPiece || !headPiece || !pivotPiece || !basePiece) {
      console.warn(`[arena_view] hazard "${h.id}" is missing swinger pieces; drawing nothing for it`);
      return;
    }

    const mount = new THREE.Group();
    mount.position.set(pivotPiece.pos.x, 0, pivotPiece.pos.z);
    mount.quaternion.set(pivotPiece.quat.x, pivotPiece.quat.y, pivotPiece.quat.z, pivotPiece.quat.w);
    const pivotY = pivotPiece.pos.y;
    const [bw, bh, bd] = basePiece.size;

    // Deck plate the whole unit is bolted to.
    const plate = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.5, 0.04, bd * 1.9), mats.steel);
    plate.position.set(0, 0.02, -bd * 0.25);
    plate.receiveShadow = true;
    mount.add(plate);

    // Pedestal, with a hazard band round its top edge.
    const ped = new THREE.Mesh(new THREE.BoxGeometry(bw, bh * 0.82, bd), mats.darkSteel);
    ped.position.y = bh * 0.41;
    ped.castShadow = true; ped.receiveShadow = true;
    mount.add(ped);
    const band = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.01, bh * 0.18, bd * 1.01), mats.hazardStripe);
    band.position.y = bh * 0.91;
    band.castShadow = true;
    mount.add(band);

    // Cheek plates either side of the arm, up past the hinge.
    const armW = armPiece.thickness[0];
    const cheekH = pivotY - bh + 0.22;
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.07, cheekH, bd * 0.7), mats.steel);
      cheek.position.set(side * (armW / 2 + 0.06), bh + cheekH / 2 - 0.01, 0);
      cheek.castShadow = true;
      mount.add(cheek);
    }
    // The hinge pin through all of it.
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, armW + 0.34, 16), mats.steel);
    pin.rotation.z = Math.PI / 2;
    pin.position.y = pivotY;
    mount.add(pin);
    // Actuator housing behind the hinge, toward the corner.
    const ram = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, bh * 0.9, 16), mats.steel);
    ram.rotation.x = Math.PI / 2 - 0.5;
    ram.position.set(0, bh * 0.75, -bd * 0.55);
    ram.castShadow = true;
    mount.add(ram);
    group.add(mount);

    // ---- the moving part: arm + head, posed from physics every frame.
    const assembly = new THREE.Group();
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armPiece.thickness[0], armPiece.length, armPiece.thickness[1]),
      mats.darkSteel
    );
    arm.position.y = -armPiece.length / 2;
    arm.castShadow = true;
    assembly.add(arm);

    // Head: steel block, hazard stripes on its flanks, a thicker striking plate
    // on the face that hits the floor (local -Z).
    const [hw, hl, hd] = headPiece.size;
    const faces = [mats.hazardStripe, mats.hazardStripe, mats.steel, mats.steel, mats.steel, mats.steel];
    const head = new THREE.Mesh(new THREE.BoxGeometry(hw, hl, hd), faces);
    head.position.set(headPiece.local.x, headPiece.local.y, headPiece.local.z);
    head.castShadow = true;
    assembly.add(head);
    const face = new THREE.Mesh(new THREE.BoxGeometry(hw * 1.06, hl * 1.06, 0.06), mats.steel);
    face.position.set(headPiece.local.x, headPiece.local.y, headPiece.local.z - hd / 2 + 0.025);
    face.castShadow = true;
    assembly.add(face);

    group.add(assembly);
    hazardMeshes.set(`${h.id}:arm`, assembly);
  }

  // ---------------------------------------------------------------- pit
  // A hazard-striped frame round the hole, a ring of warning lamps that flash
  // before it drops, and the deck panel itself, posed from physics.
  function buildPit(h) {
    const p = h.pieces[0];
    const rim = 0.2;
    const frame = new THREE.Group();
    frame.position.set(p.pos.x, 0, p.pos.z);
    for (const [w, l, x, z] of [
      [p.hw * 2 + rim * 2, rim, 0, -p.hl - rim / 2], [p.hw * 2 + rim * 2, rim, 0, p.hl + rim / 2],
      [rim, p.hl * 2, -p.hw - rim / 2, 0], [rim, p.hl * 2, p.hw + rim / 2, 0],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, l), mats.hazardStripe);
      bar.receiveShadow = true;
      bar.position.set(x, 0, z);
      frame.add(bar);
    }
    // Lamps: little domes along each edge of the frame.
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x401010, emissive: 0xff3020, emissiveIntensity: 0, roughness: 0.4 });
    const lampGeo = new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const per = 4;
    for (let i = 0; i < per; i++) {
      const f = (i + 0.5) / per - 0.5;
      for (const [x, z] of [[f * p.hw * 2, -p.hl - rim / 2], [f * p.hw * 2, p.hl + rim / 2], [-p.hw - rim / 2, f * p.hl * 2], [p.hw + rim / 2, f * p.hl * 2]]) {
        const lamp = new THREE.Mesh(lampGeo, lampMat);
        lamp.position.set(x, 0.006, z);
        frame.add(lamp);
      }
    }
    pitLamps.push({ h, mat: lampMat });
    group.add(frame);

    // The panel: deck steel with a striped border, so it reads as a trapdoor.
    const lid = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(p.hw * 2 - 0.01, p.lidT, p.hl * 2 - 0.01), mats.steelFloor);
    slab.receiveShadow = true;
    lid.add(slab);
    const band = 0.12;
    for (const [w, l, x, z] of [
      [p.hw * 2 - 0.01, band, 0, -p.hl + band / 2], [p.hw * 2 - 0.01, band, 0, p.hl - band / 2],
      [band, p.hl * 2 - band * 2, -p.hw + band / 2, 0], [band, p.hl * 2 - band * 2, p.hw - band / 2, 0],
    ]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(w, l), decalMat({ color: 0xd8b21a }));
      b.rotation.x = -Math.PI / 2;
      b.position.set(x, p.lidT / 2 + 0.001, z);
      lid.add(b);
    }
    group.add(lid);
    hazardMeshes.set(`${h.id}:lid`, lid);
  }

  // ---------------------------------------------------------------- killsaws
  // A hazard-striped cover plate let into the deck, with a narrow slit down
  // the middle that the blades rise through.
  // Function declarations hoist but these do not, and the hazard loop above
  // runs first - so they live inside (the TDZ trap from the boot bugs list).
  function buildKillsaw(h) {
    const coverMat = decalMat({ color: 0x3a3d42, roughness: 0.55, metalness: 0.35 });
    const boltGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.006, 8);
    const piece = h.pieces[0];
    const slotL = piece.slotLength;
    const slotW = sawCoverWidth(piece);

    const slot = new THREE.Group();
    slot.position.set(piece.pos.x, 0, piece.pos.z);
    slot.rotation.y = piece.yaw;

    // The cover: a plate the size of the slot, with a slit cut for each blade.
    // Shape space is (x, -z) once it is tipped flat, as in buildDeck.
    const plate = new THREE.Shape();
    plate.moveTo(-slotW / 2, -slotL / 2); plate.lineTo(slotW / 2, -slotL / 2);
    plate.lineTo(slotW / 2, slotL / 2); plate.lineTo(-slotW / 2, slotL / 2);
    plate.closePath();
    for (const slit of sawSlits(piece)) {
      const x0 = slit.x - slit.w / 2, x1 = slit.x + slit.w / 2;
      const hole = new THREE.Path();
      hole.moveTo(x0, -slit.l / 2); hole.lineTo(x1, -slit.l / 2);
      hole.lineTo(x1, slit.l / 2); hole.lineTo(x0, slit.l / 2);
      hole.closePath();
      plate.holes.push(hole);
    }
    const cover = new THREE.Mesh(new THREE.ShapeGeometry(plate), coverMat);
    cover.rotation.x = -Math.PI / 2;
    cover.position.y = 0.001;
    cover.receiveShadow = true;
    slot.add(cover);
    // Countersunk bolts round the plate.
    for (const [bx, bz] of [
      [-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0],
    ]) {
      const bolt = new THREE.Mesh(boltGeo, mats.steel);
      bolt.position.set(bx * (slotW / 2 - 0.05), 0.003, bz * (slotL / 2 - 0.05));
      slot.add(bolt);
    }
    // Hazard-striped border, exactly as the real box marks its saw slots.
    const rim = 0.17;
    for (const [w, l, x, z] of [
      [rim, slotL + rim * 2, -(slotW + rim) / 2, 0], [rim, slotL + rim * 2, (slotW + rim) / 2, 0],
      [slotW, rim, 0, -(slotL + rim) / 2], [slotW, rim, 0, (slotL + rim) / 2],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, l), mats.hazardStripe);
      bar.position.set(x, 0.0, z);
      bar.receiveShadow = true;
      slot.add(bar);
    }
    group.add(slot);

    // Blade assembly, positioned from physics each frame.
    const blades = new THREE.Group();
    const bladeGeo = new THREE.CylinderGeometry(piece.bladeRadius, piece.bladeRadius, piece.bladeThickness, 28);
    for (let i = 0; i < piece.bladeCount; i++) {
      const offset = (i - (piece.bladeCount - 1) / 2) * piece.bladeSpacing;
      const blade = new THREE.Mesh(bladeGeo, mats.sawBlade);
      // Side by side on the lateral axle (local X), as in physics.
      blade.rotation.z = Math.PI / 2;
      blade.position.x = offset;
      blade.castShadow = true;
      blades.add(blade);
    }
    group.add(blades);
    hazardMeshes.set(`${h.id}:blades`, blades);
  }

  // ---- perimeter spike strips. Static furniture, but they are a big part of
  // what makes the box look like the box. Kept clear of the corners (the
  // pulverizers) and of the screw cradles.
  const spikeCfg = arena.spikeStrips;
  if (spikeCfg && spikeCfg.enabled !== false) {
    const sh = ftToM(spikeCfg.spikeHeight);
    const sw = ftToM(spikeCfg.spikeWidth);
    const step = ftToM(spikeCfg.spacingFt);
    const inset = ftToM(spikeCfg.inset);
    const spikeGeo = new THREE.ConeGeometry(sw / 2, sh, 4);
    const cradles = hazards.all.flatMap((h) => h.pieces.filter((p) => p.kind === "screwCradle"));
    const nearScrew = (x, z) => cradles.some((p) => {
      const dx = x - p.pos.x, dz = z - p.pos.z;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const along = Math.abs(dx * s + dz * c), across = Math.abs(dx * c - dz * s);
      return along < p.size[2] / 2 + 0.5 && across < p.size[0] / 2 + 0.8;
    });

    const runs = [
      { count: Math.floor((halfX * 2 - 4) / step), axis: "x", at: -halfZ + inset },
      { count: Math.floor((halfX * 2 - 4) / step), axis: "x", at: halfZ - inset },
      { count: Math.floor((halfZ * 2 - 4) / step), axis: "z", at: -halfX + inset },
      { count: Math.floor((halfZ * 2 - 4) / step), axis: "z", at: halfX - inset },
    ];
    for (const run of runs) {
      const span = (run.count - 1) * step;
      for (let i = 0; i < run.count; i++) {
        const along = -span / 2 + i * step;
        if (Math.abs(along) > (run.axis === "x" ? halfX : halfZ) - 2.2) continue;
        const [x, z] = run.axis === "x" ? [along, run.at] : [run.at, along];
        if (nearScrew(x, z)) continue;
        const spike = new THREE.Mesh(spikeGeo, mats.steel);
        spike.position.set(x, sh / 2, z);
        // Lean them inward, like the real strips.
        spike.rotation.x = run.axis === "x" ? (run.at < 0 ? -0.35 : 0.35) : 0;
        spike.rotation.z = run.axis === "z" ? (run.at < 0 ? 0.35 : -0.35) : 0;
        spike.castShadow = true;
        group.add(spike);
      }
    }
  }

  // ---- the near-wall cutaway. A camera outside the box looks through the
  // wall on its own side: the lip along the top and the uprights cut across
  // the floor, and the lexan's scuffs and glare wash it out (tools/camcheck.sh
  // measured the corner cam seeing none of the floor clearly). So the walls a
  // camera is behind clear out of its way: lexan hidden, framing down to a
  // ghost of itself. The kickplate stays - it is below the robots.
  const ghosts = new Map();         // material -> its see-through twin
  const ghostOf = (m) => {
    if (!ghosts.has(m)) {
      const g = m.clone();
      Object.assign(g, { transparent: true, opacity: 0.12, depthWrite: false });
      ghosts.set(m, g);
    }
    return ghosts.get(m);
  };
  for (const m of cutaway) m.userData.solid = m.material;
  let cutKey = "";

  let lampT = 0;
  return {
    group,
    /**
     * Where the camera is this frame: walls between it and the box get out of
     * the way. Call once per frame after the camera moves.
     */
    setViewpoint(pos) {
      const m = 0.25;
      const cut = { north: pos.z < -halfZ - m, south: pos.z > halfZ + m, west: pos.x < -halfX - m, east: pos.x > halfX + m };
      // Over the top of the walls looking down (the overhead cam) nothing is in the way.
      const key = Object.keys(cut).filter((k) => cut[k]).join();
      if (key === cutKey) return;
      cutKey = key;
      for (const mesh of cutaway) {
        const away = mesh.userData.wall.sides.some((sd) => cut[sd]);
        if (mesh.userData.wall.kind === "lexan") mesh.visible = !away;
        else mesh.material = away ? ghostOf(mesh.userData.solid) : mesh.userData.solid;
      }
    },
    /** The walls cut away right now, for the checks: ["south", "east"]. */
    get cutaway() { return cutKey ? cutKey.split(",") : []; },
    /** Copy live hazard transforms out of physics. Call once per frame. */
    update(dt = 1 / 60) {
      lampT += dt;
      // Pit lamps: flash as it is about to go, burn steady once it is open.
      for (const { h, mat } of pitLamps) {
        mat.emissiveIntensity = h.travel > 0 ? 2.4 : h.warning > 0 ? (Math.sin(lampT * 14) > 0 ? 3 : 0.2) : 0;
      }
      for (const t of hazards.transforms()) {
        const mesh = hazardMeshes.get(`${t.hazardId}:${t.part}`);
        if (!mesh) continue;
        mesh.position.set(t.pos.x, t.pos.y, t.pos.z);
        mesh.quaternion.set(t.quat.x, t.quat.y, t.quat.z, t.quat.w);
      }
    },
  };
}

/** Width of a killsaw's cover plate (and its hazard-striped frame). */
function sawCoverWidth(p) {
  return p.bladeSpacing * (p.bladeCount - 1) + p.bladeThickness * 6 + 0.12;
}

/**
 * The slits in a killsaw's cover, one per blade, in slot-local X. Each has to
 * be as long as the widest chord its blade cuts through the deck, which is at
 * full height.
 */
function sawSlits(p) {
  const r = p.bladeRadius;
  const up = Math.min(p.deployedHeight ?? r, r);
  const chordHalf = Math.sqrt(Math.max(0, r * r - (r - up) * (r - up)));
  const out = [];
  for (let i = 0; i < p.bladeCount; i++) {
    out.push({
      x: (i - (p.bladeCount - 1) / 2) * p.bladeSpacing,
      w: p.bladeThickness + 0.04,
      l: Math.min(p.slotLength - 0.08, chordHalf * 2 + 0.06),
    });
  }
  return out;
}

/**
 * The drawn deck: the floor slab from physics, extruded from a shape with a
 * hole for every pit. UVs are remapped to 0..1 across the deck so the floor
 * texture tiles exactly as it did on the old box.
 */
function buildDeck(p, pits, halfX, halfZ, mats) {
  const shape = new THREE.Shape();
  // Shape space is (x, -z): ExtrudeGeometry builds in XY and we tip it flat.
  shape.moveTo(-halfX, -halfZ);
  shape.lineTo(halfX, -halfZ);
  shape.lineTo(halfX, halfZ);
  shape.lineTo(-halfX, halfZ);
  shape.closePath();
  for (const pit of pits) {
    const hole = new THREE.Path();
    const pts = pit.corners.map(([x, z]) => [x, -z]);
    hole.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) hole.lineTo(pts[i][0], pts[i][1]);
    hole.closePath();
    shape.holes.push(hole);
  }
  const thick = p.size[1];
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 1 });
  // Tip flat: shape XY -> world X(-Z), extrusion +Z -> world +Y. Then drop it
  // so the top face sits exactly at y = 0, as the physics floor does.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -thick, 0);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) + halfX) / (halfX * 2), (uv.getY(i) + halfZ) / (halfZ * 2));
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.steelFloor);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A helical auger flight: a ribbon wound round the shaft from rInner to rOuter,
 * running along local Y. `hand` is +1/-1 for right/left-handed.
 */
function helicoidGeometry(rInner, rOuter, length, pitch, hand = 1) {
  const turns = length / pitch;
  const segs = Math.max(24, Math.round(turns * 28));
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const y = -length / 2 + u * length;
    const a = hand * u * turns * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pos.push(c * rInner, y, s * rInner, c * rOuter, y, s * rOuter);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
