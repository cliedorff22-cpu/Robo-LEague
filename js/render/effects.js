// effects.js - sparks, debris meshes and impact marks.
//
// Subscribes to the bus and nothing else. The logic layer emits facts ("this
// fitting took a heavy hit, here, with this normal"); this file decides what
// that looks like. That is the whole reason combat.js carries a contact point.
//
// Sparks are one pooled THREE.Points with an additive material, so a busy
// exchange costs one draw call. They are deliberately bright: the bloom pass
// is what turns them from white dots into sparks.

import * as THREE from "three";
import { EV } from "../core/bus.js";
import { SEVERITY_ORDER } from "../logic/damage.js";

const MAX_SPARKS = 900;
const MAX_SMOKE = 700;
const GRAVITY = -9.81;

export function makeEffects(scene, { bus, mats, robotViews, debris, rng, arena }) {
  // ---------------------------------------------------------------- sparks
  const positions = new Float32Array(MAX_SPARKS * 3);
  const colors = new Float32Array(MAX_SPARKS * 3);
  const sizes = new Float32Array(MAX_SPARKS);
  const vel = new Float32Array(MAX_SPARKS * 3);
  const life = new Float32Array(MAX_SPARKS);
  const maxLife = new Float32Array(MAX_SPARKS);
  let cursor = 0;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  // A round, soft sprite drawn once into a canvas - no asset file needed.
  const sprite = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.35, "rgba(255,230,170,0.85)");
    grd.addColorStop(1, "rgba(255,160,60,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // Per-point sizing needs a shader; ShaderMaterial keeps it to one draw call.
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: sprite }, uScale: { value: 320 } },
    vertexShader: `
      uniform float uScale;
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        if (t.a < 0.02) discard;
        gl_FragColor = vec4(vColor * t.rgb, t.a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, sparkMat);
  points.frustumCulled = false;
  scene.add(points);

  /** Throw `count` sparks from a point, biased along a normal. */
  function sparkBurst(at, normal = { x: 0, y: 1, z: 0 }, count = 18, speed = 7, hot = 1) {
    if (!at) return;
    for (let i = 0; i < count; i++) {
      const i3 = cursor * 3;
      positions[i3] = at.x;
      positions[i3 + 1] = at.y;
      positions[i3 + 2] = at.z;

      const spread = 1.15;
      const s = speed * (0.35 + rng.next() * 1.0);
      vel[i3]     = normal.x * s + (rng.next() - 0.5) * s * spread;
      vel[i3 + 1] = Math.abs(normal.y) * s * 0.4 + rng.next() * s * 0.8;
      vel[i3 + 2] = normal.z * s + (rng.next() - 0.5) * s * spread;

      // Hot white-yellow core cooling to orange, scaled by how big the hit was.
      const heat = 0.55 + rng.next() * 0.45;
      colors[i3]     = 1.6 * hot;
      colors[i3 + 1] = (0.75 + heat * 0.5) * hot;
      colors[i3 + 2] = (0.2 + heat * 0.3) * hot;

      sizes[cursor] = (0.6 + rng.next() * 1.5) * hot;
      maxLife[cursor] = 0.25 + rng.next() * 0.5;
      life[cursor] = maxLife[cursor];

      cursor = (cursor + 1) % MAX_SPARKS;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  // ---------------------------------------------------------------- smoke and fire
  // A robot hurt inside smokes from where it hurts (robot_view damageSources):
  // grey puffs that rise, spread and thin out; a battery near the end burns.
  // One pooled Points, normal blending (smoke darkens what is behind it).
  const sPos = new Float32Array(MAX_SMOKE * 3), sVel = new Float32Array(MAX_SMOKE * 3);
  const sCol = new Float32Array(MAX_SMOKE * 3), sSize = new Float32Array(MAX_SMOKE), sAlpha = new Float32Array(MAX_SMOKE);
  const sLife = new Float32Array(MAX_SMOKE), sMax = new Float32Array(MAX_SMOKE), sGrow = new Float32Array(MAX_SMOKE);
  let sCursor = 0;
  for (let i = 0; i < MAX_SMOKE; i++) sPos[i * 3 + 1] = -1000;
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  smokeGeo.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
  smokeGeo.setAttribute("size", new THREE.BufferAttribute(sSize, 1));
  smokeGeo.setAttribute("alpha", new THREE.BufferAttribute(sAlpha, 1));
  const puff = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.5, "rgba(255,255,255,0.45)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: puff }, uScale: { value: 320 } },
    vertexShader: `
      uniform float uScale;
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color; vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        float a = t.a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, a);
      }`,
    transparent: true, depthWrite: false, vertexColors: true,
  });
  const smokePoints = new THREE.Points(smokeGeo, smokeMat);
  smokePoints.frustumCulled = false;
  smokePoints.renderOrder = 2;
  scene.add(smokePoints);

  function emitSmoke(at, { dark = 0.3, size = 0.12, life = 2.2, rise = 0.6 } = {}) {
    const i = sCursor, i3 = i * 3;
    sPos[i3] = at.x + (rng.next() - 0.5) * 0.05;
    sPos[i3 + 1] = at.y;
    sPos[i3 + 2] = at.z + (rng.next() - 0.5) * 0.05;
    sVel[i3] = (rng.next() - 0.5) * 0.25;
    sVel[i3 + 1] = rise * (0.7 + rng.next() * 0.6);
    sVel[i3 + 2] = (rng.next() - 0.5) * 0.25;
    const g = dark + rng.next() * 0.12;
    sCol[i3] = g; sCol[i3 + 1] = g; sCol[i3 + 2] = g * 1.04;
    sSize[i] = size * (0.8 + rng.next() * 0.4);
    sGrow[i] = 0.35 + rng.next() * 0.3;
    sMax[i] = life * (0.8 + rng.next() * 0.4);
    sLife[i] = sMax[i];
    sAlpha[i] = 0;
    sCursor = (sCursor + 1) % MAX_SMOKE;
  }

  /** Flames: short-lived, upward, additive (the spark pool, slowed down). */
  function flame(at) {
    sparkBurst({ x: at.x + (rng.next() - 0.5) * 0.05, y: at.y, z: at.z + (rng.next() - 0.5) * 0.05 }, { x: 0, y: 1, z: 0 }, 1, 1.1, 0.42);
  }

  const emitAcc = new Map();      // robot:key -> puffs owed
  function damageSmoke(dt) {
    if (!robotViews) return;
    for (const [id, view] of robotViews) {
      if (!view.damageSources || view.group?.visible === false) continue;
      for (const src of view.damageSources()) {
        const k = `${id}:${src.key}`;
        let owed = (emitAcc.get(k) || 0) + dt * (4 + 22 * src.rate);
        while (owed >= 1) {
          owed -= 1;
          emitSmoke(src.pos, { dark: src.fire ? 0.12 : 0.42 - src.rate * 0.28, size: 0.1 + src.rate * 0.12, life: 1.6 + src.rate * 1.4 });
          if (src.fire && rng.next() < 0.45) flame(src.pos);
        }
        if (src.sparks && rng.next() < dt * 3) sparkBurst(src.pos, { x: 0, y: 1, z: 0 }, 6, 3, 0.8);
        emitAcc.set(k, owed);
      }
    }
  }

  function updateSmoke(dt) {
    for (let i = 0; i < MAX_SMOKE; i++) {
      if (sLife[i] <= 0) continue;
      sLife[i] -= dt;
      const i3 = i * 3;
      if (sLife[i] <= 0) { sPos[i3 + 1] = -1000; sAlpha[i] = 0; continue; }
      const u = 1 - sLife[i] / sMax[i];        // 0 born .. 1 gone
      sPos[i3] += sVel[i3] * dt; sPos[i3 + 1] += sVel[i3 + 1] * dt; sPos[i3 + 2] += sVel[i3 + 2] * dt;
      sVel[i3 + 1] *= 1 - 0.4 * dt;
      sSize[i] += sGrow[i] * dt;
      sAlpha[i] = Math.min(1, u * 8) * (1 - u) * 0.75;
    }
    smokeGeo.attributes.position.needsUpdate = true;
    smokeGeo.attributes.size.needsUpdate = true;
    smokeGeo.attributes.alpha.needsUpdate = true;
    smokeGeo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- debris meshes
  // Mirrors js/sim/debris.js, same pattern as the hazards: physics owns the
  // transforms, this just draws them.
  const debrisMeshes = new Map();   // id -> mesh
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1);

  function syncDebris() {
    if (!debris) return;
    const live = new Set();
    for (const d of debris.transforms()) {
      live.add(d.id);
      let mesh = debrisMeshes.get(d.id);
      if (!mesh) {
        mesh = new THREE.Mesh(debrisGeo, mats.byName(d.materialName));
        mesh.scale.set(d.size.x, d.size.y, d.size.z);
        mesh.castShadow = true;
        scene.add(mesh);
        debrisMeshes.set(d.id, mesh);
      }
      mesh.position.set(d.pos.x, d.pos.y, d.pos.z);
      mesh.quaternion.set(d.quat.x, d.quat.y, d.quat.z, d.quat.w);
      // Fade out over the last second rather than vanishing.
      const left = d.lifetimeS - d.age;
      mesh.visible = left > 0;
      if (left < 1) mesh.scale.setScalar(Math.max(0.01, left) * Math.min(d.size.x, d.size.y, d.size.z) * 1.0 + 0.0001);
    }
    for (const [id, mesh] of debrisMeshes) {
      if (live.has(id)) continue;
      scene.remove(mesh);
      debrisMeshes.delete(id);
    }
  }

  // ---------------------------------------------------------------- wiring
  const SPARKS_BY_SEVERITY = { scratch: 0, glance: 6, hit: 14, heavy: 30, catastrophic: 55 };

  const offHit = bus.on(EV.HIT, (e) => {
    const n = SPARKS_BY_SEVERITY[e.severity] ?? 8;
    if (n <= 0 || !e.at) return;

    const hot = e.kind === "weapon" ? 1.0 : e.kind === "hazard" ? 0.9 : 0.6;
    const speed = 5 + Math.min(12, (e.deliveredJ || 0) / 1200);
    sparkBurst(e.at, e.normal, n, speed, hot);

    // Dent and darken whatever got hit.
    const view = robotViews.get(e.defenderId);
    if (view) {
      for (const h of e.hits || []) {
        if (h.category === "armor" || h.category === "chassis") {
          const depth = SEVERITY_ORDER[e.severity] >= 3 ? 0.016 : 0.007;
          view.dent(h.key, e.at, depth);
        }
        view.setPanelCondition(h.key, h.conditionAfter);
      }
    }
  });

  const offFail = bus.on(EV.PART_FAILED, (e) => {
    // A part giving way throws real chunks of itself across the arena.
    const materialName = MATERIAL_FOR[e.category] || "ar500_steel";
    debris?.burst({
      at: e.at, normal: e.normal,
      energyJ: 6000, materialName,
      count: e.category === "armor" ? 7 : 4,
      scale: e.category === "armor" ? 0.09 : 0.06,
    });
    sparkBurst(e.at, e.normal, 40, 11, 1.2);

    const view = robotViews.get(e.botId);
    if (view) view.setPanelCondition(e.key, 0);
  });

  const offHazard = bus.on(EV.HAZARD_FIRE, () => { /* reserved for audio */ });

  return {
    points,

    /** Advance sparks and mirror debris. Once per rendered frame. */
    update(dt) {
      let dirty = false;
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const i3 = i * 3;
        if (life[i] <= 0) {
          // Park dead sparks far below the arena rather than branching in the shader.
          positions[i3 + 1] = -1000;
          sizes[i] = 0;
          dirty = true;
          continue;
        }
        vel[i3 + 1] += GRAVITY * dt;
        // Air drag, so they arc and die rather than flying flat.
        const drag = 1 - 2.2 * dt;
        vel[i3] *= drag; vel[i3 + 1] *= drag; vel[i3 + 2] *= drag;

        positions[i3] += vel[i3] * dt;
        positions[i3 + 1] += vel[i3 + 1] * dt;
        positions[i3 + 2] += vel[i3 + 2] * dt;

        // Bounce off the deck once, which looks far better than sinking through.
        if (positions[i3 + 1] < 0.01 && vel[i3 + 1] < 0) {
          positions[i3 + 1] = 0.01;
          vel[i3 + 1] = -vel[i3 + 1] * 0.35;
          vel[i3] *= 0.6; vel[i3 + 2] *= 0.6;
        }

        // Cool and shrink as they die.
        const t = life[i] / maxLife[i];
        const i3c = i * 3;
        colors[i3c + 1] *= 0.985;
        colors[i3c + 2] *= 0.96;
        sizes[i] *= 0.985;
        dirty = true;
        if (t < 0) sizes[i] = 0;
      }
      if (dirty) {
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        geo.attributes.size.needsUpdate = true;
      }
      damageSmoke(dt);
      updateSmoke(dt);
      syncDebris();
    },

    /** Between matches. */
    clear() {
      for (let i = 0; i < MAX_SPARKS; i++) { life[i] = 0; sizes[i] = 0; positions[i * 3 + 1] = -1000; }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.size.needsUpdate = true;
      for (const [, mesh] of debrisMeshes) scene.remove(mesh);
      debrisMeshes.clear();
      for (let i = 0; i < MAX_SMOKE; i++) { sLife[i] = 0; sAlpha[i] = 0; sPos[i * 3 + 1] = -1000; }
      emitAcc.clear();
    },

    dispose() { offHit(); offFail(); offHazard(); scene.remove(points); scene.remove(smokePoints); geo.dispose(); smokeGeo.dispose(); },
  };
}

// Which material a failing part sheds, so debris matches what broke.
const MATERIAL_FOR = {
  armor: "ar500_steel",
  chassis: "ar500_steel",
  wheel: "rubber",
  weapon: "hub",
  weaponMotor: "hub",
  motor: "hub",
  drive: "hub",
  battery: "uhmw",
  electronics: "uhmw",
};
