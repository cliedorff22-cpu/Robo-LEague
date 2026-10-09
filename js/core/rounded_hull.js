// rounded_hull.js - a convex piece with its edges and corners rounded off,
// as triangles with smooth normals, for drawing.
//
// The shape is the hull shrunk by `r` and grown back by a ball of radius r
// (a Minkowski sum): flat faces stay flat, every edge becomes a quarter-round
// strip and every corner a small spherical patch. It always sits INSIDE the
// hull physics collides with, so the picture never sticks out past the
// collider (README rule 4) - it just loses its sharp edges.
//
// Built directly, not by hulling a cloud of points: faces, edge strips and
// corner patches each come from the same arc samples, so the mesh closes
// with no cracks and every normal is exact (a face's own normal on the flat,
// the ball's direction on the rounds).
//
// Zero dependencies, plain {x,y,z} objects, like hull.js - so it ports with
// the rest of the logic. Returns null when it cannot round the piece cleanly;
// callers then draw the plain hull.

import { convexHull, convexFaces } from "./hull.js";

/**
 * @param {Array<{x,y,z}>} points  the piece's hull points (shape.js)
 * @param {object} [opt]
 * @param {number} [opt.radius=0.012]  edge radius, metres (capped for thin pieces)
 * @param {number} [opt.step=PI/12]    largest angle one round segment covers
 * @param {number} [opt.minFrac=0.28]  radius is at most this share of the piece's thinnest width
 * @returns {{ positions: number[], normals: number[], radius: number } | null}
 *          non-indexed triangles, wound counter-clockwise seen from outside
 */
export function roundedHull(points, opt = {}) {
  const radius = opt.radius ?? 0.012, step = opt.step ?? Math.PI / 12, minFrac = opt.minFrac ?? 0.28;
  const { points: pts, triangles } = convexHull(points);
  if (!triangles.length) return null;

  // The hull's face planes, one per flat face.
  const planes = [];
  for (const [a, b, c] of triangles) {
    const A = pts[a], B = pts[b], C = pts[c];
    const n = normalize(cross(sub(B, A), sub(C, A)));
    const d = dot(n, A);
    if (!planes.some((p) => dot(p.n, n) > 1 - 1e-9 && Math.abs(p.d - d) < 1e-6)) planes.push({ n, d });
  }

  // Thin pieces (armour plates) get a smaller round, so they do not vanish.
  let minWidth = Infinity;
  for (const p of planes) minWidth = Math.min(minWidth, p.d - Math.min(...pts.map((q) => dot(p.n, q))));
  const r = Math.min(radius, minFrac * minWidth);
  if (!(r > 5e-4)) return null;

  // The shrunk hull: every plane pulled in by r. Its corners are where three
  // planes meet inside all the others. A piece has a few dozen planes at
  // most, so trying every triple is cheap (and robust, as in hull.js).
  const inner = planes.map((p) => ({ n: p.n, d: p.d - r }));
  const solved = [];
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      for (let k = j + 1; k < inner.length; k++) {
        const P = inner[i], Q = inner[j], R = inner[k];
        const qr = cross(Q.n, R.n), rp = cross(R.n, P.n), pq = cross(P.n, Q.n);
        const det = dot(P.n, qr);
        if (Math.abs(det) < 1e-9) continue;
        const x = scale(add(add(scale(qr, P.d), scale(rp, Q.d)), scale(pq, R.d)), 1 / det);
        if (!inner.some((h) => dot(h.n, x) - h.d > 1e-7)) solved.push(x);
      }
    }
  }
  // Corners closer than a millimetre or so are one corner: where a small
  // face was squeezed out they crowd together and only make slivers - and
  // can leave hull.js an edge it cannot decide, so try a little coarser
  // before giving up.
  let verts, faces, edges;
  for (const snap of [1e-3, 2.5e-3, 5e-3]) {
    const corners = [];
    for (const x of solved) if (!corners.some((v) => dist(v, x) < snap)) corners.push(x);
    ({ points: verts, faces } = convexFaces(corners));
    if (faces.length < 4) continue;
    edges = edgesOf(faces);
    if (edges) break;
  }
  if (!edges) return null;

  // One arc of normals per pair of neighbouring faces, shared by the edge
  // strip and both corner patches it meets, so the seams line up exactly.
  const arcs = new Map();
  const arc = (fa, fb) => {
    const key = fa < fb ? `${fa},${fb}` : `${fb},${fa}`;
    if (!arcs.has(key)) {
      const lo = Math.min(fa, fb), hi = Math.max(fa, fb);
      const A = faces[lo].n, B = faces[hi].n;
      const m = Math.max(1, Math.ceil(angle(A, B) / step));
      const pts = [];
      for (let s = 0; s <= m; s++) pts.push(slerp(A, B, s / m));
      arcs.set(key, pts);
    }
    const pts = arcs.get(key);
    return fa < fb ? pts : pts.slice().reverse();
  };

  const positions = [], normals = [];
  const at = (v, u) => ({ x: v.x + r * u.x, y: v.y + r * u.y, z: v.z + r * u.z });
  const tri = (p0, n0, p1, n1, p2, n2) => {
    // Wind it to face outward, whichever way it was handed in.
    const g = cross(sub(p1, p0), sub(p2, p0));
    if (Math.hypot(g.x, g.y, g.z) < 1e-12) return;     // a sliver where an arc has no length
    if (dot(g, add(add(n0, n1), n2)) < 0) { [p1, p2] = [p2, p1]; [n1, n2] = [n2, n1]; }
    for (const [p, n] of [[p0, n0], [p1, n1], [p2, n2]]) {
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    }
  };

  // Flat faces, pushed back out to where the hull's faces were.
  for (const f of faces) {
    const ring = f.ring.map((i) => at(verts[i], f.n));
    for (let t = 1; t + 1 < ring.length; t++) tri(ring[0], f.n, ring[t], f.n, ring[t + 1], f.n);
  }

  // Edge strips: a quarter-round (or however wide the edge's angle is).
  for (const e of edges.values()) {
    const A = verts[e.a], B = verts[e.b];
    const ns = arc(e.faces[0], e.faces[1]);
    for (let s = 0; s + 1 < ns.length; s++) {
      const u0 = ns[s], u1 = ns[s + 1];
      tri(at(A, u0), u0, at(B, u0), u0, at(B, u1), u1);
      tri(at(A, u0), u0, at(B, u1), u1, at(A, u1), u1);
    }
  }

  // Corner patches: the bit of ball between the arcs meeting at a corner,
  // fanned out from its middle in rings.
  const ekey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  verts.forEach((v, vi) => {
    // The faces round this corner, in order: step from face to face across
    // the edge that leaves the corner next in each face's ring.
    const first = faces.findIndex((f) => f.ring.includes(vi));
    if (first < 0) return;
    const order = [];
    for (let fi = first, guard = 0; guard < 64; guard++) {
      order.push(fi);
      const ring = faces[fi].ring;
      const next = ring[(ring.indexOf(vi) + 1) % ring.length];
      const across = edges.get(ekey(vi, next)).faces;
      fi = across[0] === fi ? across[1] : across[0];
      if (fi === first) break;
    }
    if (order.length < 3) return;
    const c = normalize(order.reduce((s, fi) => add(s, faces[fi].n), { x: 0, y: 0, z: 0 }));
    const rim = [];
    for (let k = 0; k < order.length; k++) {
      const seg = arc(order[k], order[(k + 1) % order.length]);
      rim.push(...seg.slice(0, -1));
    }
    const rings = Math.max(1, Math.ceil(Math.max(...rim.map((u) => angle(c, u))) / step));
    let prev = null;
    for (let t = 1; t <= rings; t++) {
      const cur = t === rings ? rim : rim.map((u) => slerp(c, u, t / rings));
      for (let k = 0; k < cur.length; k++) {
        const k2 = (k + 1) % cur.length;
        if (!prev) tri(at(v, c), c, at(v, cur[k]), cur[k], at(v, cur[k2]), cur[k2]);
        else {
          tri(at(v, prev[k]), prev[k], at(v, cur[k]), cur[k], at(v, cur[k2]), cur[k2]);
          tri(at(v, prev[k]), prev[k], at(v, cur[k2]), cur[k2], at(v, prev[k2]), prev[k2]);
        }
      }
      prev = cur;
    }
  });

  return { positions, normals, radius: r };
}

function slerp(a, b, t) {
  const th = angle(a, b);
  if (th < 1e-6) return a;
  const s = Math.sin(th);
  return normalize(add(scale(a, Math.sin((1 - t) * th) / s), scale(b, Math.sin(t * th) / s)));
}

/** Each edge of a face list with the two faces on it, or null if any edge has not exactly two. */
function edgesOf(faces) {
  const edges = new Map();
  faces.forEach((f, fi) => {
    f.ring.forEach((a, k) => {
      const b = f.ring[(k + 1) % f.ring.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edges.has(key)) edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edges.get(key).faces.push(fi);
    });
  });
  for (const e of edges.values()) if (e.faces.length !== 2) return null;
  return edges;
}

const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
