// robot_parts.js - the detailed geometry a robot is dressed in: tyres and
// hubs, spinner bars with impactors, toothed discs, drums, shells, hammer
// heads, flipper plates, forks and beaks.
//
// Every builder works in the frame robot_view.js animates. A rotor is built
// to spin about its local Y; an arm reaches along +X from its pivot and
// strikes towards -Y. Sizes come from the same numbers shape.js gives the
// colliders, and the detail stays inside them - a tooth never reaches past
// the radius physics uses.
//
// Builders return [{ geo, mat }] where `mat` is a key robot_view resolves:
// "steel" (polished weapon steel), "hub", "dark", "accent", "paint", "trim".

import * as THREE from "three";
import { convexHull } from "../core/hull.js";
import { roundedHull } from "../core/rounded_hull.js";
import { MOBILE } from "../core/platform.js";
import { atlasUV } from "./livery.js";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- body hulls

/**
 * A convex hull as a flat-shaded BufferGeometry, with UVs.
 * @param bounds  body bounds: UVs index the livery atlas (js/render/livery.js).
 *                Without, UVs are world metres on the dominant plane, for
 *                tiling materials like steel.
 */
/**
 * How a robot is drawn. `rounded` softens every edge and corner of the body
 * pieces (js/core/rounded_hull.js) to `radius` metres - smaller on thin
 * plates. `parts` does the same for the weapons, wheels and fittings:
 * multi-step bevels, rounded blocks and rims, more segments on round parts
 * (fewer on the phone build). `surface` gives the paint job depth and
 * sheen - seams cut in, bolts and scrapes that shine like bare steel,
 * chipped edges - and the steel parts a machined finish.
 * gallery.html?compare=surface shows it beside the plain paint;
 * ?compare=1 compares plain and detailed parts.
 */
export const BODY_STYLE = { rounded: true, radius: 0.022, parts: true, surface: true };

/** Segments for a round part: more on desktop when parts are detailed. */
const seg = (n) => (BODY_STYLE.parts && !MOBILE ? Math.round(n * 1.5) : n);

export function hullGeometry(points, bounds = null) {
  if (BODY_STYLE.rounded) {
    const g = roundedGeometry(points, bounds);
    if (g) return g;
  }
  const { points: pts, triangles } = convexHull(points);
  const pos = new Float32Array(triangles.length * 9);
  const uv = new Float32Array(triangles.length * 6);
  const n = { x: 0, y: 0, z: 0 };
  triangles.forEach(([a, b, c], t) => {
    const A = pts[a], B = pts[b], C = pts[c];
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    n.x = uy * vz - uz * vy; n.y = uz * vx - ux * vz; n.z = ux * vy - uy * vx;
    const l = Math.hypot(n.x, n.y, n.z) || 1;
    n.x /= l; n.y /= l; n.z /= l;
    [A, B, C].forEach((P, k) => {
      pos.set([P.x, P.y, P.z], t * 9 + k * 3);
      let u, v;
      if (bounds) [u, v] = atlasUV(P, n, bounds);
      else if (Math.abs(n.y) >= Math.max(Math.abs(n.x), Math.abs(n.z))) { u = P.x * 2; v = P.z * 2; }
      else if (Math.abs(n.z) >= Math.abs(n.x)) { u = P.x * 2; v = P.y * 2; }
      else { u = P.z * 2; v = P.y * 2; }
      uv.set([u, v], t * 6 + k * 2);
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** The rounded body piece, smooth-shaded; null if it cannot be rounded. */
function roundedGeometry(points, bounds) {
  const rh = roundedHull(points, { radius: BODY_STYLE.radius, step: MOBILE ? Math.PI / 4 : Math.PI / 6 });
  if (!rh) return null;
  const pos = new Float32Array(rh.positions), nrm = new Float32Array(rh.normals);
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let t = 0; t < pos.length / 9; t++) {
    // The paint panel (or tiling plane) is picked once per triangle, by its
    // own facing, so no triangle straddles two panels of the atlas.
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const n = { x: nx / l, y: ny / l, z: nz / l };
    for (let k = 0; k < 3; k++) {
      const P = { x: pos[o + k * 3], y: pos[o + k * 3 + 1], z: pos[o + k * 3 + 2] };
      let u, v;
      if (bounds) [u, v] = atlasUV(P, n, bounds);
      else if (Math.abs(n.y) >= Math.max(Math.abs(n.x), Math.abs(n.z))) { u = P.x * 2; v = P.z * 2; }
      else if (Math.abs(n.z) >= Math.abs(n.x)) { u = P.x * 2; v = P.y * 2; }
      else { u = P.z * 2; v = P.y * 2; }
      uv[t * 6 + k * 2] = u; uv[t * 6 + k * 2 + 1] = v;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.userData.rounded = true;
  return g;
}

/**
 * Smooth normals that keep hard creases: each corner of a triangle averages
 * the triangles meeting at that point that face within `crease` of it,
 * weighted by area. For re-shading a rounded piece after it is dented
 * (computeVertexNormals on unindexed triangles would make it faceted again).
 */
export function creasedNormals(g, crease = 0.7) {
  const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
  const tris = pos.length / 9, cosC = Math.cos(crease);
  const face = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    face[t * 3] = uy * vz - uz * vy; face[t * 3 + 1] = uz * vx - ux * vz; face[t * 3 + 2] = ux * vy - uy * vx;
  }
  const unit = (t) => {
    const x = face[t * 3], y = face[t * 3 + 1], z = face[t * 3 + 2], l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  const at = new Map();
  const key = (i) => `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
  for (let i = 0; i < tris * 3; i++) {
    const k = key(i);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(Math.floor(i / 3));
  }
  for (let i = 0; i < tris * 3; i++) {
    const own = unit(Math.floor(i / 3));
    let x = 0, y = 0, z = 0;
    for (const t of at.get(key(i))) {
      const u = unit(t);
      if (u[0] * own[0] + u[1] * own[1] + u[2] * own[2] < cosC) continue;
      x += face[t * 3]; y += face[t * 3 + 1]; z += face[t * 3 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
  }
  g.attributes.normal.needsUpdate = true;
}

/** Concatenate geometries (position, normal, uv) into one non-indexed one. */
export function mergeGeometries(list) {
  const parts = list.filter(Boolean).map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    if (!x.attributes.normal) x.computeVertexNormals();
    return x;
  });
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    pos.set(p.attributes.position.array.subarray(0, c * 3), o * 3);
    nrm.set(p.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Extrude a 2D shape `depth` thick, centred on z = 0, with a small bevel.
 * Detailed parts get a rounder bevel that eats into the outline rather than
 * growing out of it, so a tooth still never reaches past its collider.
 */
function extrude(shape, depth, bevel = 0.003, curveSegments = 12) {
  const fine = BODY_STYLE.parts;
  const bev = Math.min(fine ? bevel * 2 : bevel, depth * 0.3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - 2 * bev), bevelEnabled: bev > 0,
    bevelThickness: bev, bevelSize: bev, bevelOffset: fine ? -bev : 0,
    bevelSegments: fine ? (MOBILE ? 2 : 3) : 1, curveSegments: seg(curveSegments),
  });
  g.translate(0, 0, -(depth - 2 * bev) / 2);
  return g;
}

/** A w x h x d block centred on the origin - corners rounded on detailed parts. */
export function box(w, h, d) {
  if (BODY_STYLE.parts) {
    const pts = [];
    for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) pts.push({ x, y, z });
    const rh = roundedHull(pts, { radius: 0.006, step: MOBILE ? Math.PI / 4 : Math.PI / 6 });
    if (rh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rh.positions), 3));
      g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(rh.normals), 3));
      // Tiling UVs on the dominant plane, as the plain hulls get.
      const pos = rh.positions, uv = new Float32Array((pos.length / 3) * 2);
      for (let i = 0; i < pos.length / 3; i++) {
        const nx = Math.abs(rh.normals[i * 3]), ny = Math.abs(rh.normals[i * 3 + 1]), nz = Math.abs(rh.normals[i * 3 + 2]);
        const [a, b] = ny >= Math.max(nx, nz) ? [0, 2] : nz >= nx ? [0, 1] : [2, 1];
        uv[i * 2] = pos[i * 3 + a] * 2; uv[i * 2 + 1] = pos[i * 3 + b] * 2;
      }
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      return g;
    }
  }
  return new THREE.BoxGeometry(w, h, d);
}

/**
 * A cylinder about Y, centred on the origin, like THREE.CylinderGeometry -
 * on detailed parts its rims are rounded over instead of knife-sharp.
 */
export function cyl(rTop, rBot, h, n) {
  if (!BODY_STYLE.parts) return new THREE.CylinderGeometry(rTop, rBot, h, n);
  const e = Math.min(0.006, h * 0.25, Math.min(rTop, rBot) * 0.25);
  const steps = MOBILE ? 2 : 4;
  const prof = [new THREE.Vector2(0, -h / 2)];
  const rim = (cx, cy, a0) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      prof.push(new THREE.Vector2(cx + Math.cos(a) * e, cy + Math.sin(a) * e));
    }
  };
  rim(rBot - e, -h / 2 + e, -Math.PI / 2);
  rim(rTop - e, h / 2 - e, 0);
  prof.push(new THREE.Vector2(0, h / 2));
  return new THREE.LatheGeometry(prof, seg(n));
}

const poly = (pts) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));

/** A ring of bolt heads facing +Y (or -Y), radius `rad` about the Y axis. */
function boltRing(n, rad, y, head, up = 1, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const b = new THREE.CylinderGeometry(head, head, head * 0.9, 6);
    b.translate(Math.cos(a) * rad, y + up * head * 0.45, Math.sin(a) * rad);
    out.push(b);
  }
  return mergeGeometries(out);
}

// ---------------------------------------------------------------- wheels

/**
 * A tyre with rounded shoulders on a hub with five spokes, axle along Z.
 * @returns {{ tyre, hub, spokes, cap }} geometries shared by every wheel
 */
export function wheelGeometries(r, w) {
  const ri = r * 0.62, c = Math.min(w * 0.32, r * 0.24);
  const prof = [new THREE.Vector2(ri, -w / 2 * 0.94)];
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2);
    prof.push(new THREE.Vector2(r - c + Math.cos(a) * c, -w / 2 + c + Math.sin(a) * c));
  }
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    prof.push(new THREE.Vector2(r - c + Math.cos(a) * c, w / 2 - c + Math.sin(a) * c));
  }
  prof.push(new THREE.Vector2(ri, w / 2 * 0.94));
  const tyre = new THREE.LatheGeometry(prof, seg(32));
  tyre.rotateX(Math.PI / 2);

  const hub = cyl(ri * 1.01, ri * 1.01, w * 0.84, 24);
  hub.rotateX(Math.PI / 2);

  const spokes = [], caps = [];
  for (const s of [-1, 1]) {
    const z = s * (w * 0.42 + 0.002);
    for (let k = 0; k < 5; k++) {
      const b = new THREE.BoxGeometry(ri * 0.82, ri * 0.2, 0.006);   // too thin to show a round
      b.translate(ri * 0.41, 0, z);
      b.rotateZ((k / 5) * TAU);
      spokes.push(b);
    }
    const ring = new THREE.TorusGeometry(ri * 0.9, ri * 0.07, BODY_STYLE.parts ? 8 : 4, seg(24));
    ring.translate(0, 0, z);
    spokes.push(ring);
    const cap = new THREE.CylinderGeometry(ri * 0.26, ri * 0.3, 0.014, 6);
    cap.rotateX(Math.PI / 2);
    cap.translate(0, 0, s * (w * 0.42 + 0.007));
    caps.push(cap);
  }
  return { tyre, hub, spokes: mergeGeometries(spokes), cap: mergeGeometries(caps) };
}

// ---------------------------------------------------------------- rotors

/**
 * A spinner bar: a flat bar with a hardened impactor hooked out of each end,
 * on a hub boss. Lies along X, spins about Y.
 */
export function barRotor(r, t, b) {
  const h = b / 2, p = b * 0.34, c = b * 0.5;
  const shape = poly([
    [r - c, -h], [r, -h + c * 0.6], [r, h], [r - b * 0.55, h + p], [r - b * 1.25, h + p * 0.2], [r - b * 1.6, h],
    [-r + c, h], [-r, h - c * 0.6], [-r, -h], [-r + b * 0.55, -h - p], [-r + b * 1.25, -h - p * 0.2], [-r + b * 1.6, -h],
  ]);
  const bar = extrude(shape, t, Math.min(0.004, t * 0.15));
  bar.rotateX(-Math.PI / 2);
  // Impactor inserts: a darker hardened block on each tooth.
  const inserts = [];
  for (const s of [-1, 1]) {
    const ins = box(b * 0.5, t * 1.04, p * 0.9);
    ins.translate(s * (r - b * 0.62), 0, -s * (h + p * 0.45));
    inserts.push(ins);
  }
  const hubR = Math.min(b * 0.85, r * 0.3);
  const hub = cyl(hubR, hubR * 1.05, t * 1.5, 20);
  return [
    { geo: bar, mat: "steel" },
    { geo: mergeGeometries(inserts), mat: "dark" },
    { geo: hub, mat: "hub" },
    { geo: boltRing(4, hubR * 0.6, t * 0.75, Math.max(0.005, hubR * 0.12)), mat: "dark" },
  ];
}

/**
 * A disc with hooked teeth and lightening holes, in the XZ plane.
 * @param teeth  number of teeth; `fine` makes it a saw blade
 */
export function discRotor(r, t, teeth = 2, { fine = false } = {}) {
  const rin = fine ? r * 0.9 : r * 0.82;
  const lead = fine ? 0.02 : 0.05;
  const span = fine ? (TAU / teeth) * 0.95 : Math.min(1.1, (TAU / teeth) * 0.5);
  const N = fine ? Math.max(96, teeth * 6) : 160;
  const radiusAt = (th) => {
    let best = rin;
    for (let i = 0; i < teeth; i++) {
      const phi = (((th - (i / teeth) * TAU) % TAU) + TAU) % TAU;
      let v = rin;
      if (phi < lead) v = rin + (r - rin) * (phi / lead);
      else if (phi < span) v = r - (r - rin) * Math.pow((phi - lead) / (span - lead), 0.7);
      best = Math.max(best, v);
    }
    return best;
  };
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU;
    const rr = radiusAt(th);
    pts.push([Math.cos(th) * rr, Math.sin(th) * rr]);
  }
  const shape = poly(pts);
  if (!fine && r > 0.12) {
    const k = 3;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU + 0.5;
      const hole = new THREE.Path();
      hole.absarc(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, r * 0.14, 0, TAU, true);
      shape.holes.push(hole);
    }
  }
  const disc = extrude(shape, Math.max(0.012, t), 0.002, 16);
  disc.rotateX(-Math.PI / 2);
  const hubR = Math.max(0.025, r * 0.2);
  const hub = cyl(hubR, hubR, Math.max(0.012, t) * 1.8 + 0.01, 20);
  // The hardened teeth, picked out darker.
  const tips = [];
  if (!fine) {
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * TAU + lead * 1.5;
      const tip = box((r - rin) * 1.2, Math.max(0.012, t) * 1.06, (r - rin) * 0.9);
      tip.translate(r - (r - rin) * 0.62, 0, 0);
      tip.rotateY(-a);
      tips.push(tip);
    }
  }
  return [
    { geo: disc, mat: fine ? "saw" : "steel" },
    ...(tips.length ? [{ geo: mergeGeometries(tips), mat: "dark" }] : []),
    { geo: hub, mat: "hub" },
    { geo: boltRing(5, hubR * 0.62, (Math.max(0.012, t) * 1.8 + 0.01) / 2, Math.max(0.004, hubR * 0.13)), mat: "dark" },
  ];
}

/** A drum: a heavy steel tube with staggered rows of teeth, axis Y. */
export function drumRotor(r, len, { rows: rowsIn, perRow = 2 } = {}) {
  const core = cyl(r * 0.76, r * 0.76, len * 0.94, 28);
  const flanges = [];
  for (const s of [-1, 1]) {
    const f = cyl(r * 0.82, r * 0.82, len * 0.04, 28);
    f.translate(0, s * len * 0.48, 0);
    flanges.push(f);
    flanges.push(boltRing(6, r * 0.5, s * len * 0.5, r * 0.06, s));
  }
  const rows = rowsIn ?? Math.max(2, Math.min(5, Math.round(len / (r * 1.25))));
  const teeth = [];
  const tw = r * 0.42, h = r * 0.27, tl = Math.min((len * 0.9) / rows * 0.62, r * 0.75);
  const prof = poly([[0, -tw / 2], [h * 0.75, -tw * 0.3], [h, tw * 0.05], [h, tw * 0.5], [0, tw / 2]]);
  for (let row = 0; row < rows; row++) {
    const y = -len * 0.45 + (len * 0.9 * (row + 0.5)) / rows;
    for (let k = 0; k < perRow; k++) {
      const a = (k / perRow) * TAU + (row % 2) * (Math.PI / perRow);
      const tooth = extrude(prof, tl, 0.003);
      const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const tang = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const m = new THREE.Matrix4().makeBasis(radial, tang, new THREE.Vector3(0, 1, 0));
      m.setPosition(radial.clone().multiplyScalar(r * 0.73).add(new THREE.Vector3(0, y, 0)));
      tooth.applyMatrix4(m);
      teeth.push(tooth);
    }
  }
  const shaft = cyl(r * 0.2, r * 0.2, len * 1.04, 12);
  return [
    { geo: core, mat: "steel" },
    { geo: mergeGeometries(flanges), mat: "dark" },
    { geo: mergeGeometries(teeth), mat: "dark" },
    { geo: shaft, mat: "hub" },
  ];
}

/** An eggbeater: two flat hoops crossed on the axle, axis Y, `len` long. */
export function eggbeaterRotor(r, len) {
  const hoops = [];
  const ring = new THREE.Shape();
  ring.absellipse(0, 0, r, len * 0.46, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, r * 0.74, len * 0.46 - r * 0.26, 0, TAU, true);
  ring.holes.push(hole);
  for (const a of [0, Math.PI / 2]) {
    const g = extrude(ring, r * 0.3, 0.003, 28);
    g.rotateY(a);
    hoops.push(g);
  }
  // Hardened tips where the hoops bite.
  const tips = [];
  for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const t = box(r * 0.3, len * 0.2, r * 0.36);
    t.translate(r * 0.88, 0, 0);
    t.rotateY(a);
    tips.push(t);
  }
  const shaft = cyl(r * 0.16, r * 0.16, len * 1.02, 12);
  return [
    { geo: mergeGeometries(hoops), mat: "steel" },
    { geo: mergeGeometries(tips), mat: "dark" },
    { geo: shaft, mat: "hub" },
  ];
}

/**
 * A full-body shell, axis Y, from `h/2` below the hub up over the whole robot.
 * `profile`: "dome" | "drum" | "cone" | "bowl" | "saucer" - the silhouette.
 * `topY` is the top of the shell above the hub, and `bodyRadius(y)` the body
 * radius at height y: the shell never cuts into the body it covers. The
 * painted shell is in the robot's colour, with a steel skirt carrying the
 * teeth at the rim, where the hits land.
 */
export function shellRotor(r, h, { profile = "dome", teeth = 2, topY = h / 2, bodyRadius = () => 0 } = {}) {
  const wr = r * 0.94;
  const bot = -h / 2, top = Math.max(topY, h / 2);
  const shapeAt = {
    dome: (s) => (s < 0.35 ? 1 : Math.sqrt(Math.max(0, 1 - ((s - 0.35) / 0.65) ** 2))),
    cone: (s) => (s < 0.3 ? 1 : 1 - 0.72 * ((s - 0.3) / 0.7)),
    drum: (s) => (s < 0.86 ? 1 : 1 - 0.1 * ((s - 0.86) / 0.14)),
    bowl: (s) => (s < 0.28 ? 1 : 1 - 0.42 * ((s - 0.28) / 0.72) ** 0.6),
    saucer: (s) => (s < 0.15 ? 1 : 1 - 0.75 * ((s - 0.15) / 0.85) ** 1.4),
  }[profile] || ((s) => 1);
  const N = 20;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const sN = i / N, y = bot + (top - bot) * sN;
    // Out to the full weapon radius where the body needs the room.
    const rad = Math.min(r * 0.99, Math.max(shapeAt(sN) * wr, bodyRadius(y) + 0.012));
    pts.push(new THREE.Vector2(Math.max(0.001, rad), y));
  }
  // Close the top: a flat cap in from the last ring.
  pts.push(new THREE.Vector2(0.001, top));
  // The skirt is the lower third, in steel.
  const cut = Math.max(2, Math.round(N * 0.3));
  const skirt = new THREE.LatheGeometry([new THREE.Vector2(wr * 0.9, bot), ...pts.slice(0, cut + 1)], seg(48));
  const shell = new THREE.LatheGeometry(pts.slice(cut), seg(48));
  const tooth = [];
  const tw = r * 0.3, th = Math.min(h * 0.4, r * 0.25);
  const ty = bot + h * 0.2;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    const prof2 = poly([[0, -tw / 2], [r - wr + r * 0.06, -tw * 0.2], [r - wr + r * 0.06, tw * 0.5], [0, tw / 2]]);
    const t = extrude(prof2, th, 0.003);
    const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const tang = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    t.applyMatrix4(new THREE.Matrix4().makeBasis(radial, tang, new THREE.Vector3(0, 1, 0))
      .setPosition(radial.clone().multiplyScalar(Math.max(wr, pts[2].x) - r * 0.06).add(new THREE.Vector3(0, ty, 0))));
    tooth.push(t);
  }
  // A hub cap and bolt ring on top.
  const capR = Math.max(0.03, r * 0.14);
  const cap = cyl(capR, capR * 1.15, 0.022, 20);
  cap.translate(0, top + 0.008, 0);
  // A painted band round the shell, in the accent colour.
  const bandY = bot + (top - bot) * 0.42;
  const bandR = Math.min(r * 0.99, Math.max(shapeAt(0.42) * wr, bodyRadius(bandY) + 0.012)) + 0.002;
  const band = new THREE.CylinderGeometry(bandR, bandR, Math.max(0.012, (top - bot) * 0.06), seg(48), 1, true);
  band.translate(0, bandY, 0);
  return [
    { geo: shell, mat: "paintFlat" },
    { geo: skirt, mat: "steel" },
    { geo: band, mat: "accent" },
    { geo: mergeGeometries(tooth), mat: "dark" },
    { geo: cap, mat: "hub" },
    { geo: boltRing(6, capR * 0.65, top + 0.019, 0.006), mat: "dark" },
  ];
}

/** Three arms with a hammer block on each - the meat tenderiser. */
export function triRotor(r, t) {
  const arms = [], heads = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const arm = extrude(poly([[0, -r * 0.1], [r * 0.85, -r * 0.06], [r * 0.85, r * 0.06], [0, r * 0.1]]), t * 0.5, 0.003);
    arm.rotateX(-Math.PI / 2);
    arm.rotateY(-a);
    arms.push(arm);
    const head = extrude(poly([[-r * 0.13, -r * 0.16], [r * 0.13, -r * 0.13], [r * 0.15, r * 0.13], [-r * 0.13, r * 0.16]]), t * 1.1, 0.005);
    head.rotateX(-Math.PI / 2);
    head.translate(r * 0.86, 0, 0);
    head.rotateY(-a);
    heads.push(head);
  }
  const hub = cyl(r * 0.2, r * 0.22, t * 1.2, 20);
  return [
    { geo: mergeGeometries(arms), mat: "steel" },
    { geo: mergeGeometries(heads), mat: "dark" },
    { geo: hub, mat: "hub" },
    { geo: boltRing(3, r * 0.12, t * 0.6, 0.007), mat: "dark" },
  ];
}

// ---------------------------------------------------------------- arms

/**
 * A hammer or axe arm, pivot at the origin, reaching along +X, striking -Y.
 * @param head  { l, h, w } of the head, from shape.js
 */
export function armParts(reach, head, style) {
  const tube = cyl(0.02, 0.026, reach, 12);
  tube.rotateZ(Math.PI / 2);
  tube.translate(reach / 2, 0, 0);
  // Twin side plates at the root, where the arm takes its load.
  const cheeks = [];
  for (const s of [-1, 1]) {
    const c = extrude(poly([[-0.04, -0.035], [reach * 0.35, -0.02], [reach * 0.35, 0.02], [-0.04, 0.04]]), 0.01, 0.002);
    c.translate(0, 0, s * 0.032);
    cheeks.push(c);
  }
  const boss = cyl(0.045, 0.045, 0.1, 18);
  boss.rotateX(Math.PI / 2);
  const out = [
    { geo: tube, mat: "steel" },
    { geo: mergeGeometries(cheeks), mat: "trim" },
    { geo: boss, mat: "hub" },
  ];
  const { l, h, w } = head;
  if (style === "saw") {
    const saw = discRotor(l * 1.4, 0.006, 36, { fine: true });
    for (const p of saw) { p.geo.rotateX(Math.PI / 2); p.geo.translate(reach, 0, 0); }
    // A guard over the top of the blade.
    const guard = new THREE.CylinderGeometry(l * 1.5, l * 1.5, 0.04, seg(24), 1, true, -Math.PI * 0.05, Math.PI * 0.6);
    guard.rotateX(Math.PI / 2);
    guard.rotateZ(-Math.PI / 2);
    guard.translate(reach, 0, 0);
    out.push(...saw, { geo: guard, mat: "trim" });
  } else if (style === "spike") {
    const mount = box(l * 0.5, h * 0.4, Math.min(w, 0.08));
    mount.translate(reach, 0, 0);
    const spike = new THREE.ConeGeometry(h * 0.32, h * 1.3, BODY_STYLE.parts ? 16 : 8);
    spike.rotateZ(Math.PI);
    spike.translate(reach, -h * 0.85, 0);
    out.push({ geo: mount, mat: "dark" }, { geo: spike, mat: "steel" });
  } else if (style === "sledge" || style === "hammer") {
    const block = extrude(poly([[-l / 2, -h * 0.6], [l / 2, -h * 0.6], [l / 2, h * 0.4], [-l / 2, h * 0.4]]), w, 0.012);
    block.translate(reach, 0, 0);
    const face = box(l * 0.92, 0.02, w * 0.92);
    face.translate(reach, -h * 0.6 - 0.008, 0);
    out.push({ geo: block, mat: "dark" }, { geo: face, mat: "steel" });
  } else {
    // Axe: a pole on top, a broad blade fanning down to its edge.
    const blade = extrude(poly([
      [-l * 0.3, h * 0.25], [l * 0.3, h * 0.25], [l * 0.55, -h * 0.7], [l * 0.3, -h * 0.95], [0, -h * 1.02], [-l * 0.3, -h * 0.95], [-l * 0.55, -h * 0.7],
    ]), Math.min(0.035, w * 0.4), 0.004);
    blade.translate(reach, 0, 0);
    const pole = box(l * 0.5, h * 0.35, Math.min(w, 0.09));
    pole.translate(reach, h * 0.2, 0);
    out.push({ geo: blade, mat: "steel" }, { geo: pole, mat: "dark" });
  }
  return out;
}

// ---------------------------------------------------------------- plates, forks, jaws

/** A flipper plate: knife-edged at the front, hinge barrel at the back. */
export function flipperPlate(l, w) {
  const plate = extrude(poly([[-l / 2, 0.022], [l / 2 - 0.035, 0.022], [l / 2, 0.002], [-l / 2, 0]]), w, 0.002);
  const rails = [];
  for (const s of [-1, 1]) {
    const r = box(l * 0.8, 0.03, 0.014);
    r.translate(-l * 0.08, 0.034, s * w * 0.46);
    rails.push(r);
  }
  const hinge = cyl(0.018, 0.018, w * 0.9, 12);
  hinge.rotateX(Math.PI / 2);
  hinge.translate(-l / 2, 0.018, 0);
  return [
    { geo: plate, mat: "steel" },
    { geo: mergeGeometries(rails), mat: "dark" },
    { geo: hinge, mat: "hub" },
  ];
}

/** One lifter fork, pointing +X, lying on y = 0. */
export function forkGeometry(l, fw) {
  const g = extrude(poly([[-l / 2, -fw / 2], [l / 2 - fw * 0.8, -fw / 2], [l / 2, -fw * 0.1], [l / 2, fw * 0.1], [l / 2 - fw * 0.8, fw / 2], [-l / 2, fw / 2]]), 0.026, 0.003);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A crusher beak, hinged at the origin, reaching `reach` and dropping `drop`. */
export function beakGeometry(reach, drop, width) {
  const s = new THREE.Shape();
  s.moveTo(-0.04, 0.035);
  s.quadraticCurveTo(reach * 0.75, 0.09, reach, -drop * 0.35);
  s.lineTo(reach * 0.97, -drop);
  s.quadraticCurveTo(reach * 0.82, -drop * 0.45, reach * 0.55, -0.045);
  s.lineTo(-0.04, -0.04);
  s.closePath();
  return extrude(s, width, 0.006, 16);
}

/** A lid: a painted panel with a hinge barrel at its back edge (x = 0). */
export function lidParts(len, w) {
  const lid = extrude(poly([[0, 0], [len - 0.02, 0], [len, -0.01], [len, 0.008], [0, 0.016]]), w, 0.002);
  const hinge = cyl(0.015, 0.015, w * 0.96, 12);
  hinge.rotateX(Math.PI / 2);
  return [{ geo: lid, mat: "accent" }, { geo: hinge, mat: "hub" }];
}
