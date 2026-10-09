// hull.js - convex hulls of small point sets, as triangles.
//
// Robot bodies are built from a handful of convex pieces (js/logic/shape.js).
// Physics turns each piece's points into a Rapier convex hull; the renderer
// needs the SAME hull as triangles to draw it. Computing it here, once, from
// the same points, is what keeps the picture and the collision shape from
// disagreeing (README rule 4).
//
// Brute force on purpose: a piece has at most a few dozen points, so testing
// every candidate plane is cheap and has none of quickhull's numerical
// fragility. Coplanar faces (a box side has four points on one plane) are
// gathered and triangulated as one convex polygon, so no face is drawn twice.
//
// Zero dependencies, plain {x,y,z} objects. Runs headless.

const EPS = 1e-7;

/**
 * @param {Array<{x,y,z}>} input  points; duplicates are fine
 * @returns {{ points: Array<{x,y,z}>, triangles: Array<[number,number,number]> }}
 *          `points` deduplicated, `triangles` wound counter-clockwise seen from
 *          outside (Three's front face). Empty triangles if the set is flat.
 */
export function convexHull(input) {
  const { points, faces } = convexFaces(input);
  const triangles = [];
  for (const { ring } of faces) {
    for (let t = 1; t + 1 < ring.length; t++) triangles.push([ring[0], ring[t], ring[t + 1]]);
  }
  return { points, triangles };
}

/**
 * The same hull as whole faces rather than triangles.
 * @returns {{ points: Array<{x,y,z}>, faces: Array<{ n, d, ring: number[] }> }}
 *          each face's outward unit normal, plane offset, and its corners in
 *          order (counter-clockwise seen from outside). No faces if flat.
 */
export function convexFaces(input) {
  const points = dedupe(input);
  const n = points.length;
  if (n < 4) return { points, faces: [] };

  const scale = extent(points) || 1;
  const tol = scale * 1e-6;
  const centroid = mean(points);
  const faces = [];
  const seenPlanes = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = points[i], b = points[j], c = points[k];
        let nrm = cross(sub(b, a), sub(c, a));
        const len = Math.hypot(nrm.x, nrm.y, nrm.z);
        if (len < EPS * scale * scale) continue;           // collinear
        nrm = { x: nrm.x / len, y: nrm.y / len, z: nrm.z / len };
        let d = dot(nrm, a);
        // Face outward, away from the centroid.
        if (dot(nrm, centroid) > d) { nrm = { x: -nrm.x, y: -nrm.y, z: -nrm.z }; d = -d; }

        // A hull face has every point on or behind it.
        let ok = true;
        for (let m = 0; m < n; m++) {
          if (dot(nrm, points[m]) - d > tol) { ok = false; break; }
        }
        if (!ok) continue;
        if (seenPlanes.some((p) => dot(p.n, nrm) > 1 - 1e-9 && Math.abs(p.d - d) < tol * 4)) continue;
        seenPlanes.push({ n: nrm, d });

        // Everything on this plane makes one convex polygon: fan it.
        const onPlane = [];
        for (let m = 0; m < n; m++) if (Math.abs(dot(nrm, points[m]) - d) <= tol * 4) onPlane.push(m);
        // Two distinct faces share at most an edge, so a plane whose points
        // all belong to a face already found is that face again, tilted by
        // rounding (nearly-flat runs of points do this); a wider one replaces it.
        if (faces.some((f) => onPlane.every((m) => f.on.has(m)))) continue;
        for (let f = faces.length - 1; f >= 0; f--) {
          if ([...faces[f].on].every((m) => onPlane.includes(m))) faces.splice(f, 1);
        }
        faces.push({ n: nrm, d, ring: orderOnPlane(onPlane, points, nrm), on: new Set(onPlane) });
      }
    }
  }
  // A flat set "passes" for both faces of its one plane: no volume, no hull.
  if (seenPlanes.length < 4) return { points, faces: [] };
  return { points, faces: faces.map(({ n: nrm, d, ring }) => ({ n: nrm, d, ring })) };
}

/** Flat array [x,y,z, x,y,z, ...] of a point list - what Rapier's convexHull takes. */
export function flatten(points) {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => { out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z; });
  return out;
}

/** Axis-aligned bounds of a point list. */
export function bounds(points) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const k of ["x", "y", "z"]) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return { min, max };
}

/** Volume of a hull (divergence theorem over its triangles). */
export function hullVolume({ points, triangles }) {
  let v = 0;
  for (const [i, j, k] of triangles) v += dot(points[i], cross(points[j], points[k])) / 6;
  return Math.abs(v);
}

// ---------------------------------------------------------------- helpers

/**
 * The plane's points as a convex polygon, counter-clockwise about the normal.
 * Points strictly inside the polygon (a box face's centre, say) are dropped:
 * they would only add slivers.
 */
function orderOnPlane(idx, points, nrm) {
  const c = mean(idx.map((i) => points[i]));
  // An in-plane basis.
  const ref = Math.abs(nrm.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalize(cross(nrm, ref));
  const v = cross(nrm, u);
  const flat = idx.map((i) => {
    const r = sub(points[i], c);
    return { i, x: dot(r, u), y: dot(r, v) };
  });
  // Monotone chain in 2D, which also discards interior and collinear points.
  flat.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of flat) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  for (let i = flat.length - 1; i >= 0; i--) {
    const p = flat[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper).map((p) => p.i);
}

function dedupe(pts) {
  const out = [];
  const scale = extent(pts) || 1;
  for (const p of pts) {
    if (!out.some((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + Math.abs(q.z - p.z) < scale * 1e-6)) {
      out.push({ x: p.x, y: p.y, z: p.z });
    }
  }
  return out;
}

function extent(pts) {
  if (!pts.length) return 0;
  const { min, max } = bounds(pts);
  return Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const mean = (pts) => {
  const s = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length, z: s.z / pts.length };
};
