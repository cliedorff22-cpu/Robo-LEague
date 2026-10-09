// preview_stage.js - a small turntable that shows one robot (or both halves
// of a multibot) in the menus.
//
// The only menu file that needs a GPU, so the headless menu check swaps it for
// a stub (tools/menu-check.sh), the way boot-check swaps renderer.js.

import * as THREE from "three";
import { buildRobotView } from "./robot_view.js";
import { previewSim } from "./robot_preview.js";

/**
 * A three-point studio rig for showing robots off, used by the menus and the
 * gallery. The camera sits front-right of the robot (+X +Z), so the key comes
 * from above its right shoulder, a cool fill from the left, and a rim from
 * behind to pick the silhouette out of the dark.
 *
 * Intensities are physical (Three r155+): the old 2.2 key read as dim, and
 * the warm rim ended up doing most of the lighting - black paint went brown.
 */
export function addStudioLights(scene) {
  scene.add(new THREE.HemisphereLight(0xe6eeff, 0x202430, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.position.set(3, 5, 1.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.01;
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 14 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8dcff, 1.6);
  fill.position.set(0.5, 2.2, 4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xe8eeff, 1.8);
  rim.position.set(-3.5, 2.5, -2.5);
  scene.add(rim);
  return { key, fill, rim };
}

/**
 * @param canvas  the canvas to draw into; sized by CSS
 * @param mats    from makeMaterials()
 * @param opts.spin         turn on its own (default true)
 * @param opts.interactive  drag to turn it, click to pick parts (the workshop)
 * @param opts.angle        starting turn, radians
 */
export function makePreviewStage(canvas, mats, opts = {}) {
  const autoSpin = opts.spin !== false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  addStudioLights(scene);

  // The turntable: a dark disc with a yellow ring, like a corner pad.
  const table = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.25, 1.3, 0.04, 64),
    new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.85, metalness: 0.1 }),
  );
  disc.position.y = -0.02;
  disc.receiveShadow = true;
  table.add(disc);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.26, 0.012, 8, 96),
    new THREE.MeshStandardMaterial({ color: 0xf0c419, emissive: 0x6a5208, roughness: 0.4 }),
  );
  ring.rotation.x = Math.PI / 2;
  table.add(ring);
  scene.add(table);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
  const turn = new THREE.Group();      // the robots ride on this
  scene.add(turn);
  let views = [];
  let angle = opts.angle ?? -0.6;
  let radius = 1;
  const spinning = { omegaRadS: 16, phase: "ready" };
  const frameHooks = [];
  const snaps = [];               // { obj, base, t } - parts dropping into place
  let highlight = [];             // overlay meshes on the highlighted part
  const glow = new THREE.MeshBasicMaterial({ color: 0xf0c419, transparent: true, opacity: 0.32, depthWrite: false });

  function clear() {
    clearHighlight();
    snaps.length = 0;
    for (const v of views) v.dispose();
    views = [];
  }
  function clearHighlight() {
    for (const m of highlight) m.parent?.remove(m);
    highlight = [];
  }

  // Drag to turn (the workshop); a click that did not drag picks a part.
  let drag = null;
  if (opts.interactive) {
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, moved: 0 }; canvas.setPointerCapture?.(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      drag.x = e.clientX; drag.moved += Math.abs(dx);
      angle += dx * 0.012;
    });
    canvas.addEventListener("pointerup", (e) => {
      const wasClick = drag && drag.moved < 4;
      drag = null;
      if (wasClick) opts.onPick?.(pickAt(e.clientX, e.clientY));
    });
  }
  const ray = new THREE.Raycaster();
  function pickAt(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(views.map((v) => v.group), true).find((h) => h.object.userData.partKey);
    return hit ? hit.object.userData.partKey : null;
  }

  function frame() {
    const w = canvas.clientWidth || 400, h = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;
    // Back the camera off until the whole robot fits, whatever its size.
    const fit = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.aspect < 1 ? 1.25 / camera.aspect : 1.05);
    camera.position.set(fit * 0.82, fit * 0.42 + 0.1, fit * 0.55);
    camera.lookAt(0, radius * 0.25, 0);
    camera.updateProjectionMatrix();
  }

  return {
    /** Show these assembled units (one robot, or a multibot's pair). */
    show(units) {
      clear();
      const spacing = units.length > 1 ? 0.55 : 0;
      units.forEach((a, k) => {
        const sim = previewSim(a, { x: 0, z: (k - (units.length - 1) / 2) * spacing * 2 });
        const view = buildRobotView(turn, a, sim, mats);
        view.update();
        // Show the damage it carries (the Stage 7 pit): worn parts darken,
        // destroyed ones are gone - the same as in the arena.
        view.applyCondition(a.condition || {});
        view.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        views.push(view);
      });
      // Frame on the bounding sphere of everything shown.
      const box = new THREE.Box3().setFromObject(turn);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      radius = Math.max(0.35, sphere.radius);
      // The turntable spins about the robot's middle, not its body origin -
      // a long bar or wedge would otherwise swing round off-centre.
      for (const v of views) {
        v.group.position.x -= sphere.center.x;
        v.group.position.z -= sphere.center.z;
      }
    },

    /** Advance the turntable and draw. Call once per animation frame. */
    tick(dt) {
      if (autoSpin && !drag) angle += dt * 0.45;
      turn.rotation.y = angle;
      for (const v of views) v.updateWeapon(spinning, dt);
      // Parts snapping in: drop from above, overshoot a touch, settle.
      for (let i = snaps.length - 1; i >= 0; i--) {
        const sn = snaps[i];
        sn.t += dt / 0.42;
        const k = Math.min(1, sn.t);
        const ease = 1 - Math.pow(1 - k, 3);
        const bounce = Math.sin(k * Math.PI) * 0.06 * (1 - k);
        sn.obj.position.y = sn.base.y + (1 - ease) * 0.32 - bounce;
        sn.obj.scale.setScalar(1 + (1 - ease) * 0.12);
        if (k >= 1) { sn.obj.position.copy(sn.base); sn.obj.scale.setScalar(1); snaps.splice(i, 1); }
      }
      frame();
      renderer.render(scene, camera);
      for (const f of frameHooks) f();
    },

    /** Call `fn` after every frame (the workshop moves its hotspot labels). */
    onFrame(fn) { frameHooks.push(fn); },

    /**
     * Where a point in the (first) robot's own frame is on the canvas, in CSS
     * pixels, and whether it faces the camera.
     */
    project(p) {
      const v = views[0];
      if (!v) return null;
      const w = v.group.localToWorld(new THREE.Vector3(p.x, p.y, p.z));
      const c = w.clone().project(camera);
      // Facing us if the way out from the robot's middle points at the camera.
      const out = w.clone().sub(v.group.localToWorld(new THREE.Vector3(0, 0, 0)));
      const front = out.dot(camera.position.clone().sub(w)) > -0.02;
      return { x: (c.x + 1) / 2 * canvas.clientWidth, y: (1 - c.y) / 2 * canvas.clientHeight, front };
    },

    /** Drop these parts ("weapon", "wheel", "chassis", "armor.N") into place. */
    snap(keys) {
      for (const v of views) {
        for (const key of keys) {
          const objs = key === "all" ? [v.group] : v.partObjects?.get(key) || [];
          for (const obj of objs) snaps.push({ obj, base: obj.position.clone(), t: 0 });
        }
      }
    },

    /** Outline one part in the accent colour (null clears it). */
    highlight(key) {
      clearHighlight();
      if (!key) return;
      for (const v of views) {
        // Collect first: adding the overlays while traversing would visit them too.
        const meshes = [];
        for (const obj of v.partObjects?.get(key) || []) obj.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
        for (const o of meshes) {
          const m = new THREE.Mesh(o.geometry, glow);
          m.scale.setScalar(1.015);
          m.renderOrder = 5;
          o.add(m);
          highlight.push(m);
        }
      }
    },

    dispose() {
      clear();
      renderer.dispose();
    },
  };
}
