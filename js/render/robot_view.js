// robot_view.js - the robot's visuals, generated from its assembled build.
//
// No hand-modelled bots: the body is the convex pieces shape.js sculpts (the
// same points physics collides with), painted with the robot's livery
// (livery.js), and dressed in detailed wheels and weapons (robot_parts.js)
// sized from the part specs. A new bot in the roster gets a body for free.
// Stage 6's workshop will reuse this exact builder to preview a build, which
// is why it takes an `assembled` and nothing else game-specific.
//
// A robot file can tune the look without touching stats, in `body.look`:
//   { "teeth": 3, "shell": "drum", "rows": 3, "head": "sledge" }

import * as THREE from "three";
import { inToM } from "../core/units.js";
import { paintLivery, ATLAS } from "./livery.js";
import {
  hullGeometry, wheelGeometries, barRotor, discRotor, drumRotor, eggbeaterRotor,
  shellRotor, triRotor, armParts, flipperPlate, forkGeometry, beakGeometry, lidParts, creasedNormals, cyl,
  BODY_STYLE,
} from "./robot_parts.js";
import { MOBILE } from "../core/platform.js";
import { convexFaces } from "../core/hull.js";

export function buildRobotView(scene, assembled, sim, mats) {
  const group = new THREE.Group();
  group.name = `robot:${assembled.id}`;
  scene.add(group);

  const livery = assembled.livery || {};
  const look = assembled.def?.body?.look || {};
  const bodyMat = mats.livery(livery.primary || "#b8babf");
  const trimMat = mats.livery(livery.secondary || "#202227");
  const accentMat = mats.livery(livery.accent || "#f0c419");
  const fine = BODY_STYLE.surface;
  const metal = (fine && mats.weaponSteelFine) || mats.weaponSteel || mats.ar500_steel;
  const dark = (fine && mats.robotDarkFine) || mats.robotDark || mats.hub;
  const hubMat = (fine && mats.hubFine) || mats.hub;
  const owned = [];           // per-view materials and textures, disposed with it

  // ---- body: every convex piece of the robot's shape (js/logic/shape.js),
  // drawn from the same hull points the physics collides with.
  const shape = sim.shape;
  const classic = shape.template === "classic";
  const panelMeshes = new Map();    // fitting key -> [meshes], for damage visuals
  const steelLike = new Set(["ar500_steel", "grade5_ti", "hardox", "steel"]);
  const isHull = (p) => /^(core|chin|cheek:|body:|plate:|armor:)/.test(p.id);

  // The paint job, where there is a canvas to paint it on (not in the
  // headless checks, which fall back to flat livery colours).
  let paint = null, bodyBounds = null, sheets = null;
  if (!classic && typeof document !== "undefined" && typeof mats.robotPaint === "function") {
    bodyBounds = boundsOf(shape.pieces.filter(isHull).flatMap((p) => p.points));
    const sheet = (size) => { const c = document.createElement("canvas"); c.width = c.height = size; return c; };
    const canvas = sheet(ATLAS.size);
    // The surface maps: full size on desktop, half on the phone build.
    const relief = fine ? { height: sheet(ATLAS.size / (MOBILE ? 2 : 1)), finish: sheet(ATLAS.size / (MOBILE ? 2 : 1)) } : null;
    sheets = { canvas, relief };
    paint = mats.robotPaint(canvas, relief);
    owned.push(paint, paint.map);
    if (paint.bumpMap) owned.push(paint.bumpMap);
    if (paint.roughnessMap) owned.push(paint.roughnessMap);
  }

  const materialFor = (piece, fittingKey) => {
    // Wedges, forks and plows: the working steel, kept bright like the weapons.
    if (piece.role === "metal") return classic ? mats.ar500_steel : metal;
    if (piece.role === "trim") return trimMat;
    if (piece.role === "accent") return accentMat;
    if (piece.role === "armor") {
      const part = assembled.fittings.find((f) => f.key === fittingKey)?.part;
      const material = part?.spec.material;
      // The test bots keep their raw-material look (steel front, white UHMW).
      if (classic) return material ? mats.byName(material) : bodyMat;
      if (piece.slot === "front" && material && steelLike.has(material)) return mats.byName(material);
      if (paint) return paint;
      if (piece.slot === "rear") return trimMat;
      return bodyMat;
    }
    if (paint) return paint;
    return classic ? bodyMat : trimMat;   // the core, mostly under its plates
  };

  // Every mesh is tagged with the part it belongs to (userData.partKey: a
  // fitting key like "armor.1", or "chassis", "weapon", "wheel"), so the
  // Stage 6 workshop can pick parts with the mouse and snap new ones in.
  const partObjects = new Map();
  const tag = (obj, key) => {
    obj.traverse((o) => { o.userData.partKey = key; });
    if (!partObjects.has(key)) partObjects.set(key, []);
    partObjects.get(key).push(obj);
  };

  for (const piece of shape.pieces) {
    const key = sim.routes.get(piece.id);
    const mat = materialFor(piece, key);
    const mesh = new THREE.Mesh(hullGeometry(piece.points, mat === paint ? bodyBounds : null), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    mesh.userData.hull = true;          // its faces are in the paint's own picture already
    tag(mesh, piece.slot === "weapon" || piece.id.startsWith("weapon:") ? "weapon" : key || "chassis");
    // Armour and weapon pieces dent and darken as their fitting takes damage.
    if (key && key !== "chassis" && piece.id !== "core") {
      if (!panelMeshes.has(key)) panelMeshes.set(key, []);
      panelMeshes.get(key).push(mesh);
    }
  }

  const { lengthM: L, heightM: H, widthM: W } = assembled.dims;
  if (classic) {
    // Accent stripe down the spine, so rotation is readable at a glance.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.98, H * 0.18, W * 0.12), accentMat);
    stripe.position.y = H / 2 + 0.001;
    group.add(stripe);
    // Front marker: you must be able to tell which way a wedge is pointing.
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.02, H * 0.5, W * 0.5), accentMat);
    nose.position.set(L / 2 + 0.002, H * 0.15, 0);
    group.add(nose);
  } else {
    // The power light every bot on the show must carry, high on the tail.
    const core = shape.pieces.find((p) => p.id === "core");
    if (core) {
      const xs = core.points.map((p) => p.x);
      const tail = Math.min(...xs);
      const tailTop = Math.max(...core.points.filter((p) => p.x < tail + 0.02).map((p) => p.y));
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.03), mats.powerLight || accentMat);
      lamp.position.set(tail - 0.012, tailTop - 0.025, 0);
      group.add(lamp);
    }
  }

  const resolve = (k) => ({ steel: metal, hub: hubMat, dark, accent: accentMat, trim: trimMat,
    paint: paint || bodyMat, paintFlat: bodyMat, saw: mats.sawBlade || metal }[k] || metal);
  const addParts = (parent, parts) => {
    for (const { geo, mat } of parts) {
      const m = new THREE.Mesh(geo, resolve(mat));
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
    }
  };

  // ---- the weapon, from the shape's description of it. Spinners had
  // colliders but NO mesh once, so every spinner in the game was invisible;
  // this is built from the same numbers the colliders are.
  let weaponSpinner = null;
  const wv = shape.weapon?.visual;
  const weaponId = assembled.parts.weapon?.id || "";
  if (wv?.kind === "rotor") {
    const hub = new THREE.Group();
    hub.position.set(wv.center.x, wv.center.y, wv.center.z);
    const r = wv.radius, t = wv.thickness;
    // Built about local Y; a lateral axle is then a quarter turn about X.
    const rotor = new THREE.Group();
    if (wv.axis === "z") rotor.rotation.x = Math.PI / 2;
    hub.add(rotor);
    let parts;
    if (wv.style === "bar") {
      // At rest a bar lies ACROSS the front, the way it is parked in the box.
      if (wv.axis === "y") rotor.rotation.y = Math.PI / 2;
      parts = barRotor(r, t, Math.max(0.05, r * 0.22));
    } else if (wv.style === "tri") parts = triRotor(r, t);
    else if (wv.style === "shell") {
      // The shell covers the whole robot: find the body under it, in the
      // rotor's frame, so it can wrap over without cutting in.
      const body = shape.pieces.filter(isHull).flatMap((pc) => pc.points)
        .map((q) => ({ y: q.y - wv.center.y, rad: Math.hypot(q.x - wv.center.x, q.z - wv.center.z) }));
      const topY = Math.max(...body.map((q) => q.y)) + 0.015;
      // Radius of the body's hull at height y, from above: interpolating the
      // radial distance between any point below y and any above it bounds
      // the hull's cross-section (|lerp(a, b)| <= lerp(|a|, |b|)).
      const bodyRadius = (y) => {
        let m = 0;
        for (const a of body) {
          if (a.y > y) continue;
          for (const c of body) {
            if (c.y < y) continue;
            const t = c.y - a.y > 1e-6 ? (y - a.y) / (c.y - a.y) : 0;
            m = Math.max(m, a.rad + (c.rad - a.rad) * t);
          }
        }
        return m;
      };
      parts = shellRotor(r, t, { profile: look.shell || "dome", teeth: look.teeth ?? 2, topY, bodyRadius });
    }
    else if (wv.style === "eggbeater") parts = eggbeaterRotor(r, t);
    else if (wv.style === "drum") parts = drumRotor(r, t, { rows: look.rows, perRow: look.teeth ?? 2 });
    else {
      // The collider is the full width the disc may occupy; the disc itself
      // is a slimmer plate in the middle of it, as real ones are.
      const plate = Math.min(t, Math.max(0.022, r * 0.12));
      parts = discRotor(r, plate, look.teeth ?? (r > 0.2 ? 2 : 3));
    }
    addParts(rotor, parts);
    tag(hub, "weapon");
    // What the rotor turns on, from shape.js: a disc or drum's axle across
    // its two supports (with a bearing cap on each), a bar's shaft up
    // through its bearing plates. Fixed to the hub, so it does not spin.
    if (wv.axle) {
      const ax = new THREE.Mesh(cyl(wv.axle.radius, wv.axle.radius, wv.axle.halfLen * 2, 16), hubMat);
      ax.rotation.x = Math.PI / 2;
      hub.add(ax);
      for (const s of [-1, 1]) {
        const cap = new THREE.Mesh(cyl(wv.axle.bossR * 0.72, wv.axle.bossR * 0.72, 0.01, 18), hubMat);
        cap.rotation.x = Math.PI / 2;
        cap.position.z = s * (wv.axle.halfLen + 0.001);
        cap.castShadow = true;
        hub.add(cap);
        const nut = new THREE.Mesh(new THREE.CylinderGeometry(wv.axle.radius * 1.5, wv.axle.radius * 1.5, 0.014, 6), dark);
        nut.rotation.x = Math.PI / 2;
        nut.position.z = s * (wv.axle.halfLen + 0.008);
        hub.add(nut);
      }
    }
    if (wv.shaft) {
      const len = wv.shaft.y1 - wv.shaft.y0;
      const sh = new THREE.Mesh(cyl(wv.shaft.r, wv.shaft.r, len, 16), hubMat);
      sh.position.y = (wv.shaft.y0 + wv.shaft.y1) / 2 - wv.center.y;
      hub.add(sh);
    }
    group.add(hub);
    // Spin about the rotor's own axis (local Y of the inner group).
    weaponSpinner = { mesh: rotor, axis: "y", hub, hubRest: hub.rotation.clone() };
  } else if (wv?.kind === "arm") {
    // Arm and head, swinging about the pivot.
    const arm = new THREE.Group();
    arm.position.set(wv.pivot.x, wv.pivot.y, wv.pivot.z);
    let style = look.head || wv.style;
    if (!look.head && style === "axe" && /sledge/.test(weaponId)) style = "sledge";
    addParts(arm, armParts(wv.reach, wv.head, style));
    group.add(arm);
    tag(arm, "weapon");
    weaponSpinner = { mesh: arm, axis: "swing", hub: arm, hubRest: arm.rotation.clone() };
  } else if (wv?.kind === "plate" || wv?.kind === "jaw") {
    // Flipper, lifter or crusher. The collider is the whole working zone in
    // front of the nose; what is drawn is the mechanism inside it: a flat
    // plate or forks at the floor, and for a crusher an arched beak that
    // comes down over it from the top of the body.
    const plate = new THREE.Group();
    plate.position.set(wv.center.x, wv.center.y, wv.center.z);
    const floorY = -wv.size.h / 2 + 0.002;
    const l = wv.size.l, w = wv.size.w;
    const floorPart = new THREE.Group();
    floorPart.position.y = floorY;
    if (wv.style === "lifter" || wv.style === "clamp" || wv.kind === "jaw") {
      // Twin forks.
      for (const zs of [-1, 1]) {
        const fork = new THREE.Mesh(forkGeometry(l, w * 0.22), metal);
        fork.position.set(0, 0.013, zs * w * 0.3);
        fork.castShadow = true;
        floorPart.add(fork);
      }
    } else {
      floorPart.rotation.z = -0.08;
      addParts(floorPart, flipperPlate(l, w));
    }
    plate.add(floorPart);
    if (wv.kind === "jaw") {
      // The beak, hinged at the top of the body behind the nose.
      const pivot = { x: -l * 0.5 - 0.08, y: wv.top + 0.03 - wv.center.y };
      const beak = new THREE.Group();
      beak.position.set(pivot.x, pivot.y, 0);
      const reach = l * 0.85 - pivot.x;
      const drop = pivot.y - floorY - 0.04;
      if (wv.style === "claw") {
        for (const zs of [-1, 1]) {
          const claw = new THREE.Mesh(beakGeometry(reach, drop, Math.max(0.03, w * 0.1)), metal);
          claw.position.z = zs * w * 0.3;
          claw.castShadow = true;
          beak.add(claw);
        }
      } else {
        const b = new THREE.Mesh(beakGeometry(reach, drop, Math.max(0.05, w * 0.3)), metal);
        b.castShadow = true;
        beak.add(b);
      }
      const axle = new THREE.Mesh(cyl(0.03, 0.03, w * 0.5, 14), hubMat);
      axle.rotation.x = Math.PI / 2;
      beak.add(axle);
      plate.add(beak);
      weaponSpinner = { mesh: beak, axis: "jaw", rest: 0.35 };
    } else if (wv.lid && !classic) {
      // A lid flipper: the plate covers the top, hinged at the back.
      const lidLen = wv.center.x - wv.hingeX;
      const lid = new THREE.Group();
      lid.position.set(wv.hingeX - wv.center.x, wv.top + 0.012 - wv.center.y, 0);
      addParts(lid, lidParts(lidLen, wv.size.w));
      plate.add(lid);
      weaponSpinner = { mesh: lid, axis: "flip" };
    } else {
      weaponSpinner = { axis: "lift", all: [floorPart], base: [floorPart.position.y] };
    }
    group.add(plate);
    tag(plate, "weapon");
  }

  // ---- wheels. Rebuilt positions every frame from suspension telemetry.
  const r = assembled.stats.wheelRadiusM;
  const wheelW = inToM(assembled.parts.wheel.spec.widthIn);
  const wg = wheelGeometries(r, wheelW);
  const wheelMeshes = sim.wheels.map(() => {
    const w = new THREE.Group();
    const tyre = new THREE.Mesh(wg.tyre, mats.rubber);
    tyre.castShadow = true;
    w.add(tyre);
    w.add(new THREE.Mesh(wg.hub, hubMat));
    // Spokes and a coloured cap, so wheel spin is visible.
    w.add(new THREE.Mesh(wg.spokes, dark));
    w.add(new THREE.Mesh(wg.cap, accentMat));
    group.add(w);
    tag(w, "wheel");
    return w;
  });

  const restLength = sim.suspension.restLength;

  // ---- visible damage (beyond dents and darkening): how bent the weapon is,
  // how loose each wheel runs, and where the robot is smoking from.
  let weaponCond = 1, wheelCond = 1, weaponAngle = 0;
  const cond = {};                       // fitting key -> condition, as last shown
  const seedOf = (key) => { let h = 2166136261; for (const ch of `${assembled.id}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
  // Where the insides would smoke from, in the robot's own frame.
  const smokeAt = {
    motor: new THREE.Vector3(-L * 0.22, H * 0.55, W * 0.18),
    drive: new THREE.Vector3(-L * 0.22, H * 0.5, -W * 0.18),
    battery: new THREE.Vector3(-L * 0.05, H * 0.6, 0),
    electronics: new THREE.Vector3(L * 0.05, H * 0.6, 0),
    weaponMotor: wv?.center ? new THREE.Vector3(wv.center.x * 0.6, Math.max(H * 0.5, (wv.center.y || 0)), 0) : new THREE.Vector3(L * 0.2, H * 0.55, 0),
  };

  /**
   * A badly beaten panel comes loose: it hangs off at an angle about its own
   * middle (the geometry is re-centred once so it can turn there).
   */
  function loosen(mesh, key, t) {
    if (!/^armor\./.test(key)) return;
    if (t >= 0.35 || t <= 0.001) {
      if (mesh.userData.pivot) mesh.rotation.set(0, 0, 0);
      return;
    }
    if (!mesh.userData.pivot) {
      mesh.geometry.computeBoundingBox();
      const c = mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
      mesh.geometry.translate(-c.x, -c.y, -c.z);
      mesh.position.add(c);
      mesh.userData.pivot = c;
    }
    const k = (0.35 - t) / 0.35;
    const s = seedOf(key);
    mesh.rotation.set((s - 0.5) * 0.5 * k, 0, (s < 0.5 ? -1 : 1) * (0.12 + 0.18 * k));
  }

  // Now the paint job, last, once everything that could hide it is built:
  // it is told which faces wear the paint, where the wheels sit and what the
  // weapon covers, so the name lands on a flat panel it fits (livery.js).
  if (sheets) {
    const faces = [];
    shape.pieces.forEach((piece, pi) => {
      const usesPaint = materialFor(piece, sim.routes.get(piece.id)) === paint;
      const { points, faces: fs } = convexFaces(piece.points);
      for (const f of fs) faces.push({ n: f.n, ring: f.ring.map((i) => points[i]), paint: usesPaint, piece: pi });
    });
    const wheelR = assembled.stats.wheelRadiusM;
    const wheelW = assembled.parts.wheel ? inToM(assembled.parts.wheel.spec.widthIn) : 0;
    const wheels = wheelW ? sim.wheels.map((wh, i) => {
      const anchor = sim.wheelAnchor ? sim.wheelAnchor(i) : wh.anchor;
      const drop = sim.suspension.restLength * (1 - (sim.telemetry?.[i]?.compression ?? 0));
      return { x: anchor.x, y: anchor.y - drop, z: anchor.z, r: wheelR, w: wheelW };
    }) : [];
    // The weapon's own parts (arms, uprights, rotors), as triangles in body
    // space: a flat list of x, y, z, three corners a triangle.
    group.updateMatrixWorld(true);
    const toBody = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const tris = [], v = new THREE.Vector3(), m = new THREE.Matrix4();
    for (const obj of partObjects.get("weapon") || []) {
      obj.traverse((o) => {
        if (!o.isMesh || o.userData.hull) return;
        m.multiplyMatrices(toBody, o.matrixWorld);
        const pos = o.geometry.attributes.position, idx = o.geometry.index;
        const n = idx ? idx.count : pos.count;
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m);
          tris.push(v.x, v.y, v.z);
        }
      });
    }
    const blockers = tris.length ? [tris] : [];
    paintLivery(sheets.canvas, {
      id: assembled.id, name: assembled.name ?? assembled.def?.name, livery,
      template: shape.template, bounds: bodyBounds, relief: sheets.relief, faces, wheels, blockers,
    });
    for (const t of [paint.map, paint.bumpMap, paint.roughnessMap]) if (t) t.needsUpdate = true;
  }

  return {
    group,
    panelMeshes,
    /** Objects by part key ("weapon", "wheel", "chassis", "armor.N"). */
    partObjects,

    /** Copy the body pose and wheel state out of physics. Once per frame. */
    update(pose) {
      const p = pose || sim.pose();
      group.position.set(p.pos.x, p.pos.y, p.pos.z);
      group.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);

      for (let i = 0; i < wheelMeshes.length; i++) {
        const mesh = wheelMeshes[i];
        const anchor = sim.wheelAnchor ? sim.wheelAnchor(i) : sim.wheels[i].anchor;
        const tele = sim.telemetry[i];
        // Wheel centre hangs `restLength - compression` below its mount - or
        // above it, when an invertible bot is running on its back.
        const drop = restLength * (1 - (tele.grounded ? tele.compression : 0));
        mesh.position.set(anchor.x, anchor.y + (sim.inverted ? drop : -drop), anchor.z);
        mesh.rotation.z = -tele.spin;
        // A damaged wheel runs out of true.
        if (wheelCond < 0.5) mesh.rotation.x = (0.5 - wheelCond) * 0.35 * Math.sin(tele.spin + i);
      }
    },

    /**
     * Drive the weapon mesh from the live weapon state.
     * @param {object} weapon  from js/logic/weapon.js
     * @param {number} dt
     */
    updateWeapon(weapon, dt) {
      if (!weaponSpinner || !weapon) return;
      const sp = weaponSpinner;

      if (sp.axis === "y" || sp.axis === "z") {
        // Visible rotation is capped well below the real rim speed: a bar doing
        // 350 rad/s at 60 fps turns ~5.8 rad per frame, which just strobes into
        // a blur going the wrong way. This reads as fast without aliasing.
        const visual = Math.min(weapon.omegaRadS, 42);
        sp.mesh.rotation[sp.axis] += visual * dt;
        // A bent rotor wobbles on its shaft; a dead one sits crooked.
        if (weaponCond < 0.7 && sp.hub) {
          weaponAngle += visual * dt;
          const tilt = weaponCond <= 0.001 ? 0 : (0.7 - weaponCond) * 0.22;
          const droop = weaponCond <= 0.001 ? 0.22 : 0;
          sp.hub.rotation.x = sp.hubRest.x + tilt * Math.sin(weaponAngle);
          sp.hub.rotation.z = sp.hubRest.z + tilt * Math.cos(weaponAngle) + droop;
        }
      } else if (sp.axis === "swing") {
        // Hammers slam and reset, so follow the phase rather than a speed.
        const target = weapon.phase === "striking" ? -1.35
                     : weapon.phase === "reloading" ? 0.1 : 0.45;
        sp.mesh.rotation.z += (target - sp.mesh.rotation.z) * Math.min(1, dt * 14);
      } else if (sp.axis === "flip") {
        // A lid flipper kicks up about its hinge and drops back.
        const target = weapon.phase === "striking" ? 0.9 : 0;
        sp.mesh.rotation.z += (target - sp.mesh.rotation.z) * Math.min(1, dt * 18);
      } else if (sp.axis === "lift") {
        // Forks and plates rise when fired.
        const up = weapon.phase === "striking" ? 0.12 : 0;
        sp.all.forEach((m, k) => { m.position.y += (sp.base[k] + up - m.position.y) * Math.min(1, dt * 14); });
      } else if (sp.axis === "jaw") {
        const closed = weapon.phase === "closed" || weapon.phase === "striking";
        const target = closed ? 0 : sp.rest;
        sp.mesh.rotation.z += (target - sp.mesh.rotation.z) * Math.min(1, dt * 6);
      }
    },

    /** Dent a fitting's pieces at a world-space point. */
    dent(fittingKey, worldPoint, depth = 0.012) {
      for (const mesh of panelMeshes.get(fittingKey) || []) dentMesh(mesh, worldPoint, depth);
    },

    /** Darken a fitting's pieces as its condition falls, so damage reads at a glance. */
    setPanelCondition(fittingKey, condition) {
      for (const mesh of panelMeshes.get(fittingKey) || []) {
        if (!mesh.userData.baseColor) {
          mesh.material = mesh.material.clone();
          owned.push(mesh.material);
          mesh.userData.baseColor = mesh.material.color.clone();
        }
        const t = Math.max(0, Math.min(1, condition));
        mesh.material.color.copy(mesh.userData.baseColor).multiplyScalar(0.42 + 0.58 * t);
        // Scorched and scuffed: duller as it goes.
        if (mesh.material.roughness !== undefined) {
          mesh.userData.baseRough ??= mesh.material.roughness;
          mesh.userData.baseMetal ??= mesh.material.metalness ?? 0;
          mesh.material.roughness = Math.min(1, mesh.userData.baseRough + (1 - t) * 0.35);
          if (mesh.material.metalness !== undefined) mesh.material.metalness = mesh.userData.baseMetal * (0.6 + 0.4 * t);
        }
        mesh.visible = t > 0.001;
        loosen(mesh, fittingKey, t);
      }
      cond[fittingKey] = condition;
      if (fittingKey === "weapon") {
        weaponCond = condition;
        if (weaponCond >= 0.7 && weaponSpinner?.hub) weaponSpinner.hub.rotation.copy(weaponSpinner.hubRest);
        // A hammer or axe arm bends sideways.
        if (weaponSpinner?.axis === "swing") weaponSpinner.hub.rotation.y = weaponSpinner.hubRest.y + (condition < 0.6 ? (0.6 - condition) * 0.5 * (seedOf("arm") < 0.5 ? -1 : 1) : 0);
      }
      if (fittingKey === "wheel") {
        wheelCond = condition;
        // A wheel gone altogether: one corner runs on its hub.
        if (wheelMeshes[0]) wheelMeshes[0].children[0].visible = condition > 0.001;
      }
    },

    /** Back to as-built looks (a rematch starts from scratch, then re-applies what it carried in). */
    resetCondition() {
      for (const k of new Set([...panelMeshes.keys(), ...Object.keys(cond), "weapon", "wheel"])) this.setPanelCondition(k, 1);
    },

    /**
     * Show a robot's damage all at once - what it carries in from its last
     * fight (the Stage 7 pit): dents where it was hit, darkened and loose
     * panels, a bent weapon, and smoke from what is hurt inside.
     */
    applyCondition(condition = {}) {
      for (const [key, c] of Object.entries(condition)) {
        if (c >= 0.999) continue;
        this.setPanelCondition(key, c);
        // Old dents: a few, placed by the fitting so they are the same every time.
        if (c < 0.9 && c > 0.001) {
          for (const mesh of panelMeshes.get(key) || []) {
            const pos = mesh.geometry?.attributes?.position;
            if (!pos || mesh.userData.oldDents) continue;
            mesh.userData.oldDents = true;
            const n = Math.ceil((1 - c) * 5);
            for (let d = 0; d < n; d++) {
              const v = Math.floor(seedOf(`${key}:${d}`) * pos.count);
              const p = new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v));
              mesh.updateMatrixWorld(true);
              dentMesh(mesh, mesh.localToWorld(p), 0.006 + (1 - c) * 0.01);
            }
          }
        }
      }
    },

    /**
     * Where this robot is smoking (or burning) from right now, in world space:
     * [{ pos, rate 0..1, fire, sparks }]. effects.js turns them into smoke.
     */
    damageSources() {
      const out = [];
      for (const [key, at] of Object.entries(smokeAt)) {
        const c = cond[key];
        if (c === undefined || c >= 0.5) continue;
        const p = at.clone();
        group.localToWorld(p);
        out.push({ key, pos: p, rate: Math.min(1, (0.5 - c) * 2.2 + 0.15), fire: key === "battery" && c < 0.22, sparks: key === "electronics" && c < 0.3 });
      }
      return out;
    },

    /** Used by the replay camera, which drives the view from recorded poses. */
    setPose(pos, quat) {
      group.position.set(pos.x, pos.y, pos.z);
      group.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    },

    dispose() {
      scene.remove(group);
      group.traverse((o) => o.geometry?.dispose());
      for (const x of owned) x.dispose?.();
    },
  };
}

function boundsOf(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const k of ["x", "y", "z"]) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { min, max };
}

/**
 * Push vertices in around a world-space point, so a bot that has taken a
 * beating visibly carries it. Cheap: a hull piece has few enough vertices that
 * this is a handful of distance checks.
 */
function dentMesh(mesh, worldPoint, depth) {
  if (!mesh.geometry || !worldPoint) return;
  const pos = mesh.geometry.attributes.position;
  if (!pos) return;

  // World point into the panel's local space.
  const local = mesh.worldToLocal(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));
  const radius = 0.09;
  let touched = false;

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    const d = Math.hypot(vx - local.x, vy - local.y, vz - local.z);
    if (d > radius) continue;
    // Falls off smoothly from the impact point.
    const k = (1 - d / radius) * depth;
    const len = Math.hypot(vx, vy, vz) || 1;
    pos.setXYZ(i, vx - (vx / len) * k, vy - (vy / len) * k, vz - (vz / len) * k);
    touched = true;
  }
  if (touched) {
    pos.needsUpdate = true;
    if (mesh.geometry.userData.rounded) creasedNormals(mesh.geometry);
    else mesh.geometry.computeVertexNormals();
  }
}
