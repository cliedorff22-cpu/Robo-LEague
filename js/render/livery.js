// livery.js - a robot's paint job, painted into one canvas at build time.
//
// The body is drawn from convex hull pieces (js/logic/shape.js). Those pieces
// get UVs by projection (robot_view.js): faces looking up read the TOP of this
// atlas, faces looking sideways one of the SIDES, the nose and tail the ENDS.
// Everything here is painted in body metres, so a stripe 4 cm wide is 4 cm
// wide on every bot, and the same pattern fits a wedge or a box.
//
// What a robot file can say (all optional):
//
//   "livery": { "primary": "#16171a", "secondary": "#b3121b", "accent": "#c9ced6",
//               "pattern": "flames", "decal": "TOMBSTONE", "text": "#ffffff" }
//
// Patterns are cosmetic only. With none named, one is picked from the id, so
// a new robot still gets something better than a flat colour.
//
// Atlas layout (1024 x 1024, top-left origin - the texture is not flipped):
//   rows    0-511   TOP     tail at the left, nose at the right, the robot's
//                           right (-Z) at the top - the view from above
//   rows  512-703   LEFT    the +Z side, nose at the right
//   rows  704-895   RIGHT   the -Z side, nose at the left
//   rows  896-1023  NOSE (cols 0-511) and TAIL (cols 512-1023)

export const ATLAS = {
  size: 1024,
  top: { x: 0, y: 0, w: 1024, h: 512 },
  left: { x: 0, y: 512, w: 1024, h: 192 },
  right: { x: 0, y: 704, w: 1024, h: 192 },
  nose: { x: 0, y: 896, w: 512, h: 128 },
  tail: { x: 512, y: 896, w: 512, h: 128 },
};

export const PATTERNS = [
  "plain", "stripes", "band", "flames", "split", "hazard", "checker", "camo",
  "teeth", "chevron", "bolt", "spots", "scales", "tiger", "pixels", "bricks",
];

/**
 * Atlas UV for a point on a face with normal n, within body bounds b.
 * Pure maths, so the headless checks can exercise it.
 */
export function atlasUV(p, n, b) {
  const sx = b.max.x - b.min.x || 1, sy = b.max.y - b.min.y || 1, sz = b.max.z - b.min.z || 1;
  const cl = (v) => Math.min(0.996, Math.max(0.004, v));
  let R, u, v;
  if (Math.abs(n.y) >= 0.5) {
    R = ATLAS.top; u = (p.x - b.min.x) / sx; v = (p.z - b.min.z) / sz;
  } else if (Math.abs(n.z) >= Math.abs(n.x)) {
    v = (b.max.y - p.y) / sy;
    if (n.z > 0) { R = ATLAS.left; u = (p.x - b.min.x) / sx; }
    else { R = ATLAS.right; u = (b.max.x - p.x) / sx; }
  } else {
    v = (b.max.y - p.y) / sy;
    if (n.x > 0) { R = ATLAS.nose; u = (b.max.z - p.z) / sz; }
    else { R = ATLAS.tail; u = (p.z - b.min.z) / sz; }
  }
  return [(R.x + cl(u) * R.w) / ATLAS.size, (R.y + cl(v) * R.h) / ATLAS.size];
}

/**
 * Paint the atlas.
 * @param canvas  a 1024x1024 canvas
 * @param opts    { name, id, number, livery, template, bounds, origin, relief }
 *
 * `relief` ({ height, finish }, canvases of any square size) asks for the
 * surface detail as well: the same seams, bolts, scrapes and chipped edges
 * painted a second and third time, as a bump map (height: grey 128 is the
 * paint, darker is cut in, lighter stands proud) and a finish map (green =
 * roughness, blue = metalness, the channels Three reads them from). That is
 * what makes a seam catch the light and a scrape shine like bare steel
 * instead of being a grey line in the paint.
 */
export function paintLivery(canvas, opts) {
  const g = canvas.getContext("2d");
  const lv = opts.livery || {};
  const b = opts.bounds;
  const S = {
    x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z,
  };
  const C = {
    primary: lv.primary || "#b8babf",
    secondary: lv.secondary || "#202227",
    accent: lv.accent || "#f0c419",
  };
  C.text = lv.text || pickText(C);
  const pattern = lv.pattern || PATTERNS[1 + (hash(opts.id || "") % (PATTERNS.length - 1))];
  const rng = seeded(hash(opts.id || "x"));

  // Each region gets a transform from body metres to its pixels: (a, b) is
  // (distance from the tail, height from the bottom) on a side, (distance
  // from the tail, distance from the right edge) on top, (across, height) on
  // an end.
  const regions = {
    top: region(ATLAS.top, S.x, S.z, false),
    left: region(ATLAS.left, S.x, S.y, false),
    right: region(ATLAS.right, S.x, S.y, true),
    nose: region(ATLAS.nose, S.z, S.y, true),
    tail: region(ATLAS.tail, S.z, S.y, false),
  };

  // Base coat everywhere, with a little tonal shading so big panels are not
  // one flat value: darker low on the sides, lighter on top.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = C.primary;
  g.fillRect(0, 0, ATLAS.size, ATLAS.size);
  for (const k of ["left", "right", "nose", "tail"]) {
    const R = ATLAS[k];
    const grd = g.createLinearGradient(0, R.y, 0, R.y + R.h);
    grd.addColorStop(0, "rgba(255,255,255,0.06)");
    grd.addColorStop(0.6, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.28)");
    g.fillStyle = grd;
    g.fillRect(R.x, R.y, R.w, R.h);
  }
  // The tail is the back of the bot: secondary, like a rear plate.
  fillRegion(g, ATLAS.tail, C.secondary, 0.85);

  const ctx = { g, S, C, rng, regions, opts, template: opts.template, surface: !!opts.relief };
  ctx.L = { g, kind: "color", s: 1 };     // the layer being painted (see paintRelief)
  (PAINTERS[pattern] || PAINTERS.plain)(ctx);

  // The surface detail rolls its own dice, so turning it on or off leaves
  // the rest of the paint job exactly as it was.
  if (ctx.surface) ctx.plan = surfacePlan(ctx);
  const decal = lv.decal ?? (opts.name || "").toUpperCase();
  panelWork(ctx);
  if (ctx.surface) fittings(ctx);
  nameDecals(ctx, decal);
  wear(ctx);
  if (ctx.surface) {
    chips(ctx);
    paintRelief(ctx, opts.relief, decal);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  return { pattern };
}

// ---------------------------------------------------------------- regions

function region(R, spanA, spanB, mirror) {
  const kx = R.w / spanA, ky = R.h / spanB;
  return {
    R, spanA, spanB, mirror,
    // Canvas transform: (a, b) in metres -> pixels, on a canvas `s` times
    // the atlas size (the relief maps can be smaller than the paint).
    use(g, s = 1) {
      if (mirror) g.setTransform(-kx * s, 0, 0, -ky * s, (R.x + R.w) * s, (R.y + R.h) * s);
      else g.setTransform(kx * s, 0, 0, -ky * s, R.x * s, (R.y + R.h) * s);
      g.save();
      g.beginPath();
      g.rect(0, 0, spanA, spanB);
      g.clip();
    },
    done(g) { g.restore(); g.setTransform(1, 0, 0, 1, 0, 0); },
    px(a, b) {
      return [mirror ? R.x + R.w - a * kx : R.x + a * kx, R.y + R.h - b * ky];
    },
    k: Math.min(kx, ky), kx, ky,
  };
}

function fillRegion(g, R, color, alpha = 1) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.fillRect(R.x, R.y, R.w, R.h);
  g.globalAlpha = 1;
}

/** Run fn(a, b spans) inside each named region's transform, on layer L. */
function inRegions(ctx, names, fn, L = ctx.L) {
  for (const n of names) {
    const r = ctx.regions[n];
    r.use(L.g, L.s);
    fn(r.spanA, r.spanB, n, r);
    r.done(L.g);
  }
}

const SIDES = ["left", "right"];

// ---------------------------------------------------------------- patterns

const PAINTERS = {
  plain() {},

  // Twin racing stripes nose to tail, carried over the ends.
  stripes(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, ["top"], (A, B) => {
      g.fillStyle = C.accent;
      for (const s of [-1, 1]) g.fillRect(0, B / 2 + s * 0.035 - 0.025, A, 0.05);
      g.fillStyle = C.secondary;
      for (const s of [-1, 1]) { g.fillRect(0, B / 2 + s * 0.035 - 0.031, A, 0.006); g.fillRect(0, B / 2 + s * 0.035 + 0.025, A, 0.006); }
    });
    inRegions(ctx, ["nose", "tail"], (A, B) => {
      g.fillStyle = C.accent;
      for (const s of [-1, 1]) g.fillRect(A / 2 + s * 0.035 - 0.025, 0, 0.05, B);
    });
    inRegions(ctx, SIDES, (A, B) => {
      g.fillStyle = C.secondary;
      g.fillRect(0, 0, A, B * 0.22);
      g.fillStyle = C.accent;
      g.fillRect(0, B * 0.22, A, 0.008);
    });
  },

  // One broad band across the back half, wrapping the sides.
  band(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, ["top", ...SIDES], (A, B) => {
      g.fillStyle = C.secondary;
      g.fillRect(A * 0.18, 0, A * 0.22, B);
      g.fillStyle = C.accent;
      g.fillRect(A * 0.4, 0, 0.012, B);
      g.fillRect(A * 0.18 - 0.012, 0, 0.012, B);
    });
  },

  // Flames licking back from the nose.
  flames(ctx) {
    const { g, C, rng } = ctx;
    const tongues = (A, B, base, count) => {
      for (let pass = 0; pass < 2; pass++) {
        g.fillStyle = pass ? C.accent : C.secondary;
        const shrink = pass ? 0.55 : 1;
        for (let i = 0; i < count; i++) {
          const y = B * (0.12 + 0.76 * (i + 0.5) / count) + (rng() - 0.5) * B * 0.06;
          const len = A * (0.35 + rng() * 0.3) * shrink;
          const w = (B / count) * (0.9 + rng() * 0.4) * shrink;
          g.beginPath();
          g.moveTo(A + 0.05, y - w * 0.5);
          g.bezierCurveTo(A - len * 0.3, y - w * 0.7, A - len * 0.6, y + w * 0.3, A - len, y + w * 0.1);
          g.bezierCurveTo(A - len * 0.55, y - w * 0.05, A - len * 0.3, y + w * 0.6, A + 0.05, y + w * 0.5);
          g.closePath();
          g.fill();
        }
      }
    };
    inRegions(ctx, ["top"], (A, B) => tongues(A, B, 0, 5));
    inRegions(ctx, SIDES, (A, B) => tongues(A, B, 0, 3));
    inRegions(ctx, ["nose"], (A, B) => { g.fillStyle = C.secondary; g.fillRect(0, 0, A, B); });
  },

  // Front third in the secondary colour, cut on a rake.
  split(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, ["top", ...SIDES], (A, B) => {
      g.fillStyle = C.secondary;
      g.beginPath();
      g.moveTo(A * 0.62, 0); g.lineTo(A * 0.72, B); g.lineTo(A + 1, B); g.lineTo(A + 1, 0);
      g.closePath(); g.fill();
      g.strokeStyle = C.accent; g.lineWidth = 0.01;
      g.beginPath(); g.moveTo(A * 0.62 - 0.012, 0); g.lineTo(A * 0.72 - 0.012, B); g.stroke();
    });
    inRegions(ctx, ["nose"], (A, B) => { g.fillStyle = C.secondary; g.fillRect(0, 0, A, B); });
  },

  // Hazard stripes across the nose.
  hazard(ctx) {
    const { g, C } = ctx;
    const stripes = (A, B, x0, x1) => {
      g.save();
      g.beginPath(); g.rect(x0, 0, x1 - x0, B); g.clip();
      g.fillStyle = C.accent; g.fillRect(x0, 0, x1 - x0, B);
      g.fillStyle = "#121214";
      for (let s = -B * 2; s < A + B; s += 0.08) {
        g.beginPath();
        g.moveTo(s, 0); g.lineTo(s + 0.04, 0); g.lineTo(s + 0.04 + B, B); g.lineTo(s + B, B);
        g.closePath(); g.fill();
      }
      g.restore();
    };
    inRegions(ctx, ["top", ...SIDES], (A, B) => stripes(A, B, A * 0.78, A + 0.01));
    inRegions(ctx, ["nose"], (A, B) => stripes(A, B, -0.01, A + 0.01));
    inRegions(ctx, ["tail"], (A, B) => stripes(A, B, -0.01, A + 0.01));
  },

  // A chequered-flag field on the top rear.
  checker(ctx) {
    const { g, C } = ctx;
    const sq = 0.05;
    const field = (A, B, x0, x1) => {
      for (let x = x0, i = 0; x < x1; x += sq, i++) {
        for (let y = 0, j = 0; y < B; y += sq, j++) {
          g.fillStyle = (i + j) % 2 ? "#f2f2f2" : "#111114";
          g.fillRect(x, y, sq, sq);
        }
      }
    };
    inRegions(ctx, ["top"], (A, B) => field(A, B, 0, A * 0.3));
    inRegions(ctx, SIDES, (A, B) => { field(A, B, 0, A * 0.18); g.fillStyle = C.accent; g.fillRect(A * 0.18, 0, 0.015, B); });
    inRegions(ctx, ["tail"], (A, B) => field(A, B, 0, A));
  },

  camo(ctx) {
    const { g, C, rng } = ctx;
    inRegions(ctx, ["top", ...SIDES, "nose", "tail"], (A, B) => {
      for (const col of [C.secondary, C.accent]) {
        g.fillStyle = col;
        for (let i = 0; i < Math.ceil(A * B * 60); i++) blob(g, rng() * A, rng() * B, 0.03 + rng() * 0.07, rng);
      }
    });
  },

  // A shark mouth on the nose.
  teeth(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, SIDES, (A, B) => {
      const x0 = A * 0.6;
      g.fillStyle = "#1a0a0c";
      g.beginPath();
      g.moveTo(A + 0.01, B * 0.62); g.quadraticCurveTo(x0 + (A - x0) * 0.3, B * 0.6, x0, B * 0.42);
      g.quadraticCurveTo(x0 + (A - x0) * 0.35, B * 0.12, A + 0.01, B * 0.14);
      g.closePath(); g.fill();
      g.fillStyle = "#f4f4ef";
      const n = 7;
      for (let i = 0; i < n; i++) {
        const x = x0 + ((A - x0) * (i + 0.5)) / n, w = (A - x0) / n * 0.48;
        g.beginPath(); g.moveTo(x - w, B * 0.59); g.lineTo(x + w, B * 0.59); g.lineTo(x, B * 0.44); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(x - w, B * 0.16); g.lineTo(x + w, B * 0.16); g.lineTo(x, B * 0.3); g.closePath(); g.fill();
      }
      // An eye.
      g.fillStyle = "#f4f4ef"; g.beginPath(); g.arc(x0 - 0.02, B * 0.72, Math.min(B * 0.11, 0.03), 0, 7); g.fill();
      g.fillStyle = "#111"; g.beginPath(); g.arc(x0 - 0.015, B * 0.72, Math.min(B * 0.06, 0.016), 0, 7); g.fill();
    });
    inRegions(ctx, ["top"], (A, B) => {
      g.fillStyle = C.secondary;
      g.fillRect(A * 0.6, 0, A * 0.4, B * 0.12); g.fillRect(A * 0.6, B * 0.88, A * 0.4, B * 0.12);
    });
  },

  // Arrowheads down the spine, pointing forward.
  chevron(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, ["top"], (A, B) => {
      g.fillStyle = C.accent;
      const w = Math.min(B * 0.5, 0.22);
      for (let x = A * 0.12; x < A * 0.9; x += 0.1) {
        g.beginPath();
        g.moveTo(x, B / 2 + w / 2); g.lineTo(x + 0.06, B / 2); g.lineTo(x, B / 2 - w / 2);
        g.lineTo(x + 0.035, B / 2 - w / 2); g.lineTo(x + 0.095, B / 2); g.lineTo(x + 0.035, B / 2 + w / 2);
        g.closePath(); g.fill();
      }
    });
    inRegions(ctx, SIDES, (A, B) => { g.fillStyle = C.secondary; g.fillRect(0, 0, A, B * 0.25); });
  },

  // A lightning bolt down each side.
  bolt(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, SIDES, (A, B) => {
      g.fillStyle = C.accent;
      g.strokeStyle = C.secondary; g.lineWidth = 0.008;
      g.beginPath();
      g.moveTo(A * 0.06, B * 0.55); g.lineTo(A * 0.45, B * 0.8); g.lineTo(A * 0.42, B * 0.6);
      g.lineTo(A * 0.95, B * 0.75); g.lineTo(A * 0.55, B * 0.35); g.lineTo(A * 0.58, B * 0.52);
      g.closePath(); g.fill(); g.stroke();
    });
    inRegions(ctx, ["top"], (A, B) => {
      g.fillStyle = C.accent;
      g.beginPath();
      g.moveTo(A * 0.1, B * 0.45); g.lineTo(A * 0.5, B * 0.62); g.lineTo(A * 0.48, B * 0.52);
      g.lineTo(A * 0.92, B * 0.6); g.lineTo(A * 0.52, B * 0.36); g.lineTo(A * 0.54, B * 0.46);
      g.closePath(); g.fill();
    });
  },

  spots(ctx) {
    const { g, C, rng } = ctx;
    inRegions(ctx, ["top", ...SIDES], (A, B) => {
      g.fillStyle = C.accent;
      for (let i = 0; i < Math.ceil(A * B * 30) + 2; i++) {
        g.beginPath(); g.arc(rng() * A, rng() * B, 0.025 + rng() * 0.035, 0, 7); g.fill();
      }
    });
  },

  // Overlapping scales, for the dragons and snakes.
  scales(ctx) {
    const { g, C } = ctx;
    inRegions(ctx, ["top", ...SIDES], (A, B) => {
      g.strokeStyle = C.secondary; g.lineWidth = 0.006;
      const s = 0.06;
      for (let row = 0, y = 0; y < B + s; y += s * 0.5, row++) {
        for (let x = (row % 2) * s * 0.5; x < A + s; x += s) {
          g.beginPath(); g.arc(x, y, s * 0.5, Math.PI, 2 * Math.PI); g.stroke();
        }
      }
    });
  },

  // Glitchy blocks, thickest at the tail and breaking up towards the nose.
  pixels(ctx) {
    const { g, C, rng } = ctx;
    const sq = 0.03;
    inRegions(ctx, ["top", ...SIDES], (A, B) => {
      for (let x = 0; x < A; x += sq) {
        for (let y = 0; y < B; y += sq) {
          const p = 0.55 * (1 - x / A);
          if (rng() < p) { g.fillStyle = rng() < 0.7 ? C.secondary : C.accent; g.fillRect(x, y, sq * 0.92, sq * 0.92); }
        }
      }
    });
  },

  // Running-bond brickwork with mortar lines.
  bricks(ctx) {
    const { g, C, rng } = ctx;
    inRegions(ctx, ["top", ...SIDES, "nose", "tail"], (A, B) => {
      const bw = 0.09, bh = 0.04;
      for (let row = 0, y = 0; y < B; y += bh, row++) {
        for (let x = (row % 2) * -bw / 2; x < A; x += bw) {
          g.fillStyle = shade(C.primary, (rng() - 0.5) * 0.25);
          g.fillRect(x, y, bw, bh);
        }
      }
      g.strokeStyle = C.secondary; g.lineWidth = 0.006;
      for (let row = 0, y = 0; y < B; y += bh, row++) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(A, y); g.stroke();
        for (let x = (row % 2) * -bw / 2; x < A; x += bw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); }
      }
    });
  },

  // Tiger stripes raking back from the spine.
  tiger(ctx) {
    const { g, C, rng } = ctx;
    inRegions(ctx, ["top", ...SIDES], (A, B, name) => {
      g.fillStyle = C.secondary;
      for (let x = 0.06; x < A; x += 0.09 + rng() * 0.05) {
        const w = 0.018 + rng() * 0.02;
        const fromTop = name === "top" ? [B, 0] : [B, B * 0.1];
        g.beginPath();
        g.moveTo(x, fromTop[0] + 0.01);
        g.quadraticCurveTo(x - 0.06, B * 0.6, x - 0.02, fromTop[1] + (name === "top" ? B * 0.55 : B * 0.2));
        g.lineTo(x + w * 0.3, fromTop[1] + (name === "top" ? B * 0.55 : B * 0.2));
        g.quadraticCurveTo(x - 0.03 + w, B * 0.6, x + w, fromTop[0] + 0.01);
        g.closePath(); g.fill();
        if (name === "top") {
          g.beginPath();
          g.moveTo(x, -0.01); g.quadraticCurveTo(x - 0.06, B * 0.4, x - 0.02, B * 0.45);
          g.lineTo(x + w * 0.3, B * 0.45); g.quadraticCurveTo(x - 0.03 + w, B * 0.4, x + w, -0.01);
          g.closePath(); g.fill();
        }
      }
    });
  },
};

// ---------------------------------------------------------------- panel work

/** Seams and bolt heads: what makes a painted box read as a built machine. */
function panelWork(ctx, L = ctx.L) {
  const { S } = ctx;
  const inset = Math.min(0.022, S.z * 0.05);
  const bolts = (pts) => { for (const [a, b] of pts) bolt(ctx, L, a, b); };
  const line = (a0, b0, a1, b1, w = 0.0035, col = "rgba(8,8,10,0.45)") =>
    groove(L, w, col, (g) => { g.moveTo(a0, b0); g.lineTo(a1, b1); });
  const along = (a0, a1, b, step) => {
    const n = Math.max(2, Math.round((a1 - a0) / step));
    return Array.from({ length: n + 1 }, (_, i) => [a0 + ((a1 - a0) * i) / n, b]);
  };

  // Top: a plate border, a seam a third of the way along, bolts round both.
  inRegions(ctx, ["top"], (A, B) => {
    const d = inset;
    groove(L, 0.004, "rgba(8,8,10,0.4)", (g) => g.rect(d * 0.45, d * 0.45, A - d * 0.9, B - d * 0.9));
    line(A * 0.34, d * 0.45, A * 0.34, B - d * 0.45);
    if (L.kind === "color") {
      // a light catch on the plate edge
      L.g.strokeStyle = "rgba(255,255,255,0.08)"; L.g.lineWidth = 0.003;
      L.g.strokeRect(d * 0.45 + 0.003, d * 0.45 + 0.003, A - d * 0.9 - 0.006, B - d * 0.9 - 0.006);
    }
    bolts([
      ...along(d, A - d, d, 0.075), ...along(d, A - d, B - d, 0.075),
      ...along(d, B - d, d, 0.075).map(([b]) => [d, b]),
      ...along(d, B - d, d, 0.075).map(([b]) => [A - d, b]),
      ...along(d, B - d, d, 0.075).map(([b]) => [A * 0.34 + d * 0.6, b]),
    ]);
  }, L);
  // Sides: a seam above the skid line, bolts along the top edge.
  inRegions(ctx, SIDES, (A, B) => {
    line(0, B * 0.16, A, B * 0.16, 0.003, "rgba(8,8,10,0.35)");
    line(A * 0.34, 0, A * 0.34, B, 0.003, "rgba(8,8,10,0.35)");
    bolts(along(0.02, A - 0.02, B - Math.min(0.016, B * 0.12), 0.08));
    bolts(along(0.02, A - 0.02, Math.min(0.012, B * 0.08), 0.08));
  }, L);
  inRegions(ctx, ["nose", "tail"], (A, B) => {
    bolts(along(0.02, A - 0.02, B - Math.min(0.014, B * 0.12), 0.08));
  }, L);
}

/** A cut line (a seam, a plate edge) traced by path(g), on any layer. */
function groove(L, w, col, path) {
  const g = L.g;
  g.beginPath();
  path(g);
  if (L.kind === "color") {
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
  } else if (L.kind === "height") {
    // a soft shoulder, then the cut itself
    g.strokeStyle = "rgb(92,92,92)"; g.lineWidth = w * 2.2; g.stroke();
    g.strokeStyle = "rgb(34,34,34)"; g.lineWidth = w; g.stroke();
  } else {
    g.strokeStyle = "rgb(0,205,18)"; g.lineWidth = w * 1.6; g.stroke();   // dirt packed in: rough, not metal
  }
}

/** A bolt head: a washer, a domed head, and (with surface detail) a hex socket. */
function bolt(ctx, L, a, b, size = 1) {
  const g = L.g, R = 0.0062 * size, r = 0.0042 * size;
  const disc = (x, y, rad, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); };
  if (L.kind === "color") {
    disc(a, b, R, "rgba(10,10,12,0.55)");
    disc(a, b, r, "rgba(190,196,205,0.9)");
    disc(a + 0.0012 * size, b + 0.0014 * size, 0.0015 * size, "rgba(255,255,255,0.7)");
    if (ctx.surface) hexagon(g, a, b, 0.0016 * size, "rgba(16,16,20,0.8)");
  } else if (L.kind === "height") {
    disc(a, b, R, "rgb(150,150,150)");
    const grd = g.createRadialGradient(a, b, 0, a, b, r);
    grd.addColorStop(0, "rgb(245,245,245)");
    grd.addColorStop(1, "rgb(178,178,178)");
    disc(a, b, r, grd);
    hexagon(g, a, b, 0.0016 * size, "rgb(84,84,84)");
  } else {
    disc(a, b, R, "rgb(0,130,95)");
    disc(a, b, r, "rgb(0,88,150)");     // bare zinc-plated steel
  }
}

function hexagon(g, x, y, r, fill) {
  g.fillStyle = fill;
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    i ? g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------- surface detail

/**
 * Where the surface detail goes, decided once so every layer draws the same
 * thing: chipped paint along the body's edges (worst at the nose and the
 * skids), an access hatch on top, cooling slots in the rear plate, and a
 * little unevenness in the paint's sheen.
 */
function surfacePlan(ctx) {
  const rng = seeded(hash((ctx.opts.id || "x") + ":surface"));
  const chips = {};
  // Each region's edges as [a0, b0, a1, b1, odds of a chip every 12 mm].
  const edges = (A, B, name) => {
    if (name === "top") return [[0, 0, A, 0, 0.22], [0, B, A, B, 0.22], [0, 0, 0, B, 0.22], [A, 0, A, B, 0.4]];
    if (name === "left" || name === "right") return [[0, B, A, B, 0.25], [0, 0, A, 0, 0.35], [0, 0, 0, B, 0.3], [A, 0, A, B, 0.45]];
    const p = name === "nose" ? 0.4 : 0.25;
    return [[0, B, A, B, p], [0, 0, 0, B, p], [A, 0, A, B, p], [0, 0, A, 0, p]];
  };
  for (const name of ["top", "left", "right", "nose", "tail"]) {
    const { spanA: A, spanB: B } = ctx.regions[name];
    chips[name] = [];
    for (const [a0, b0, a1, b1, p] of edges(A, B, name)) {
      const len = Math.hypot(a1 - a0, b1 - b0);
      // inward from this edge, towards the middle of the region
      const ia = a0 === a1 ? (a0 === 0 ? 1 : -1) : 0, ib = b0 === b1 ? (b0 === 0 ? 1 : -1) : 0;
      for (let t = 0.006; t < len; t += 0.012) {
        if (rng() >= p) continue;
        const f = t / len, inset = rng() * 0.004;
        const x = a0 + (a1 - a0) * f + ia * inset, y = b0 + (b1 - b0) * f + ib * inset;
        const r = 0.0025 + rng() ** 2 * 0.008;
        chips[name].push(blobPts(x, y, r, rng));
      }
    }
  }
  // Big soft patches of slightly glossier or duller paint, in atlas pixels.
  const sheen = [];
  for (let i = 0; i < 22; i++) {
    sheen.push({ pts: blobPts(rng() * ATLAS.size, rng() * ATLAS.size, 40 + rng() * 90, rng), glossy: rng() < 0.5 });
  }
  return { chips, sheen };
}

/** The hatch and the cooling slots. */
function fittings(ctx, L = ctx.L) {
  const { S } = ctx, g = L.g;
  const inset = Math.min(0.022, S.z * 0.05);
  const rrect = (x, y, w, h, r) => (gg) => {
    gg.moveTo(x + r, y); gg.arcTo(x + w, y, x + w, y + h, r); gg.arcTo(x + w, y + h, x, y + h, r);
    gg.arcTo(x, y + h, x, y, r); gg.arcTo(x, y, x + w, y, r); gg.closePath();
  };
  const fill = (path, col) => { g.beginPath(); path(g); g.fillStyle = col; g.fill(); };

  // Access hatch on top, in the bay behind the cross seam (the name decal
  // sits in front of it).
  inRegions(ctx, ["top"], (A, B) => {
    const w = Math.min(0.11, A * 0.34 - inset * 3), h = Math.min(0.12, B * 0.36);
    if (w < 0.05 || h < 0.05) return;
    const x = A * 0.17 - w / 2, y = B / 2 - h / 2;
    const panel = rrect(x, y, w, h, 0.008);
    fill(panel, { color: "rgba(0,0,0,0.07)", height: "rgb(121,121,121)", finish: "rgb(0,150,24)" }[L.kind]);
    groove(L, 0.003, "rgba(8,8,10,0.55)", panel);
    for (const [bx, by] of [[x + 0.009, y + 0.009], [x + w - 0.009, y + 0.009], [x + 0.009, y + h - 0.009], [x + w - 0.009, y + h - 0.009]]) {
      bolt(ctx, L, bx, by, 0.7);
    }
    // a latch slot at the tail end
    const slot = rrect(x + 0.012, B / 2 - 0.009, 0.006, 0.018, 0.003);
    fill(slot, { color: "rgba(10,10,12,0.85)", height: "rgb(40,40,40)", finish: "rgb(0,225,30)" }[L.kind]);
  }, L);

  // Cooling slots across the rear plate.
  inRegions(ctx, ["tail"], (A, B) => {
    if (B < 0.05 || A < 0.12) return;
    const n = B > 0.09 ? 4 : 3, hh = Math.min(0.008, B * 0.07), w = A * 0.38;
    for (let i = 0; i < n; i++) {
      const y = B * (0.3 + (0.4 * i) / (n - 1)) - hh / 2, x = A / 2 - w / 2;
      const slot = rrect(x, y, w, hh, hh / 2);
      if (L.kind === "height") fill(rrect(x - 0.002, y - 0.002, w + 0.004, hh + 0.004, hh / 2 + 0.002), "rgb(96,96,96)");
      fill(slot, { color: "rgba(8,8,10,0.85)", height: "rgb(28,28,28)", finish: "rgb(0,230,30)" }[L.kind]);
      if (L.kind === "color") {
        g.strokeStyle = "rgba(255,255,255,0.12)"; g.lineWidth = 0.0015;
        g.beginPath(); g.moveTo(x + hh / 2, y - 0.001); g.lineTo(x + w - hh / 2, y - 0.001); g.stroke();
      }
    }
  }, L);
}

/** Paint chipped off the edges, down to bare steel. */
function chips(ctx, L = ctx.L) {
  const g = L.g;
  for (const [name, list] of Object.entries(ctx.plan.chips)) {
    inRegions(ctx, [name], () => {
      for (const pts of list) {
        if (L.kind === "color") {
          fillPts(g, pts, "rgba(0,0,0,0.22)", 1.35);          // the torn paint edge
          fillPts(g, pts, "rgba(168,174,182,0.92)");
        } else if (L.kind === "height") {
          fillPts(g, pts, "rgb(104,104,104)");
        } else {
          fillPts(g, pts, "rgb(0,100,130)");
        }
      }
    }, L);
  }
}

/** Paint the bump and finish maps: the same plan, drawn as height and sheen. */
function paintRelief(ctx, relief, decal) {
  for (const kind of ["height", "finish"]) {
    const canvas = relief[kind];
    if (!canvas) continue;
    const g = canvas.getContext("2d"), s = canvas.width / ATLAS.size;
    const L = { g, kind, s };
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Paint: rough 0.55, metal 0.1 - what robotPaint used to set flat.
    g.fillStyle = kind === "height" ? "rgb(128,128,128)" : "rgb(0,140,26)";
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (kind === "finish") {
      g.setTransform(s, 0, 0, s, 0, 0);
      for (const { pts, glossy } of ctx.plan.sheen) fillPts(g, pts, glossy ? "rgba(0,122,26,0.3)" : "rgba(0,160,26,0.3)");
    }
    panelWork(ctx, L);
    fittings(ctx, L);
    if (kind === "finish") nameDecals(ctx, decal, L);
    wear(ctx, L);
    chips(ctx, L);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}

// ---------------------------------------------------------------- name decals

function nameDecals(ctx, name, L = ctx.L) {
  const { S, C, regions, template } = ctx;
  const g = L.g, k = L.s;
  if (!name || typeof g.measureText !== "function") return;
  // On the finish map the decal is just its outline: glossy vinyl.
  const vinyl = L.kind === "finish" ? "rgb(0,120,22)" : null;
  const decal = (r, centreA, centreB, maxW, maxH, rotate = 0) => {
    // Size the text in pixels, then draw it unmirrored at the right spot.
    const [px, py] = r.px(centreA, centreB);
    const kW = (rotate ? r.ky : r.kx) * k, kH = (rotate ? r.kx : r.ky) * k;
    let size = Math.max(8 * k, maxH * kH);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = fontAt(size);
    const w = g.measureText(name).width || name.length * size * 0.7;
    if (w > maxW * kW) { size *= (maxW * kW) / w; g.font = fontAt(size); }
    g.save();
    g.translate(px * k, py * k);
    if (rotate) g.rotate(rotate);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.lineWidth = Math.max(2 * k, size * 0.16);
    g.strokeStyle = vinyl || shade(C.text, -0.85);
    g.strokeText(name, 0, 0);
    g.fillStyle = vinyl || C.text;
    g.fillText(name, 0, 0);
    g.restore();
  };
  // Sides: rear-biased on wedges, where the body is still tall.
  const midA = template === "wedge" ? S.x * 0.36 : S.x * 0.5;
  if (template !== "round") {
    for (const side of SIDES) decal(regions[side], midA, S.y * 0.56, S.x * (template === "wedge" ? 0.5 : 0.62), S.y * 0.4);
  }
  // Top: along the length, reading from the left side.
  decal(regions.top, S.x * 0.6, S.z * 0.5, Math.min(S.x * 0.5, 0.5), Math.min(S.z * 0.2, 0.09));
}

const fontAt = (px) => `italic 900 ${Math.round(px)}px "Arial Black", Impact, "Helvetica Neue", system-ui, sans-serif`;

// ---------------------------------------------------------------- wear

function wear(ctx, L = ctx.L) {
  const g = L.g;
  // The dice are rolled on the paint pass and kept, so the bump and finish
  // maps put every scrape in the same place.
  if (!ctx.scuffs) {
    const rng = ctx.rng, scrapes = [], soot = [];
    // Scrapes down to bright metal, mostly low and near the nose.
    for (let i = 0; i < 120; i++) {
      const x = rng() * ATLAS.size, y = rng() * ATLAS.size;
      const a = (rng() - 0.5) * 0.9 + (rng() < 0.5 ? 0 : Math.PI), l = 6 + rng() * 40;
      const alpha = 0.12 + rng() * 0.3, w = 0.6 + rng() * 1.6;
      scrapes.push({ x, y, x2: x + Math.cos(a) * l, y2: y + Math.sin(a) * l, alpha, w });
    }
    // Soot and grime along the bottom of the sides.
    for (const k of ["left", "right", "nose", "tail"]) {
      const R = ATLAS[k];
      for (let i = 0; i < 14; i++) soot.push(blobPts(R.x + rng() * R.w, R.y + R.h * (0.75 + rng() * 0.3), 8 + rng() * 26, rng));
    }
    ctx.scuffs = { scrapes, soot };
  }
  g.setTransform(L.s, 0, 0, L.s, 0, 0);
  g.lineCap = "round";
  for (const { x, y, x2, y2, alpha, w } of ctx.scuffs.scrapes) {
    g.strokeStyle = L.kind === "color" ? `rgba(205,210,218,${alpha})`
      : L.kind === "height" ? `rgba(80,80,80,${Math.min(1, alpha * 1.4)})`
      : `rgba(0,84,140,${Math.min(1, alpha * 1.8)})`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
  }
  if (L.kind === "height") return;      // soot has no depth
  for (const pts of ctx.scuffs.soot) fillPts(g, pts, L.kind === "color" ? "rgba(22,20,20,0.16)" : "rgba(0,235,10,0.4)");
}

// ---------------------------------------------------------------- helpers

/** An irregular blob's outline, as blob() draws it (same dice, same order). */
function blobPts(x, y, r, rng) {
  const n = 9, pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, rr = r * (0.6 + rng() * 0.6);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  return { x, y, pts };
}

/** Fill a blob from blobPts, optionally grown about its middle. */
function fillPts(g, { x, y, pts }, fill, grow = 1) {
  g.fillStyle = fill;
  g.beginPath();
  pts.forEach(([px, py], i) => {
    const qx = x + (px - x) * grow, qy = y + (py - y) * grow;
    i ? g.lineTo(qx, qy) : g.moveTo(qx, qy);
  });
  g.closePath();
  g.fill();
}

function blob(g, x, y, r, rng, fill) {
  if (fill) g.fillStyle = fill;
  g.beginPath();
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, rr = r * (0.6 + rng() * 0.6);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
  g.fill();
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function rgb(hex) {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Decal colour: the accent if it stands out on the paint, else white or black. */
function pickText(C) {
  for (const c of [C.accent, C.secondary]) if (contrast(c, C.primary) >= 2.6) return c;
  return contrast("#ffffff", C.primary) > contrast("#111114", C.primary) ? "#ffffff" : "#111114";
}

/** Lighten (k > 0) or darken (k < 0) a hex colour. */
function shade(hex, k) {
  const c = rgb(hex).map((v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
