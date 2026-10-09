// gallery.js - gallery.html: robots ten at a time for design review, drawn
// with the real materials, lighting and robot_view the game uses.
//
// One WebGL context for the whole grid (browsers cap how many a page may
// hold): each cell is its own small scene, drawn into its own scissored
// viewport of the one canvas.

import * as THREE from "three";
import { loadRegistryFromFetch } from "../data/load.js";
import { assembleRobot, assemblePartner } from "../logic/build.js";
import { makeMaterials } from "../render/materials.js";
import { buildRobotView } from "../render/robot_view.js";
import { BODY_STYLE } from "../render/robot_parts.js";
import { previewSim } from "../render/robot_preview.js";
import { addStudioLights } from "../render/preview_stage.js";

const q = new URLSearchParams(location.search);
// ?round=0 draws bodies with the old sharp edges; ?parts=0 draws weapons,
// wheels and fittings plain; ?surface=0 leaves off the surface detail.
// ?compare=1 shows each robot twice, plain parts and detailed, side by side;
// ?compare=surface does the same without and with the surface detail.
const COMPARE = q.get("compare") === "1" ? "parts" : q.get("compare") === "surface" ? "surface" : null;
const COLS = Number(q.get("cols")) || (COMPARE ? 4 : 5);
const ZOOM = Number(q.get("zoom")) || 1;     // ?zoom=2 to look closer
if (q.get("radius")) BODY_STYLE.radius = Number(q.get("radius")) / 1000;   // ?radius=20 (mm)
const statusEl = document.getElementById("status");

try {
  await main();
} catch (e) {
  statusEl.textContent = `failed: ${e.stack || e}`;
  throw e;
}

async function main() {
  const reg = await loadRegistryFromFetch("data");
  const roster = reg.roster().slice().sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const batches = Math.ceil(roster.length / 10);
  const batch = Math.max(1, Math.min(batches, Number(q.get("batch")) || 1));
  const defs = q.get("ids")
    ? q.get("ids").split(",").map((id) => reg.robot(id.trim()))
    : roster.slice((batch - 1) * 10, batch * 10);

  // Batch buttons.
  const bar = document.getElementById("bar");
  for (let b = 1; b <= batches; b++) {
    const btn = document.createElement("button");
    btn.textContent = b;
    btn.title = `robots #${(b - 1) * 10}-${b * 10 - 1}`;
    if (!q.get("ids") && b === batch) btn.className = "on";
    btn.onclick = () => { q.delete("ids"); q.set("batch", b); location.search = q; };
    bar.appendChild(btn);
  }
  const spinBtn = document.createElement("button");
  let spin = q.get("spin") === "1";
  spinBtn.textContent = "spin";
  spinBtn.className = spin ? "on" : "";
  spinBtn.onclick = () => { spin = !spin; spinBtn.className = spin ? "on" : ""; };
  bar.appendChild(spinBtn);
  const compareBtn = document.createElement("button");
  compareBtn.textContent = "before/after";
  compareBtn.className = COMPARE ? "on" : "";
  compareBtn.onclick = () => { if (COMPARE) q.delete("compare"); else q.set("compare", "surface"); location.search = q; };
  bar.appendChild(compareBtn);

  const canvas = document.getElementById("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setScissorTest(true);
  const mats = makeMaterials({ arenaRepeat: 4, style: reg.arena.style });

  const labels = document.getElementById("labels");
  labels.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
  const yaw0 = THREE.MathUtils.degToRad(Number(q.get("yaw") ?? 0));
  const base = { parts: q.get("parts") !== "0", surface: q.get("surface") !== "0" };
  const shots = COMPARE
    ? defs.flatMap((def) => [{ def, ...base, [COMPARE]: false }, { def, ...base, [COMPARE]: true }])
    : defs.map((def) => ({ def, ...base }));
  BODY_STYLE.rounded = q.get("round") !== "0";
  const cells = shots.map(({ def, parts, surface }) => {
    BODY_STYLE.parts = parts;
    BODY_STYLE.surface = surface;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1017);
    addStudioLights(scene);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.85, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const turn = new THREE.Group();
    scene.add(turn);
    const units = [assembleRobot(reg, def)];
    if (def.partner) units.push(assemblePartner(reg, def));
    const views = units.map((a, k) => {
      const v = buildRobotView(turn, a, previewSim(a, { x: 0, z: (k - (units.length - 1) / 2) * 1.1 }), mats);
      v.update();
      v.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return v;
    });
    const sphere = new THREE.Box3().setFromObject(turn).getBoundingSphere(new THREE.Sphere());
    for (const v of views) { v.group.position.x -= sphere.center.x; v.group.position.z -= sphere.center.z; }
    const radius = Math.max(0.35, sphere.radius);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
    turn.rotation.y = yaw0 + 0.25;   // three-quarter front view

    const label = document.createElement("div");
    const on = COMPARE === "parts" ? parts : surface;
    const tagText = COMPARE === "parts" ? (on ? " · detailed" : " · plain") : COMPARE ? (on ? " · surface" : " · plain") : "";
    label.innerHTML = `<b>#${def.number ?? "-"} ${def.name}${tagText}</b><span>${def.inspiredBy ? `nod to ${def.inspiredBy} · ` : ""}${units[0].parts.weapon?.name ?? "no weapon"}</span>`;
    labels.appendChild(label);
    return { scene, camera, turn, views, radius };
  });
  BODY_STYLE.rounded = true;
  BODY_STYLE.parts = true;
  BODY_STYLE.surface = true;
  statusEl.textContent = q.get("ids") ? `${defs.length} robots` : `batch ${batch} of ${batches}: #${(batch - 1) * 10}-${batch * 10 - 1}`;

  const spinning = { omegaRadS: 0, phase: "ready" };
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) renderer.setSize(w, h, false);
    const rows = Math.ceil(cells.length / COLS);
    const cw = w / COLS, ch = h / rows;
    cells.forEach((c, i) => {
      const x = (i % COLS) * cw, y = h - (Math.floor(i / COLS) + 1) * ch;
      if (spin) c.turn.rotation.y += dt * 0.45;
      for (const v of c.views) v.updateWeapon(spinning, dt);
      c.camera.aspect = cw / ch;
      const fit = c.radius / Math.sin(THREE.MathUtils.degToRad(c.camera.fov / 2)) * (c.camera.aspect < 1 ? 1.15 / c.camera.aspect : 0.95);
      const near = fit / ZOOM;
      c.camera.position.set(near * 0.82, near * 0.48 + 0.1, near * 0.55);
      c.camera.lookAt(0, c.radius * 0.2, 0);
      c.camera.updateProjectionMatrix();
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      renderer.render(c.scene, c.camera);
    });
    labels.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__GALLERY__ = { cells, renderer, mats };
}
