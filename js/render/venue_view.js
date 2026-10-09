// venue_view.js - the building round the box: stands, the crowd, the lighting
// rig, screens, banners and each venue's own furniture (data/arenas.json).
//
// Pure decoration. Nothing here has physics and nothing reads the sim except
// through the bus, which it listens to so the crowd can react: big hits, the
// count, a knockout, the bell. One venue per league and one for the Giant Nut.
//
// Kept out of the cameras' way on purpose: everything over the box hangs
// above the overhead camera (52 ft), the stands start beyond the fixed
// cameras, and the hall is drawn from the inside only (BackSide), so a
// camera that ends up above the roof looks straight through it.

import * as THREE from "three";
import { ftToM } from "../core/units.js";
import { EV } from "../core/bus.js";
import { makeRng, hashSeed } from "../core/rng.js";

const OVERHEAD_CLEAR_M = ftToM(56);   // nothing over the box below this
const SEAT_PITCH_M = 0.62;            // one fan per this much row

// Sides of the box: the stands are built for the south (+Z) side and turned.
const SIDES = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 };

/**
 * @param venue   a venue from data/arenas.json
 * @param arena   the composed arena (js/logic/arenas.js)
 * @param opts.bus     the match bus, for crowd reactions (optional)
 * @param opts.names   { red, blue } robot names for the screens
 * @param opts.seed    decoration seed (crowd layout)
 */
export function buildVenueView(scene, venue, arena, { bus = null, names = {}, seed = 1 } = {}) {
  const group = new THREE.Group();
  group.name = "venue";
  scene.add(group);
  const rng = makeRng(hashSeed(`venue:${venue.name}:${seed}`));
  const disposers = [];

  const halfX = ftToM(arena.floor.size[0]) / 2;
  const halfZ = ftToM(arena.floor.size[1]) / 2;
  const deckBottom = -ftToM(arena.floor.thickness);
  const hall = venue.hall;
  const hx = ftToM(hall.half[0]), hz = ftToM(hall.half[1]), hh = ftToM(hall.height);
  const col = (c, fallback = "#808080") => new THREE.Color(c || fallback);
  const accent = col(venue.accent, "#ffffff");

  // ---------------------------------------------------------------- the hall
  const selfLit = (c, k = 0.1) => ({ emissive: col(c), emissiveIntensity: k });
  const hallMat = new THREE.MeshStandardMaterial({ color: col(hall.wall), roughness: 0.92, metalness: 0.05, side: THREE.BackSide, ...selfLit(hall.wall, 0.12) });
  const roofMat = new THREE.MeshStandardMaterial({ color: col(hall.roof), roughness: 0.95, side: THREE.BackSide });
  // Walls: an open-topped box seen from inside; the roof is a separate plane
  // (its underside only), so from above the hall is see-through.
  const walls = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hh, hz * 2), [hallMat, hallMat, roofMat, hallMat, hallMat, hallMat]);
  walls.geometry.groups = walls.geometry.groups.filter((g) => g.materialIndex !== 3);   // no floor face
  walls.position.y = deckBottom + hh / 2;
  group.add(walls);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2), new THREE.MeshStandardMaterial({ color: col(hall.floor), roughness: 0.85, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = deckBottom - 0.005;
  floor.receiveShadow = true;
  group.add(floor);
  // The walkway round the box, a shade lighter, with a painted safety line.
  const walk = new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2 + 5, halfZ * 2 + 5),
    new THREE.MeshStandardMaterial({ color: col(hall.floor).multiplyScalar(1.5), roughness: 0.8 }));
  walk.rotation.x = -Math.PI / 2;
  walk.position.y = deckBottom;
  walk.receiveShadow = true;
  group.add(walk);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xd8b21a, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [w, l, x, z] of [
    [halfX * 2 + 5, 0.12, 0, -halfZ - 2.5], [halfX * 2 + 5, 0.12, 0, halfZ + 2.5],
    [0.12, halfZ * 2 + 5, -halfX - 2.5, 0], [0.12, halfZ * 2 + 5, halfX + 2.5, 0],
  ]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, deckBottom + 0.002, z);
    group.add(line);
  }

  // ---------------------------------------------------------------- stands
  // Each side is one extruded stepped profile per tier, coloured by face:
  // seat colour on the treads, the stand colour on the risers.
  const st = venue.stands;
  const standMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05, ...selfLit(st.color, 0.12) });
  const standCol = col(st.color), seatCol = col(st.seat);
  const rowD = ftToM(st.rowDepth), rise = ftToM(st.rowRise);
  const length = ftToM(st.length);
  const seats = [];          // { side, x, y, z } in the side's frame (south: +Z outward)
  const tiers = [];          // { u0, u1, v0, v1 } per tier, shared by every side
  const barrierH = 1.1;
  {
    let prevEnd = 0, prevTop = 0;
    st.tiers.forEach((t, k) => {
      const u0 = k === 0 ? halfZ + ftToM(st.gap) : prevEnd - ftToM(t.back ?? 0);
      const v0 = k === 0 ? deckBottom + barrierH : prevTop + ftToM(t.lift ?? 8);
      const u1 = u0 + t.rows * rowD;
      const v1 = v0 + (t.rows - 1) * rise;
      tiers.push({ u0, u1, v0, v1, rows: t.rows, under: k === 0 ? deckBottom : v0 - 1.4 });
      prevEnd = u1; prevTop = v1;
    });
  }
  const standGeos = tiers.map((t) => {
    // Profile in (outward, up); the shape is extruded along the side.
    const s = new THREE.Shape();
    s.moveTo(t.u0, t.under);
    s.lineTo(t.u0, t.v0 + 0.25);                 // the front wall, a little above the first tread
    s.lineTo(t.u0 + 0.12, t.v0 + 0.25);
    s.lineTo(t.u0 + 0.12, t.v0);
    for (let i = 0; i < t.rows; i++) {
      const v = t.v0 + i * rise;
      s.lineTo(t.u0 + (i + 1) * rowD, v);
      if (i < t.rows - 1) s.lineTo(t.u0 + (i + 1) * rowD, v + rise);
    }
    s.lineTo(t.u1, t.under);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(-Math.PI / 2);                      // shape X -> outward (+Z), extrusion -> along (-X)
    g.translate(length / 2, 0, 0);
    paintByNormal(g, (n) => (n.y > 0.7 ? seatCol : standCol));
    return g;
  });
  for (const side of st.sides) {
    const yaw = SIDES[side];
    if (yaw === undefined) continue;
    // A stand along an X side (e/w) reaches out from halfX, not halfZ.
    const off = side === "e" || side === "w" ? halfX - halfZ : 0;
    for (const g of standGeos) {
      const m = new THREE.Mesh(g, standMat);
      m.rotation.y = yaw;
      m.position.set(Math.sin(yaw) * off, 0, Math.cos(yaw) * off);
      group.add(m);
    }
    // A back wall behind the top tier, up to the roof line - banners hang off it.
    const top = tiers[tiers.length - 1];
    const back = new THREE.Mesh(new THREE.BoxGeometry(length + 2, top.v1 + 3 - deckBottom, 0.4), new THREE.MeshStandardMaterial({ color: col(hall.wall).multiplyScalar(0.8), roughness: 0.9 }));
    back.position.set(0, (top.v1 + 3 + deckBottom) / 2, top.u1 + 0.3 + off);
    const backGroup = new THREE.Group();
    backGroup.rotation.y = yaw;
    backGroup.add(back);
    group.add(backGroup);
    // Seats for the crowd.
    for (const t of tiers) {
      for (let i = 0; i < t.rows; i++) {
        const z = t.u0 + i * rowD + rowD * 0.55 + off;
        const y = t.v0 + i * rise;
        for (let x = -length / 2 + 0.5; x <= length / 2 - 0.5; x += SEAT_PITCH_M) {
          if (rng.next() > (venue.crowd?.fill ?? 0.8)) continue;
          seats.push({ yaw, x: x + rng.float(-0.08, 0.08), y, z });
        }
      }
    }
  }
  // Front barriers: a padded wall along the front of every tier, the LED
  // ribbon where the venue has one.
  const ribbonMats = [];
  for (const side of st.sides) {
    const yaw = SIDES[side];
    if (yaw === undefined) continue;
    const off = side === "e" || side === "w" ? halfX - halfZ : 0;
    const g = new THREE.Group();
    g.rotation.y = yaw;
    tiers.forEach((t, k) => {
      if (k === 0 || venue.extras?.includes("ledRibbon")) {
        const lit = venue.extras?.includes("ledRibbon");
        const mat = lit
          ? new THREE.MeshStandardMaterial({ color: 0x111111, emissive: accent, emissiveIntensity: 1.4, roughness: 0.4 })
          : new THREE.MeshStandardMaterial({ color: col(venue.banners?.[0], "#333333"), roughness: 0.7 });
        if (lit) ribbonMats.push(mat);
        const h = 0.5;
        const ribbon = new THREE.Mesh(new THREE.BoxGeometry(length, h, 0.06), mat);
        ribbon.position.set(0, t.v0 + 0.25 - h / 2 + 0.02, t.u0 - 0.04 + off);
        g.add(ribbon);
      }
    });
    group.add(g);
  }

  // ---------------------------------------------------------------- crowd
  // Two instanced meshes - shirts (with arms) and heads - animated entirely on
  // the GPU: each fan has a phase and an excitability, and one shared
  // `excite` level makes them bob, jump and put their arms up.
  const glow = venue.crowd?.glow ?? 0.14;
  const crowdU = { uTime: { value: 0 }, uExcite: { value: venue.crowd?.energy ?? 0.4 }, uGlow: { value: glow } };
  const palette = (venue.crowd?.palette || ["#888888"]).map((c) => new THREE.Color(c));
  const skins = ["#f1c6a4", "#d9a07a", "#b77a52", "#8a5634", "#5e3a22", "#f5d7bd"].map((c) => new THREE.Color(c));
  const crowd = new THREE.Group();
  crowd.name = "crowd";
  if (seats.length) {
    const body = personGeometry();
    const head = new THREE.SphereGeometry(0.115, 9, 7);
    head.translate(0, 1.14, 0);
    const bodyMat = crowdMaterial(crowdU, true);
    const headMat = crowdMaterial(crowdU, false);
    const bodies = new THREE.InstancedMesh(body, bodyMat, seats.length);
    const heads = new THREE.InstancedMesh(head, headMat, seats.length);
    const phase = new Float32Array(seats.length), gain = new Float32Array(seats.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), yAxis = new THREE.Vector3(0, 1, 0);
    seats.forEach((s, i) => {
      // Into the world: the side's yaw, then the seat; fans face the box (-Z
      // in the side's frame) give or take a glance.
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      p.set(s.x * c + s.z * sn, s.y, -s.x * sn + s.z * c);
      q.setFromAxisAngle(yAxis, s.yaw + Math.PI + rng.float(-0.35, 0.35));
      const k = rng.float(0.92, 1.08);
      sc.set(k, k, k);
      m.compose(p, q, sc);
      bodies.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      bodies.setColorAt(i, palette[rng.int(0, palette.length - 1)]);
      heads.setColorAt(i, skins[rng.int(0, skins.length - 1)]);
      phase[i] = rng.float(0, Math.PI * 2);
      gain[i] = rng.float(0.55, 1.25);
    });
    for (const mesh of [bodies, heads]) {
      mesh.geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
      mesh.geometry.setAttribute("aGain", new THREE.InstancedBufferAttribute(gain, 1));
      mesh.frustumCulled = false;     // the instances span the whole hall
      crowd.add(mesh);
    }
  }
  group.add(crowd);

  // ---------------------------------------------------------------- lighting rig
  // A square truss round the box at the height of the arena's own rigs, lamp
  // heads aimed in, and (in the bigger venues) beams that sweep and flash.
  const L = venue.lights || {};
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: col(L.color, "#ffffff"), emissiveIntensity: 2.2, roughness: 0.3 });
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.6, roughness: 0.5 });
  const beams = [];
  const trussY = ftToM(27);
  const ring = Math.max(halfX, halfZ) + ftToM(5);
  if (L.kind === "fluorescent") {
    // Warehouse tubes hung in rows over the stands and walkways - never over the box.
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: col(L.color), emissiveIntensity: 2.0 });
    const tubeY = Math.min(hh - 1, ftToM(24));
    for (let r = 0; r < (L.rows || 4); r++) {
      const z = (r - ((L.rows || 4) - 1) / 2) * (hz * 1.6 / Math.max(1, (L.rows || 4) - 1));
      for (let x = -hx + 4; x <= hx - 4; x += 4.2) {
        if (Math.abs(x) < halfX + 2.5 && Math.abs(z) < halfZ + 2.5) continue;
        const fit = new THREE.Group();
        const housing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.3), trussMat);
        const tube = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 0.12), tubeMat);
        tube.position.y = -0.06;
        fit.add(housing, tube);
        fit.position.set(x, tubeY, z);
        group.add(fit);
        // Hanging wires.
        for (const dx of [-1.1, 1.1]) {
          const wire = new THREE.Mesh(new THREE.BoxGeometry(0.01, hh - tubeY, 0.01), trussMat);
          wire.position.set(x + dx, tubeY + (hh - tubeY) / 2, z);
          group.add(wire);
        }
      }
    }
  } else {
    for (const [w, l, x, z] of [
      [ring * 2, 0.35, 0, -ring], [ring * 2, 0.35, 0, ring], [0.35, ring * 2, -ring, 0], [0.35, ring * 2, ring, 0],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.35, l), trussMat);
      bar.position.set(x, trussY, z);
      group.add(bar);
    }
    // Chains up to the roof at the corners.
    for (const [x, z] of [[-ring, -ring], [ring, -ring], [-ring, ring], [ring, ring]]) {
      const chain = new THREE.Mesh(new THREE.BoxGeometry(0.05, hh - trussY, 0.05), trussMat);
      chain.position.set(x, trussY + (hh - trussY) / 2, z);
      group.add(chain);
    }
    const perSide = Math.max(2, (L.rows || 3) + 1);
    const beamColors = (L.beamColors || [L.color || "#ffffff"]).map((c) => new THREE.Color(c));
    let bi = 0;
    for (const [ax, az, nx, nz] of [[1, 0, 0, -1], [1, 0, 0, 1], [0, 1, -1, 0], [0, 1, 1, 0]]) {
      for (let i = 0; i < perSide; i++) {
        const f = (i + 0.5) / perSide - 0.5;
        const x = ax * f * ring * 2 + nx * ring, z = az * f * ring * 2 + nz * ring;
        const lamp = new THREE.Group();
        lamp.position.set(x, trussY - 0.35, z);
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 12), trussMat);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.2, 14), lampMat);
        lens.position.y = -0.26;
        lens.rotation.x = Math.PI / 2;
        lamp.add(can, lens);
        // Tip toward the middle of the box.
        lamp.lookAt(0, -trussY * 3, 0);
        lamp.rotateX(Math.PI / 2);
        group.add(lamp);
        if (L.beams && (bi++ % 2 === 0)) {
          // Beams sweep the crowd, not the box: nothing gets between the
          // cameras and the fight.
          const c = beamColors[beams.length % beamColors.length];
          const beam = makeBeam(c, trussY);
          beam.position.set(x, trussY - 0.6, z);
          group.add(beam);
          beams.push({ beam, out: { x: nx, z: nz }, along: { x: ax, z: az }, at: f, phase: rng.float(0, Math.PI * 2), color: c });
        }
      }
    }
  }

  // ---------------------------------------------------------------- screens
  // Drawn on a canvas: the venue, both robots and the clock. Redrawn only
  // when the clock ticks over.
  const board = makeBoard(venue, names, accent);
  const sc = venue.screens || {};
  const screenFrame = new THREE.MeshStandardMaterial({ color: 0x111215, metalness: 0.5, roughness: 0.5 });
  const addScreen = (w, h, x, y, z, yaw) => {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.3), screenFrame);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), board.material);
    face.position.z = 0.16;
    g.add(frame, face);
    g.position.set(x, y, z);
    g.rotation.y = yaw;
    group.add(g);
    return g;
  };
  if (sc.kind === "scoreboard") {
    const w = 7, h = 3.5;
    addScreen(w, h, 0, Math.min(hh - h, deckBottom + tiers[tiers.length - 1].v1 + 4.2), -hz + 0.6, 0);
  }
  if (sc.kind === "ends" || sc.ends) {
    const w = 12, h = 6;
    const y = Math.max(deckBottom + tiers[tiers.length - 1].v1 + 4.5, ftToM(20));
    addScreen(w, h, -hx + 0.6, Math.min(y, hh - h / 2 - 1), 0, Math.PI / 2);
    addScreen(w, h, hx - 0.6, Math.min(y, hh - h / 2 - 1), 0, -Math.PI / 2);
  }
  let cube = null;
  if (sc.kind === "centre") {
    // Centre-hung, four-sided, clear above the overhead camera.
    const w = 7.5, h = 4.2;
    const y = Math.max(OVERHEAD_CLEAR_M + h / 2 + 0.5, Math.min(hh - h, ftToM(66)));
    cube = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const yaw = (i * Math.PI) / 2;
      const s = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, h + 0.3, 0.3), screenFrame);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), board.material);
      face.position.z = 0.16;
      s.add(frame, face);
      s.position.set(Math.sin(yaw) * (w / 2 + 0.2), 0, Math.cos(yaw) * (w / 2 + 0.2));
      s.rotation.y = yaw;
      cube.add(s);
    }
    // Lit rings top and bottom in the venue's colour.
    for (const dy of [-h / 2 - 0.35, h / 2 + 0.35]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w + 0.9, 0.25, w + 0.9), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: accent, emissiveIntensity: 1.6 }));
      r.position.y = dy;
      cube.add(r);
    }
    cube.position.y = y;
    group.add(cube);
    const cable = new THREE.Mesh(new THREE.BoxGeometry(0.06, hh - y, 0.06), trussMat);
    cable.position.y = y + (hh - y) / 2;
    group.add(cable);
  }

  // ---------------------------------------------------------------- banners
  // Hung off the back walls above the top row, in the venue's colours.
  const bannerCols = (venue.banners || []).map((c) => col(c));
  if (bannerCols.length) {
    const top = tiers[tiers.length - 1];
    const bh = 3.2, bw = 1.3;
    for (const side of st.sides) {
      const yaw = SIDES[side];
      if (yaw === undefined) continue;
      const off = side === "e" || side === "w" ? halfX - halfZ : 0;
      const g = new THREE.Group();
      g.rotation.y = yaw;
      let i = 0;
      for (let x = -length / 2 + 2; x <= length / 2 - 2; x += 4.5, i++) {
        const mat = new THREE.MeshStandardMaterial({ color: bannerCols[i % bannerCols.length], roughness: 0.8, side: THREE.DoubleSide });
        const b = new THREE.Mesh(bannerGeometry(bw, bh), mat);
        b.position.set(x, top.v1 + 2.6, top.u1 + 0.05 + off);
        b.rotation.y = Math.PI;
        g.add(b);
      }
      group.add(g);
    }
  }

  // ---------------------------------------------------------------- extras
  const extras = new Set(venue.extras || []);
  const pyros = [];
  const freeCorner = (sx, sz) => ({ x: sx * (halfX + ftToM(st.gap) + 1.5), z: sz * (halfZ + ftToM(st.gap) + 1.5) });

  if (extras.has("garageDoors")) {
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.5, roughness: 0.6 });
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x6c7277, metalness: 0.5, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      for (const z of [-hz * 0.45, hz * 0.45]) {
        const g = new THREE.Group();
        const w = 6, h = 5.5;
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.15, h, w), doorMat);
        door.position.y = deckBottom + h / 2;
        g.add(door);
        for (let y = 0.4; y < h; y += 0.55) {
          const rib = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, w), ribMat);
          rib.position.y = deckBottom + y;
          g.add(rib);
        }
        g.position.set(sx * (hx - 0.1), 0, z);
        group.add(g);
      }
    }
  }
  if (extras.has("crates")) {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.9 });
    const palletMat = new THREE.MeshStandardMaterial({ color: 0x5a4128, roughness: 0.95 });
    for (const [sx, sz] of [[1, 1], [-1, -1], [1, -1]]) {
      const c = freeCorner(sx, sz);
      for (let i = 0; i < 4; i++) {
        const s = rng.float(0.8, 1.3);
        const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), i % 2 ? palletMat : crateMat);
        crate.position.set(c.x + rng.float(-1.5, 1.5), deckBottom + s / 2 + (i === 3 ? 1.1 : 0), c.z + rng.float(-1.5, 1.5));
        crate.rotation.y = rng.float(0, Math.PI);
        group.add(crate);
      }
    }
  }
  if (extras.has("flags")) {
    // A string of pennants across each corner, above head height.
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const c = freeCorner(sx, sz);
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        const tri = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 3), new THREE.MeshStandardMaterial({ color: bannerCols[i % Math.max(1, bannerCols.length)] || accent, roughness: 0.8 }));
        tri.rotation.x = Math.PI;
        tri.position.set(c.x - sx * 3 * (1 - t), ftToM(16) - Math.sin(t * Math.PI) * 0.6, c.z - sz * 3 * t);
        group.add(tri);
      }
    }
  }
  if (extras.has("entranceTunnel")) {
    // The robots' way in, in the south-east corner: a lit arch.
    const c = freeCorner(1, 1);
    const g = new THREE.Group();
    const archMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.6, roughness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: accent, emissiveIntensity: 2.0 });
    const w = 4.5, h = 4.2, d = 3;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, d), archMat);
      post.position.set(sx * (w / 2 + 0.3), deckBottom + h / 2, 0);
      g.add(post);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, h - 0.4, 0.1), glow);
      strip.position.set(sx * (w / 2 + 0.02), deckBottom + h / 2, -d / 2 - 0.02);
      g.add(strip);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.9, d), archMat);
    lintel.position.set(0, deckBottom + h + 0.45, 0);
    g.add(lintel);
    const lstrip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.12, 0.1), glow);
    lstrip.position.set(0, deckBottom + h - 0.02, -d / 2 - 0.02);
    g.add(lstrip);
    const inside = new THREE.Mesh(new THREE.BoxGeometry(w, h, d * 2), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 1, side: THREE.BackSide }));
    inside.position.set(0, deckBottom + h / 2, d);
    g.add(inside);
    g.position.set(c.x, 0, c.z);
    g.lookAt(0, 0, 0);
    group.add(g);
  }
  if (extras.has("lightTowers")) {
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x2b2e34, metalness: 0.7, roughness: 0.4 });
    const top = tiers[tiers.length - 1];
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const r = top.u1 + 2;
      const x = sx * r * 0.82, z = sz * r * 0.82;
      const h = Math.min(hh - 2, top.v1 + 9);
      const tower = new THREE.Mesh(new THREE.BoxGeometry(0.8, h - deckBottom, 0.8), towerMat);
      tower.position.set(x, (h + deckBottom) / 2, z);
      group.add(tower);
      const head = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2, 0.3), towerMat);
      head.add(panel);
      for (let i = 0; i < 6; i++) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.32, 12), lampMat);
        l.position.set((i % 3 - 1) * 1, Math.floor(i / 3) * 0.9 - 0.45, 0.16);
        head.add(l);
      }
      head.position.set(x, h + 1, z);
      head.lookAt(0, 0, 0);
      group.add(head);
    }
  }
  if (extras.has("pyro")) {
    // Flame cannons at the four corners of the box, outside the walls.
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x222326, metalness: 0.7, roughness: 0.4 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx * (halfX + 2.2), z = sz * (halfZ + 2.2);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.8, 12), baseMat);
      base.position.set(x, deckBottom + 0.4, z);
      group.add(base);
      const flameMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1, 14, 1, true), flameMat);
      flame.position.set(x, deckBottom + 0.8, z);
      flame.visible = false;
      group.add(flame);
      const core = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      core.position.copy(flame.position);
      core.visible = false;
      group.add(core);
      pyros.push({ flame, core, t: 0, x, z });
    }
  }
  let nut = null;
  if (extras.has("nutStatue")) {
    // The trophy itself, ten times over, turning slowly on a plinth in the
    // north-west corner.
    const c = freeCorner(-1, -1);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), new THREE.MeshStandardMaterial({ color: 0x1a1420, metalness: 0.4, roughness: 0.5 }));
    plinth.position.set(c.x - 1.5, deckBottom + 1.5, c.z - 1.5);
    group.add(plinth);
    const hex = new THREE.Shape();
    const R = 3.0;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      if (i === 0) hex.moveTo(Math.cos(a) * R, Math.sin(a) * R); else hex.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    }
    hex.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, R * 0.48, 0, Math.PI * 2, true);
    hex.holes.push(hole);
    const ng = new THREE.ExtrudeGeometry(hex, { depth: 1.6, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 24 });
    ng.translate(0, 0, -0.8);
    nut = new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ color: 0xe0b02a, metalness: 1, roughness: 0.22, emissive: 0x3a2800, emissiveIntensity: 0.6 }));
    nut.position.set(c.x - 1.5, deckBottom + 3 + R + 0.2, c.z - 1.5);
    group.add(nut);
  }

  // ---------------------------------------------------------------- reactions
  // The crowd's excitement: a level that jumps on big moments and settles
  // back to the venue's resting energy.
  const rest = venue.crowd?.energy ?? 0.4;
  let excite = rest, flash = 0;
  function react(level, { pyro = false } = {}) {
    excite = Math.max(excite, rest + level);
    flash = Math.max(flash, Math.min(1, level));
    if (pyro) for (const p of pyros) p.t = 1.2;
  }
  if (bus) {
    const subs = [
      bus.on(EV.HIT, (e) => {
        const big = e.severity === "catastrophic" ? 1.1 : e.severity === "heavy" ? 0.75 : e.severity === "medium" ? 0.35 : 0.15;
        react(big, { pyro: e.severity === "catastrophic" });
      }),
      bus.on(EV.PART_FAILED, () => react(0.7)),
      bus.on(EV.REF_COUNT, () => react(0.55)),
      bus.on(EV.KO, () => react(1.5, { pyro: true })),
      bus.on(EV.MATCH_END, () => react(1.3, { pyro: true })),
      bus.on(EV.HAZARD_FIRE, (e) => react(e.type === "pit" ? 0.9 : 0.2)),
      bus.on(EV.MATCH_STATE, ({ phase }) => { if (phase === "live") react(1.0, { pyro: true }); else if (phase === "countdown") react(0.5); }),
    ];
    disposers.push(() => subs.forEach((off) => off?.()));
  }

  let t = 0, lastClock = null;
  const aim = new THREE.Vector3();
  return {
    group,
    react,
    /** Once per rendered frame. `match` (optional) puts its clock on the screens. */
    update(dt, match = null) {
      t += dt;
      excite += (rest - excite) * Math.min(1, dt * 0.55);
      flash = Math.max(0, flash - dt * 1.6);
      crowdU.uTime.value = t;
      crowdU.uExcite.value = excite;
      crowdU.uGlow.value = glow * (1 + 1.2 * flash);
      for (const b of beams) {
        // Aim at a point in the stand behind the lamp, wandering along it.
        const t0 = tiers[0];
        const reachOut = t0.u0 + (t0.u1 - t0.u0) * (0.45 + 0.3 * Math.sin(t * 0.37 + b.phase));
        const along = b.at * length + Math.sin(t * 0.23 + b.phase * 2) * length * 0.35;
        aim.set(b.out.x * reachOut + b.along.x * along, t0.v0 + (t0.v1 - t0.v0) * 0.5, b.out.z * reachOut + b.along.z * along);
        b.beam.lookAt(aim);
        b.beam.material.opacity = 0.03 + 0.07 * flash;
      }
      for (const m of ribbonMats) m.emissiveIntensity = 1.2 + 1.6 * flash * (0.5 + 0.5 * Math.sin(t * 18));
      lampMat.emissiveIntensity = 2.2 + 1.5 * flash;
      for (const p of pyros) {
        p.t = Math.max(0, p.t - dt);
        const on = p.t > 0;
        p.flame.visible = p.core.visible = on;
        if (!on) continue;
        const k = p.t / 1.2;
        const h = 2.5 + 3.5 * Math.sin(Math.min(1, (1 - k) * 4) * Math.PI / 2) * (0.85 + 0.15 * Math.sin(t * 40));
        for (const [m, w] of [[p.flame, 1], [p.core, 0.7]]) {
          m.scale.set(w, h * w, w);
          m.position.y = deckBottom + 0.8 + (h * w) / 2;
          m.material.opacity = Math.min(1, k * 2) * (m === p.core ? 0.9 : 0.7);
        }
      }
      if (nut) nut.rotation.y += dt * 0.25;
      if (cube) cube.rotation.y += dt * 0.05;
      if (match) {
        const clock = Math.ceil(match.clockS ?? 0);
        if (clock !== lastClock) { lastClock = clock; board.draw(clock, match.phase); }
      }
    },
    dispose() { disposers.forEach((d) => d()); scene.remove(group); },
  };
}

// ---------------------------------------------------------------- pieces

/** A seated fan from the waist up, facing -Z: torso and two arms (aArm = 1). */
function personGeometry() {
  const parts = [
    { w: 0.42, h: 0.56, d: 0.26, x: 0, y: 0.70, arm: 0 },
    { w: 0.11, h: 0.5, d: 0.13, x: -0.27, y: 0.70, arm: 1 },
    { w: 0.11, h: 0.5, d: 0.13, x: 0.27, y: 0.70, arm: 1 },
  ];
  const pos = [], nrm = [], arm = [], idx = [];
  for (const p of parts) {
    const g = new THREE.BoxGeometry(p.w, p.h, p.d);
    g.translate(p.x, p.y, 0);
    const base = pos.length / 3;
    pos.push(...g.attributes.position.array);
    nrm.push(...g.attributes.normal.array);
    for (let i = 0; i < g.attributes.position.count; i++) arm.push(p.arm);
    for (const i of g.index.array) idx.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("aArm", new THREE.Float32BufferAttribute(arm, 1));
  g.setIndex(idx);
  return g;
}

/** The crowd's material: standard, with the bob, jump and arms-up in the vertex shader. */
function crowdMaterial(uniforms, arms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.uniforms.uGlow = uniforms.uGlow;
    // A little of each fan's own colour as glow: the house lights are on the
    // box, and without it the far stands go black.
    shader.fragmentShader = `uniform float uGlow;\n` + shader.fragmentShader.replace("#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uGlow;");
    shader.vertexShader = `uniform float uTime;\nuniform float uExcite;\nattribute float aPhase;\nattribute float aGain;\n${arms ? "attribute float aArm;\n" : ""}` +
      shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
        float ex = clamp(uExcite * aGain, 0.0, 1.6);
        float bob = sin(uTime * (1.6 + aGain) + aPhase) * 0.025 * (0.5 + ex);
        float jump = max(0.0, sin(uTime * 8.5 + aPhase * 3.0)) * 0.24 * smoothstep(0.75, 1.3, ex);
        transformed.y += bob + jump;
        ${arms ? "transformed.y += aArm * 0.52 * smoothstep(0.45 + 0.35 * fract(aPhase), 1.0, ex);" : ""}`);
  };
  mat.customProgramCacheKey = () => (arms ? "crowd-body" : "crowd-head");
  return mat;
}

/** Colour every vertex of a non-indexed geometry by its face normal. */
function paintByNormal(g, pick) {
  const n = g.attributes.normal, c = new Float32Array(n.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i);
    const k = pick(v);
    c[i * 3] = k.r; c[i * 3 + 1] = k.g; c[i * 3 + 2] = k.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
}

/** A hanging banner with a swallowtail foot. */
function bannerGeometry(w, h) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, -h); s.lineTo(0, -h + w * 0.45); s.lineTo(-w / 2, -h);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

/** A light beam: an open cone, additive, pointing down from its apex. */
function makeBeam(color, length) {
  const g = new THREE.ConeGeometry(length * 0.28, length * 1.15, 20, 1, true);
  g.translate(0, -length * 1.15 / 2, 0);   // apex (the cone's top) at the lamp, opening down -Y...
  g.rotateX(-Math.PI / 2);                  // ...then along +Z, so lookAt() aims it
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5;
  return mesh;
}

/** The screens' picture, on a canvas. Headless (no document), a plain colour. */
function makeBoard(venue, names, accent) {
  const doc = typeof document !== "undefined" ? document : null;
  const canvas = doc?.createElement?.("canvas");
  const ctx = canvas?.getContext?.("2d");
  if (!canvas || !ctx) {
    return { material: new THREE.MeshBasicMaterial({ color: accent }), draw() {} };
  }
  canvas.width = 512; canvas.height = 288;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const acc = `#${accent.getHexString()}`;
  const fit = (text, max, size) => {
    let s = size;
    ctx.font = `800 ${s}px system-ui, sans-serif`;
    while (s > 12 && ctx.measureText(text).width > max) { s -= 2; ctx.font = `800 ${s}px system-ui, sans-serif`; }
  };
  function draw(clock = 180, phase = "idle") {
    ctx.fillStyle = "#07080b"; ctx.fillRect(0, 0, 512, 288);
    ctx.fillStyle = acc; ctx.fillRect(0, 0, 512, 8); ctx.fillRect(0, 280, 512, 8);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#9aa3b2";
    fit(String(venue.name).toUpperCase(), 470, 22);
    ctx.fillText(String(venue.name).toUpperCase(), 256, 30);
    // The two corners.
    ctx.fillStyle = "#d8343a"; ctx.fillRect(16, 60, 230, 92);
    ctx.fillStyle = "#2a83d8"; ctx.fillRect(266, 60, 230, 92);
    ctx.fillStyle = "#ffffff";
    fit(String(names.red || "RED").toUpperCase(), 210, 30);
    ctx.fillText(String(names.red || "RED").toUpperCase(), 131, 106);
    fit(String(names.blue || "BLUE").toUpperCase(), 210, 30);
    ctx.fillText(String(names.blue || "BLUE").toUpperCase(), 381, 106);
    // The clock, or the result.
    const mm = Math.floor(Math.max(0, clock) / 60), ss = String(Math.max(0, clock) % 60).padStart(2, "0");
    ctx.fillStyle = phase === "ended" ? acc : "#ffffff";
    ctx.font = "800 84px system-ui, sans-serif";
    ctx.fillText(phase === "ended" ? "FINAL" : `${mm}:${ss}`, 256, 218);
    tex.needsUpdate = true;
  }
  draw();
  return { material, draw };
}
