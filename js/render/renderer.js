// renderer.js - Three.js renderer, scene and lighting rig.
//
// Reads its lighting setup from arena.json so the look is data-driven too.

import * as THREE from "three";
import { ftToM } from "../core/units.js";

export function makeRenderer(canvas, arena) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Exposure comes from arena.json - it is the first dial to reach for if
  // the arena looks too bright or too dim.
  renderer.toneMappingExposure = arena.lighting.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const L = arena.lighting;
  scene.background = new THREE.Color(L.background);
  // Fog comes from data so the arena's mood is art-directable without code.
  const fog = L.fog || { color: L.background, near: 40, far: 120 };
  scene.fog = new THREE.Fog(new THREE.Color(fog.color).getHex(), ftToM(fog.near), ftToM(fog.far));

  scene.add(new THREE.AmbientLight(new THREE.Color(L.ambient.color), L.ambient.intensity));

  // Key light casts the shadows. Its frustum is sized to the arena so the
  // shadow map is not wasted on empty space.
  const key = new THREE.DirectionalLight(new THREE.Color(L.key.color), L.key.intensity);
  key.position.set(...ftToMArr(L.key.pos));
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const span = ftToM(arena.floor.size[0]) * 0.72;
  Object.assign(key.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 120 });
  // Changing an orthographic frustum has no effect until the projection
  // matrix is rebuilt - without this the shadow map covers the default
  // +/-5 unit box and most of the arena casts nothing.
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const fill = new THREE.DirectionalLight(new THREE.Color(L.fill.color), L.fill.intensity);
  fill.position.set(...ftToMArr(L.fill.pos));
  scene.add(fill);

  // Overhead rigs, for the TV-studio look and specular highlights on armour.
  for (const r of L.rigs || []) {
    const p = new THREE.PointLight(new THREE.Color(r.color), r.intensity, ftToM(r.distance), 2);
    p.position.set(...ftToMArr(r.pos));
    scene.add(p);
  }

  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    return { w, h, aspect: w / h };
  }

  return { renderer, scene, keyLight: key, resize, THREE };
}

const ftToMArr = (a) => [ftToM(a[0]), ftToM(a[1]), ftToM(a[2])];
