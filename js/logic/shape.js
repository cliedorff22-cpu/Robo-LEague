// shape.js - what a robot LOOKS like, as convex pieces both physics and the
// renderer build from.
//
// Every robot in the field is sculpted to what it does, as on the show: a
// wedge is a wedge, a shell spinner is a dome, a hammer bot carries its arm
// over the top. A robot file says so with a `body` block:
//
//   "body": { "template": "wedge", "params": { "slope": 0.7 }, "mount": "front",
//             "extras": [{ "type": "forks", "count": 2 }] }
//
// Templates: box, wedge, slab, round, dart (arrowhead in plan), hex (corners
// clipped in plan), bullet (rounded nose), tent (raked sides to a ridge), cab
// (deck plus a raised cab), twin (two pods and a bridge, a bay between), and
// custom - the robot file draws its own lofts (see LOFTS.custom) when no
// template fits. A body may be several convex lofts; each is its own piece.
//
// That is GEOMETRY, not stats (README rule 1 still holds): the template is
// scaled into the chassis part's envelope, so mass, inertia, speed and armour
// all still come from parts. Swap in a bigger chassis and the same template
// grows with it.
//
// Output, all in body-local metres (X forward, Y up, Z left, origin at the
// chassis box centre):
//
//   pieces   [{ id, slot, role, points }] - convex point sets. `slot` says which
//            fitting a hit on it damages (see routeFittings); `role` how it is
//            painted.
//   weapon   { class, mount, colliders, visual } - the weapon's swept volume
//            for physics and a description for the renderer.
//   invertible  whether the wheels stand proud of the body top AND bottom, so
//            the bot can drive upside down. Derived, never declared.
//
// Pure logic: no Three.js, no Rapier. robot_sim.js turns pieces into colliders
// and robot_view.js into meshes, from the SAME points (README rule 4).

import { inToM, degToRad } from "../core/units.js";
import { bounds } from "../core/hull.js";

/** Templates a robot file may name. "classic" is the original box-and-panels. */
export const BODY_TEMPLATES = [
  "classic", "box", "wedge", "slab", "round",
  "dart", "hex", "bullet", "tent", "cab", "twin", "custom",
];
export const EXTRA_TYPES = [
  "forks", "wheelGuards", "uprights", "mast", "fin", "spikes", "tail", "stack",
  "eyes", "dome", "plow", "legs", "hump", "cage", "wings",
  "pod", "horns", "ears", "spines", "bumper",
];

/**
 * @param assembled  from build.js (needs dims, stats, parts, def)
 * @returns {{ template, pieces, weapon, invertible, wheelTopY, bounds }}
 */
export function buildShape(assembled) {
  const body = assembled.def?.body || {};
  const template = body.template || "classic";
  const p = body.params || {};
  const { lengthM: L, heightM: H, widthM: W } = assembled.dims;
  const ctx = { L, H, W, assembled, p, body, armour: armourThickness(assembled),
    mount: body.mount || defaultMount(assembled.parts.weapon?.spec.class) };

  let core;
  if (template === "classic") core = classicCore(ctx);
  else if (template === "round") core = roundCore(ctx);
  else if (BODY_TEMPLATES.includes(template)) core = loftCore(template, ctx);
  else throw new Error(`${assembled.id}: unknown body template "${template}"`);

  const pieces = [...core.pieces];
  for (const ex of body.extras || []) pieces.push(...extraPieces(ex, ctx, core));

  const weapon = weaponGeometry(assembled, ctx, core, body.mount);
  if (weapon?.pieces) pieces.push(...weapon.pieces);

  // Invertible: the tyres stand proud of everything, top and bottom. A body
  // or weapon above the tyre tops lands on that instead, and it is stuck.
  const st = assembled.stats;
  const groundY = -H / 2 - st.groundClearanceM;
  const wheelTopY = groundY + 2 * st.wheelRadiusM;
  const all = pieces.flatMap((x) => x.points);
  for (const c of weapon?.colliders || []) all.push(...colliderExtremes(c));
  const b = bounds(all);
  const invertible = b.max.y < wheelTopY - 0.006;

  return { template, pieces, weapon, invertible, wheelTopY, groundY, bounds: b, frontX: core.frontX };
}

/**
 * Which fitting a hit on each piece damages. Armour slots map to the fitted
 * panels in order; a slot with no panel fitted is bare chassis.
 * @returns Map pieceId -> fitting key
 */
export function routeFittings(shape, assembled) {
  const bySlot = {};
  for (const f of assembled.fittings) {
    if (f.part.category !== "armor") continue;
    (bySlot[f.part.spec.slot] ||= []).push(f.key);
  }
  const staticWeapon = assembled.parts.weapon?.spec.class === "static";
  const out = new Map();
  for (const piece of shape.pieces) {
    let key = "chassis";
    switch (piece.slot) {
      case "front": key = bySlot.front?.[0] ?? "chassis"; break;
      case "top": key = bySlot.top?.[0] ?? "chassis"; break;
      case "rear": key = bySlot.rear?.[0] ?? "chassis"; break;
      case "sideL": key = bySlot.side?.[0] ?? "chassis"; break;
      case "sideR": key = bySlot.side?.[1] ?? bySlot.side?.[0] ?? "chassis"; break;
      case "weapon": key = "weapon"; break;
      // Forks and a wedge nose are the wedge's job on a wedge bot, and the
      // front armour's on anything else.
      case "wedge": key = staticWeapon ? "weapon" : bySlot.front?.[0] ?? "chassis"; break;
      case "guard": key = bySlot.side?.[0] ?? "chassis"; break;
      default: key = "chassis";
    }
    out.set(piece.id, key);
  }
  return out;
}

// ---------------------------------------------------------------- cores

/** The original look: a box with a thin panel on each armoured face. */
function classicCore({ L, H, W, assembled }) {
  const pieces = [{ id: "core", slot: "core", role: "body", points: boxPts(0, 0, 0, L / 2, H / 2, W / 2) }];
  const panelT = 0.012;
  let side = 0;
  for (const f of assembled.fittings) {
    if (f.part.category !== "armor") continue;
    const slot = f.part.spec.slot;
    const id = `armor:${f.key}`;
    if (slot === "front") pieces.push({ id, slot: "front", role: "armor", points: boxPts(L / 2 + panelT / 2, 0, 0, panelT / 2, H / 2 * 0.9, W / 2 * 0.95) });
    else if (slot === "side") {
      const s = side++ === 0 ? 1 : -1;
      pieces.push({ id, slot: s > 0 ? "sideL" : "sideR", role: "armor", points: boxPts(0, 0, s * (W / 2 + panelT / 2), L / 2 * 0.9, H / 2 * 0.9, panelT / 2) });
    } else if (slot === "top") pieces.push({ id, slot: "top", role: "armor", points: boxPts(0, H / 2 + panelT / 2, 0, L / 2 * 0.9, panelT / 2, W / 2 * 0.95) });
    else if (slot === "rear") pieces.push({ id, slot: "rear", role: "armor", points: boxPts(-L / 2 - panelT / 2, 0, 0, panelT / 2, H / 2 * 0.9, W / 2 * 0.95) });
  }
  return { pieces, frontX: L / 2, topY: H / 2, frontBottomY: -H / 2, sections: null, classic: true };
}

/**
 * Lofted bodies: one or more LOFTS, each a run of cross-sections from tail to
 * nose. A section is a trapezoid { x, yb, yt, hw, hwt, zc, zt } - bottom and
 * top height, bottom and top half-width, and where across the bot its bottom
 * and top are centred (zc, zt; 0 = the centreline, zt defaults to zc - set
 * it apart to lean the section sideways). Each loft is one convex piece with its own armour
 * skins, so a body can be a deck plus a cab, or two pods and a bridge.
 *
 * The first loft is the main body ("core"): the nose the weapon mounts to.
 */
function loftCore(template, ctx) {
  const { L, H, W, p } = ctx;
  const hw = W / 2;
  const hwt = hw * clamp(p.topWidth ?? 1, 0.4, 1);
  // A weapon bay shortens the nose across the whole width - only a twin body,
  // whose pods carry on past it, wants that. Anywhere else a disc or drum
  // sits in a SLOT cut into a full-length nose (verticalRotor), and the bay
  // just says how deep it is tucked.
  const wcls = ctx.assembled.parts.weapon?.spec.class;
  const slotted = (wcls === "spinner_v" || wcls === "drum") && ctx.mount !== "high";
  const bayIn = clamp(p.weaponBay ?? (template === "twin" ? 0.3 : 0), 0, 0.45) * L;
  const bay = slotted && template !== "twin" ? 0 : bayIn;
  const xf = L / 2 - bay, xr = -L / 2;
  const len = xf - xr;
  const yb = -H / 2;
  const lofts = LOFTS[template]({ ...ctx, hw, hwt, bay, xf, xr, len, yb });

  // A horizontal rotor sweeps a disc across the front. Where it passes, the
  // body has to step down under it (a chin) or up over it (an undercutter),
  // or the bar would spin through the hull. A notch is not convex, so a loft
  // the rotor crosses becomes two convex pieces: the body and the chin.
  const cut = rotorCut(ctx, xf, xr, len);
  // A disc or drum runs in a slot down the middle of the nose instead, so
  // the loft ahead of the slot's back wall becomes two cheeks either side.
  const vrot = slotted && !cut ? verticalRotor(ctx, template, lofts, { xf, xr, len, yb, tuck: template === "twin" ? 0 : bayIn }) : null;
  const pieces = [];
  lofts.forEach((loft, k) => {
    const secs = loft.sections;
    const crosses = (x0) => secs[0].x < x0 - 0.02 && secs[secs.length - 1].x > x0 + 0.02;
    if (vrot && crosses(vrot.x0) && overlapsSlot(secs.filter((s) => s.x > vrot.x0), vrot.zHalf)) {
      const [rear, front] = splitAt(secs, { x0: vrot.x0 });
      pieces.push({ id: k === 0 ? "core" : `body:${k}`, slot: loft.slot || "core", role: "body", points: rear.flatMap(sectionPts) });
      pieces.push(...loftPlates(rear, ctx, k === 0 ? "" : `:b${k}`));
      for (const [side, s] of [["L", 1], ["R", -1]]) {
        const cheek = cheekSections(front, vrot.zHalf, s, vrot.minCheek);
        pieces.push({ id: k === 0 ? `cheek:${side}` : `body:${k}:cheek${side}`, slot: "front", role: "body", points: cheek.flatMap(sectionPts) });
        pieces.push(...loftPlates(cheek, ctx, `:${k}cheek${side}`));
      }
      return;
    }
    const segments = cut && crosses(cut.x0) ? splitAt(secs, cut) : [secs];
    segments.forEach((seg, j) => {
      const id = k === 0 ? (j === 0 ? "core" : "chin") : `body:${k}${j ? ":chin" : ""}`;
      pieces.push({ id, slot: j === 0 ? (loft.slot || "core") : "front", role: "body", points: seg.flatMap(sectionPts) });
      pieces.push(...loftPlates(seg, ctx, k === 0 ? (j ? ":chin" : "") : `:b${k}${j ? "chin" : ""}`));
    });
  });

  const main = lofts[0].sections;
  const nose = main[main.length - 1];
  const all = lofts.flatMap((l) => l.sections);
  return {
    pieces, sections: main, lofts, vrot,
    frontX: nose.x, bayX: bay,
    topY: Math.max(...all.map((s) => s.yt)),
    frontBottomY: nose.yb,
    noseTopY: nose.yt,
    /** The top surface at (x, z): the highest loft that covers that point. */
    topAt(x, z = 0) {
      let best = -Infinity;
      for (const l of lofts) {
        const s = l.sections;
        if (x < s[0].x - 1e-6 || x > s[s.length - 1].x + 1e-6) continue;
        const at = interpSection(s, x);
        if (Math.abs(z - (at.zt ?? at.zc ?? 0)) <= (at.hwt ?? at.hw) + 1e-6) best = Math.max(best, at.yt);
      }
      return best > -Infinity ? best : interpSection(main, clamp(x, main[0].x, nose.x)).yt;
    },
  };
}

/** Section helper: x, bottom, top, half-widths, centre. */
const sec = (x, yb, yt, hw, hwt = hw, zc = 0, zt = zc) => ({ x, yb, yt, hw, hwt, zc, zt });

/** Every loft template: ctx -> [{ sections, slot? }]. Heights in metres. */
const LOFTS = {
  box({ H, p, hw, hwt, xf, xr, len, yb }) {
    const cf = clamp(p.chamferFront ?? 0.15, 0, 0.7);     // fraction of height cut off the front-top edge
    const cr = clamp(p.chamferRear ?? 0.1, 0, 0.7);
    const hs = clamp(p.height ?? 1, 0.5, 1);
    const yt = yb + H * hs;
    const run = Math.min(len * 0.3, H * 0.9);
    return [{ sections: [
      sec(xr, yb, yt - H * hs * cr, hw, hwt),
      sec(xr + run * cr, yb, yt, hw, hwt),
      sec(xf - run * cf, yb, yt, hw, hwt),
      sec(xf, yb, yt - H * hs * cf, hw, hwt),
    ] }];
  },

  wedge({ H, p, hw, hwt, xf, xr, len, yb }) {
    const slope = clamp(p.slope ?? 0.6, 0.15, 1);         // fraction of length that slopes
    const rh = clamp(p.rearHeight ?? 1, 0.4, 1);
    const nh = clamp(p.noseHeight ?? 0.08, 0.02, 0.6);
    const yTop = yb + H * rh;
    const xBreak = xf - len * slope;
    return [{ sections: [
      sec(xr, yb, yTop, hw, hwt),
      ...(slope < 0.98 ? [sec(xBreak, yb, yTop, hw, hwt)] : []),
      sec(xf, yb, yb + H * nh, hw, hw),
    ] }];
  },

  // Low, flat top and bottom, chamfered ends both ways up - the shape of an
  // invertible bot.
  slab({ H, p, hw, hwt, xf, xr, len, yb }) {
    const ch = clamp(p.chamfer ?? 0.3, 0, 0.45) * H;
    const hs = clamp(p.height ?? 1, 0.5, 1);
    const yt = yb + H * hs;
    const run = Math.min(len * 0.25, H);
    return [{ sections: [
      sec(xr, yb + ch * 0.5, yt - ch * 0.5, hw, hwt),
      sec(xr + run * 0.5, yb, yt, hw, hwt),
      sec(xf - run, yb, yt, hw, hwt),
      sec(xf, yb + ch, yt - ch, hw, hwt),
    ] }];
  },

  // An arrowhead: full width at the back, narrowing in plan as it drops to a
  // pointed nose. Race cars, missiles, snakes' heads.
  dart({ H, p, hw, hwt, xf, xr, len, yb }) {
    const slope = clamp(p.slope ?? 0.55, 0.2, 0.95);
    const nw = clamp(p.noseWidth ?? 0.35, 0.12, 0.9);
    const rh = clamp(p.rearHeight ?? 1, 0.4, 1);
    const nh = clamp(p.noseHeight ?? 0.12, 0.03, 0.6);
    const xBreak = xf - len * slope;
    return [{ sections: [
      sec(xr, yb, yb + H * rh, hw * 0.92, hwt * 0.92),
      sec(xr + len * 0.08, yb, yb + H * rh, hw, hwt),
      sec(xBreak, yb, yb + H * rh, hw, hwt),
      sec(xf, yb, yb + H * nh, hw * nw, hw * nw),
    ] }];
  },

  // Corners clipped off in plan, so from above it is a long hexagon.
  hex({ H, p, hw, hwt, xf, xr, len, yb }) {
    const c = clamp(p.corner ?? 0.18, 0.05, 0.4) * len;
    const ew = clamp(p.endWidth ?? 0.6, 0.25, 0.95);
    const cf = clamp(p.chamferFront ?? 0.2, 0, 0.7);
    const hs = clamp(p.height ?? 1, 0.5, 1);
    const yt = yb + H * hs;
    return [{ sections: [
      sec(xr, yb, yt, hw * ew, Math.min(hwt, hw * ew)),
      sec(xr + c, yb, yt, hw, hwt),
      sec(xf - c, yb, yt, hw, hwt),
      sec(xf, yb, yt - H * hs * cf, hw * ew, Math.min(hwt, hw * ew)),
    ] }];
  },

  // A rounded nose in plan view (and optionally a rounded tail): a bullet.
  bullet({ H, p, hw, hwt, xf, xr, len, yb }) {
    const rn = clamp(p.roundness ?? 0.35, 0.1, 0.6) * len;
    const rt = clamp(p.tailRound ?? 0, 0, 0.5) * len;
    const hs = clamp(p.height ?? 1, 0.5, 1);
    const yt = yb + H * hs;
    const drop = clamp(p.noseDrop ?? 0.3, 0, 0.8);
    const out = [];
    const arc = (x0, r, dir) => {
      // dir +1: nose (x grows to x0 + r), -1: tail
      const steps = 5;
      for (let i = 0; i <= steps; i++) {
        const th = (i / steps) * Math.PI * 0.44;
        const k = Math.cos(th);
        out.push(sec(x0 + dir * r * Math.sin(th), yb, yt - H * hs * drop * (dir > 0 ? (1 - k) : 0) * 1.6,
          hw * Math.max(0.3, k), hwt * Math.max(0.3, k)));
      }
    };
    if (rt > 0.01) { arc(xr + rt, rt, -1); out.reverse(); }
    else out.push(sec(xr, yb, yt, hw, hwt));
    arc(xf - rn, rn, +1);
    // The arc's last section sits short of xf; finish exactly at the nose.
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, x: xf };
    return [{ sections: out.sort((a, b) => a.x - b.x).filter((s, i, a) => i === 0 || s.x - a[i - 1].x > 1e-4) }];
  },

  // Steeply raked sides up to a narrow ridge: an A-frame in cross-section.
  tent({ H, p, hw, xf, xr, len, yb }) {
    const ridge = clamp(p.ridge ?? 0.18, 0.05, 0.5) * hw;
    const cf = clamp(p.chamferFront ?? 0.35, 0, 0.8);
    const cr = clamp(p.chamferRear ?? 0.15, 0, 0.8);
    const hs = clamp(p.height ?? 1, 0.5, 1);
    const yt = yb + H * hs;
    const run = Math.min(len * 0.35, H * 1.2);
    return [{ sections: [
      sec(xr, yb, yt - H * hs * cr, hw, ridge),
      sec(xr + run * cr, yb, yt, hw, ridge),
      sec(xf - run * cf, yb, yt, hw, ridge),
      sec(xf, yb, yt - H * hs * cf, hw, ridge),
    ] }];
  },

  // A low deck the full length with a raised cab on the back: trucks, trains,
  // cars, anything with a hood.
  cab({ H, p, hw, hwt, xf, xr, len, yb }) {
    const deck = clamp(p.deck ?? 0.5, 0.25, 0.85);
    const cl = clamp(p.cabLength ?? 0.45, 0.2, 0.8) * len;
    const cw = clamp(p.cabWidth ?? 0.85, 0.4, 1);
    const rake = clamp(p.rake ?? 0.35, 0, 0.8);
    const cf = clamp(p.chamferFront ?? 0.3, 0, 0.8);
    const yd = yb + H * deck;
    const xc = clamp(xr + cl + (p.cabX ?? 0) * len, xr + cl, xf - 0.02);
    const x0 = xc - cl;
    return [
      { sections: [
        sec(xr, yb, yd, hw, hwt),
        sec(xf - H * deck * cf, yb, yd, hw, hwt),
        sec(xf, yb, yd - H * deck * cf, hw, hwt),
      ] },
      { sections: [
        sec(x0, yb, yb + H, hw * cw, hw * cw * 0.9),
        sec(xc - cl * rake, yb, yb + H, hw * cw, hw * cw * 0.9),
        sec(xc, yb, yd + (H - (yd - yb)) * 0.2, hw * cw, hw * cw * 0.9),
      ], slot: "top" },
    ];
  },

  // Two armoured pods down the sides, joined by a low bridge that stops short
  // of the nose: the weapon (a disc, usually) runs in the bay between them.
  twin({ H, p, W, hw, xf, xr, yb, L }) {
    const pw = clamp(p.pod ?? 0.27, 0.12, 0.4) * W;
    const bridge = clamp(p.bridge ?? 0.55, 0.25, 1);
    const pc = clamp(p.podChamfer ?? 0.45, 0, 0.9);
    const pl = clamp(p.podLength ?? 1, 0.5, 1.2);
    const inner = hw - pw;
    const zc = hw - pw / 2;
    const px = L / 2 * pl;
    const out = [{ sections: [
      sec(xr, yb, yb + H * bridge, inner + 0.01, inner + 0.01),
      sec(xf - H * bridge * 0.3, yb, yb + H * bridge, inner + 0.01, inner + 0.01),
      sec(xf, yb, yb + H * bridge * 0.6, inner + 0.01, inner + 0.01),
    ] }];
    for (const s of [1, -1]) {
      out.push({ sections: [
        sec(xr, yb, yb + H * 0.9, pw / 2, pw * 0.42, s * zc),
        sec(xr + 0.05, yb, yb + H, pw / 2, pw * 0.42, s * zc),
        sec(px - H * pc, yb, yb + H, pw / 2, pw * 0.42, s * zc),
        sec(px, yb, yb + H * (1 - pc) + 0.01, pw / 2, pw * 0.42, s * zc),
      ], slot: s > 0 ? "sideL" : "sideR" });
    }
    return out;
  },

  // The robot file draws its own body: lofts in fractions of the chassis
  // envelope (x and y of length and height, -0.5..0.5 from the centre; half
  // widths and centres of the width). The first loft is the main body.
  //   "custom": { "lofts": [ { "sections": [[x, yb, yt, hw, hwt?, zc?, zt?], ...] } ] }
  custom({ L, H, W, body, hw, hwt, xf, xr, yb, assembled }) {
    const spec = body.custom?.lofts;
    if (!spec || !spec.length) return LOFTS.box({ H, p: {}, hw, hwt, xf, xr, len: xf - xr, yb });
    return spec.map((lf, k) => {
      const rows = lf.sections || [];
      if (rows.length < 2) throw new Error(`${assembled.id}: custom loft ${k} needs at least 2 sections`);
      const sections = rows.map((r) => {
        if (!Array.isArray(r) || r.length < 4) throw new Error(`${assembled.id}: custom section must be [x, yb, yt, hw, hwt?, zc?, zt?]`);
        const [x, b, t, h, ht = h, z = 0, zt = z] = r;
        return sec(clamp(x, -0.6, 0.6) * L, clamp(b, -0.5, 0.5) * H, clamp(t, -0.5, 0.9) * H,
          Math.max(0.003, h * W), Math.max(0.003, ht * W), z * W, zt * W);
      });
      for (let i = 1; i < sections.length; i++) {
        if (!(sections[i].x > sections[i - 1].x)) throw new Error(`${assembled.id}: custom loft ${k} sections must run tail to nose`);
      }
      return { sections, slot: lf.slot };
    });
  },
};

/**
 * Where a front or low horizontal rotor needs the body out of its way:
 * { x0, maxTop } (body under the bar) or { x0, minBottom } (body over it).
 */
function rotorCut(ctx, xf, xr, len) {
  const w = ctx.assembled.parts.weapon?.spec;
  const mount = ctx.mount;
  if (!w || w.class !== "spinner_h" || !(mount === "front" || mount === "low")) return null;
  const r = inToM(w.radiusIn || 6);
  const half = Math.max(0.01, inToM((w.sizeIn || [0, 2, 0])[1]) / 2);
  const yb = -ctx.H / 2;
  const cx = xf + r * (mount === "low" ? 0.3 : 0.35);
  const yc = mount === "low" ? yb + half + inToM(1) : (ctx.p.weaponY != null ? yb + ctx.H * ctx.p.weaponY : 0);
  const x0 = Math.max(xr + len * 0.4, cx - r - 0.01);
  if (x0 >= xf - 0.02) return null;
  return mount === "low"
    ? { x0, minBottom: yc + half + 0.008 }
    : { x0, maxTop: Math.max(yb + 0.025, yc - half - 0.008) };
}

/** Split a run of sections at cut.x0, clipping the front run to clear the rotor. */
function splitAt(sections, cut) {
  const at = interpSection(sections, cut.x0);
  const rear = [...sections.filter((s) => s.x < cut.x0 - 1e-6), at];
  const front = [{ ...at }, ...sections.filter((s) => s.x > cut.x0 + 1e-6)].map((s) => {
    const c = { ...s };
    if (cut.maxTop != null) c.yt = Math.max(c.yb + 0.02, Math.min(c.yt, cut.maxTop));
    if (cut.minBottom != null) c.yb = Math.min(c.yt - 0.02, Math.max(c.yb, cut.minBottom));
    return c;
  });
  return [rear, front];
}

/**
 * Where a disc or drum sits, and the slot cut for it. Real ones are never
 * hung out in front of the robot on nothing: the rotor runs in a slot in the
 * nose (Bite Force, End Game) or between pods (Witch Doctor), its axle
 * carried by a support plate on each side. Returns the rotor centre, the
 * slot (x0 = its back wall, zHalf = its half width) and where the supports go.
 * `tuck` (a weapon bay on a slotted body) sets the rotor further back in.
 */
function verticalRotor(ctx, template, lofts, { xf, xr, len, yb, tuck = 0 }) {
  const w = ctx.assembled.parts.weapon.spec;
  const r = inToM(w.radiusIn || 6);
  const g = mountGauge(r);
  let halfW = clamp(inToM((w.sizeIn || [12, 4, 12])[2]) / 2, 0.01, ctx.W / 2 - g.st - g.gap - inToM(0.5));
  let x, z0, z1;
  const pods = template === "twin" ? lofts.filter((l) => l.slot === "sideL" || l.slot === "sideR") : [];
  if (pods.length) {
    // Between the pods: the axle runs through their noses.
    const podFront = Math.max(...pods.flatMap((l) => l.sections.map((s) => s.x)));
    const inner = Math.min(...pods.flatMap((l) => l.sections.map((s) => Math.abs(s.zc) - s.hw)));
    halfW = Math.max(0.01, Math.min(halfW, inner - g.gap - 0.003));
    x = podFront - g.bossR * 1.3;
    // A solid bearing block from the disc's face out into the pod.
    z0 = halfW + g.gap;
    z1 = Math.max(z0 + g.st, inner + g.st * 0.4);
  } else {
    // In a slot in the nose, the axle a little ahead of it on the supports.
    const out = ctx.p.axleOut ?? (w.class === "drum" ? (w.style === "eggbeater" ? 0.4 : 0.45) : 0.3);
    x = xf + r * out - tuck * 0.8;
    z0 = halfW + g.gap;
  }
  // Keep a real body behind the slot: a big disc goes forward, not deeper.
  let x0 = x - r - g.clear;
  if (x0 < xr + len * 0.35) { x0 = xr + len * 0.35; x = x0 + r + g.clear; }
  return { center: { x, y: yb + r, z: 0 }, r, halfW, zHalf: halfW + g.gap, x0, minCheek: g.st,
    bossR: g.bossR, support: { z0, z1: z1 ?? z0 + g.st } };
}

/**
 * A disc or drum on a round body: a round shell cannot be slotted, so the
 * rotor stands just off the wall on two supports that run back into it. A
 * drum is narrowed to fit between them where the wall is still deep.
 */
function roundRotor(ctx, core, w, r) {
  const g = mountGauge(r);
  const R = core.radius;
  const halfW = clamp(inToM((w.sizeIn || [12, 4, 12])[2]) / 2, 0.01, R * 0.55);
  const z0 = halfW + g.gap, z1 = z0 + g.st;
  const yb = -ctx.H / 2;
  return { center: { x: R + r + g.clear * 0.5, y: yb + r, z: 0 }, r, halfW, zHalf: z0,
    xa: Math.sqrt(Math.max(0, R * R - z1 * z1)) - 0.02, bossR: g.bossR, support: { z0, z1 } };
}

/** Bearing-block sizes for a rotor of radius r: plate thickness, clearances, boss. */
function mountGauge(r) {
  return { st: inToM(1.25), gap: inToM(0.4), clear: inToM(0.6), bossR: Math.max(inToM(1.6), r * 0.16) };
}

/** Does any of these sections reach into the slot |z| < zHalf? */
function overlapsSlot(sections, zHalf) {
  return sections.some((s) => {
    const zc = s.zc ?? 0, zt = s.zt ?? zc, hwt = s.hwt ?? s.hw;
    return (zc - s.hw < zHalf && zc + s.hw > -zHalf) || (zt - hwt < zHalf && zt + hwt > -zHalf);
  });
}

/** One side's cheek of a slotted loft: each section clipped to |z| >= zHalf on side s. */
function cheekSections(sections, zHalf, s, minW) {
  const clip = (c, h) => {
    // In u = s*z, the section spans [u0, u1]; keep what is outside the slot.
    let u0 = Math.max(s * c - h, zHalf), u1 = s * c + h;
    if (u1 - u0 < minW) { u0 = zHalf; u1 = Math.max(u1, zHalf + minW); }
    return { c: s * (u0 + u1) / 2, h: (u1 - u0) / 2 };
  };
  return sections.map((sec) => {
    const zc = sec.zc ?? 0, zt = sec.zt ?? zc;
    const b = clip(zc, sec.hw), t = clip(zt, sec.hwt ?? sec.hw);
    return { ...sec, hw: b.h, zc: b.c, hwt: t.h, zt: t.c };
  });
}

function interpSection(sections, x) {
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i], b = sections[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / ((b.x - a.x) || 1);
      const l = (k, d) => (a[k] ?? d ?? a.hw) + (((b[k] ?? d ?? b.hw) - (a[k] ?? d ?? a.hw)) * t);
      const zc = l("zc", 0);
      return { x, yb: l("yb"), yt: l("yt"), hw: l("hw"), hwt: l("hwt"), zc, zt: (a.zt ?? a.zc ?? 0) + (((b.zt ?? b.zc ?? 0) - (a.zt ?? a.zc ?? 0)) * t) };
    }
  }
  return { ...sections[sections.length - 1], x };
}

/** Armour skins on a loft: one per armoured face, `t` thick, just proud of it. */
function loftPlates(sections, { armour }, suffix = "") {
  const out = [];
  const t = armour;
  const zc = (s) => s.zc ?? 0;
  const zt = (s) => s.zt ?? s.zc ?? 0;
  // Sides: the whole side profile, thickened outward.
  for (const [slot, s] of [["sideL", 1], ["sideR", -1]]) {
    if (!armour) break;
    const pts = [];
    for (const sec of sections) {
      for (const off of [0, t]) {
        pts.push({ x: sec.x, y: sec.yb + 0.004, z: zc(sec) + s * (sec.hw + off) });
        pts.push({ x: sec.x, y: sec.yt - 0.004, z: zt(sec) + s * ((sec.hwt ?? sec.hw) + off) });
      }
    }
    out.push({ id: `plate:${slot}${suffix}`, slot, role: "armor", points: pts });
  }
  // Top strips, classified by which way they face.
  const groups = { top: [], front: [], rear: [] };
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i], b = sections[i + 1];
    const dx = b.x - a.x, dy = b.yt - a.yt;
    const l = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / l, y: dx / l };
    const slot = n.y >= 0.8 ? "top" : n.x > 0 ? "front" : "rear";
    for (const sec of [a, b]) {
      for (const off of [0, t]) {
        groups[slot].push({ x: sec.x + n.x * off, y: sec.yt + n.y * off, z: zt(sec) + (sec.hwt ?? sec.hw) * 0.98 });
        groups[slot].push({ x: sec.x + n.x * off, y: sec.yt + n.y * off, z: zt(sec) - (sec.hwt ?? sec.hw) * 0.98 });
      }
    }
  }
  // End caps: nose face to the front plate, tail face to the rear.
  const nose = sections[sections.length - 1], tail = sections[0];
  if (nose.yt - nose.yb > 0.02) groups.front.push(...capPts(nose, +1, t));
  if (tail.yt - tail.yb > 0.02) groups.rear.push(...capPts(tail, -1, t));
  for (const [slot, pts] of Object.entries(groups)) {
    if (pts.length >= 8 && armour) out.push({ id: `plate:${slot}${suffix}`, slot, role: "armor", points: pts });
  }
  return out;
}

function capPts(sec, dir, t) {
  const pts = [];
  const z0 = sec.zc ?? 0, z1 = sec.zt ?? z0;
  for (const off of [0, t]) {
    const x = sec.x + dir * off;
    pts.push({ x, y: sec.yb + 0.004, z: z0 + sec.hw * 0.97 }, { x, y: sec.yb + 0.004, z: z0 - sec.hw * 0.97 });
    pts.push({ x, y: sec.yt, z: z1 + (sec.hwt ?? sec.hw) * 0.97 }, { x, y: sec.yt, z: z1 - (sec.hwt ?? sec.hw) * 0.97 });
  }
  return pts;
}

/**
 * Round bodies (shells, domes, turrets): a polygonal drum with a domed lid.
 * Armour plates are arcs of the wall by direction, and the lid.
 */
function roundCore({ L, H, W, p, armour }) {
  const n = Math.round(clamp(p.sides ?? 10, 6, 16));
  // `radius` shrinks the drum inside the chassis envelope, e.g. so a rotor
  // round its middle is exposed.
  const R = (Math.min(L, W) / 2) * clamp(p.radius ?? 1, 0.5, 1);
  const wallH = H * clamp(p.wall ?? 0.6, 0.3, 1);
  const domeH = H - wallH;
  const yb = -H / 2, yw = yb + wallH;
  const ring = (r, y, phase = 0) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + phase;
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r };
  });
  // `top`: "dome" (default), "cone" (a puck with a raked edge) or "flat".
  const lid = p.top || "dome";
  const upper = lid === "flat" ? [[R, 1]] : lid === "cone" ? [[R * 0.55, 1]] : [[R * 0.62, 0.75], [R * 0.25, 1]];
  const core = [...ring(R, yb), ...ring(R, yw)];
  if (domeH > 0.005) for (const [r, f] of upper) core.push(...ring(r, yw + domeH * f));
  const pieces = [{ id: "core", slot: "core", role: "body", points: core }];
  if (armour) {
    const arcs = { front: [-45, 45], sideL: [45, 135], rear: [135, 225], sideR: [225, 315] };
    for (const [slot, [a0, a1]] of Object.entries(arcs)) {
      const pts = [];
      for (let k = 0; k <= 4; k++) {
        const a = degToRad(a0 + ((a1 - a0) * k) / 4);
        for (const r of [R + 0.002, R + armour]) {
          for (const y of [yb + 0.01, yw]) pts.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r });
        }
      }
      pieces.push({ id: `plate:${slot}`, slot, role: "armor", points: pts });
    }
    if (domeH > 0.005) {
      const [r0, f0] = upper[0], [r1] = upper[upper.length - 1];
      pieces.push({ id: "plate:top", slot: "top", role: "armor", points: lid === "dome"
        ? [...ring(R * 0.62, yw + domeH * 0.75 + 0.002), ...ring(R * 0.25, yw + domeH + armour)]
        : [...ring(r1 * 0.98, yw + domeH * f0 + 0.002), ...ring(r1 * 0.98, yw + domeH + armour)] });
    }
  }
  return { pieces, frontX: R, topY: H / 2, frontBottomY: yb, round: true, radius: R, wallTopY: yw };
}

// ---------------------------------------------------------------- extras

function extraPieces(ex, ctx, core) {
  const { L, H, W, assembled } = ctx;
  const st = assembled.stats;
  const top = core.topY;
  const nose = core.frontX;
  const yb = -H / 2;
  const id = (k) => `extra:${ex.type}:${k}`;
  // The top surface under x: on a wedge it falls away towards the nose, and
  // anything mounted there has to follow it rather than float.
  const topAt = (x, z = 0) => (core.topAt ? core.topAt(x, z) : top);
  const out = [];

  switch (ex.type) {
    case "forks": {
      // Low prongs off the nose: wedgelets that get under the opponent.
      const n = Math.round(clamp(ex.count ?? 2, 1, 5));
      const len = inToM(ex.lengthIn ?? 8);
      const w = inToM(ex.widthIn ?? 2.5);
      const spread = (W / 2) * clamp(ex.spread ?? 0.8, 0, 1);
      const rise = Math.min(inToM(ex.heightIn ?? 2.5), H * 0.6);
      for (let i = 0; i < n; i++) {
        const z = n === 1 ? 0 : -spread + (2 * spread * i) / (n - 1);
        const x0 = nose - 0.01;
        out.push({ id: id(i), slot: "wedge", role: "metal", points: [
          { x: x0, y: yb, z: z - w / 2 }, { x: x0, y: yb, z: z + w / 2 },
          { x: x0, y: yb + rise, z: z - w / 2 }, { x: x0, y: yb + rise, z: z + w / 2 },
          { x: x0 + len, y: yb, z: z - w / 2 }, { x: x0 + len, y: yb, z: z + w / 2 },
          { x: x0 + len, y: yb + 0.006, z: z - w / 2 }, { x: x0 + len, y: yb + 0.006, z: z + w / 2 },
        ] });
      }
      break;
    }
    case "wheelGuards": {
      // Armoured pods round the tyres, the full length of the wheelbase.
      const r = st.wheelRadiusM;
      const zIn = W / 2, zOut = st.trackHalfM + inToM(ctx.assembled.parts.wheel.spec.widthIn) * 0.6 + 0.01;
      const x0 = -st.wheelbaseHalfM - r * 1.1, x1 = Math.max(nose, st.wheelbaseHalfM + r * 1.1) + inToM(ex.forwardIn ?? 0);
      const yTop = Math.min(top, yb + clamp(ex.height ?? 0.85, 0.3, 1) * H);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        // Open underneath (the tyre needs the floor), so it is a hood: top
        // plate plus outer wall, as one convex hull from the deck line up.
        out.push({ id: id(k), slot: "guard", role: "trim", points: [
          ...[x0, x1].flatMap((x) => [
            { x, y: yb + 0.01, z: s * zOut }, { x, y: yTop, z: s * zOut },
            { x, y: yTop, z: s * zIn }, { x, y: yb + 0.01, z: s * (zOut - 0.012) },
          ]),
        ] });
      }
      break;
    }
    case "uprights": {
      // Twin posts carrying a front weapon, Tombstone-style.
      const h = inToM(ex.heightIn ?? 6);
      const xp = nose - inToM(3);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        out.push({ id: id(k), slot: "front", role: "trim", points: boxPts(xp, top + h / 2 - 0.01, s * W * 0.32, inToM(2), h / 2, inToM(1.5)) });
      }
      break;
    }
    case "mast": {
      const h = inToM(ex.heightIn ?? 8);
      const x = inToM(ex.xIn ?? 0);
      out.push({ id: id(0), slot: "top", role: "trim", points: boxPts(x, topAt(x) + h / 2 - 0.01, 0, inToM(2.5), h / 2, inToM(2.5)) });
      break;
    }
    case "fin": {
      const h = inToM(ex.heightIn ?? 6), len = L * clamp(ex.length ?? 0.5, 0.15, 0.9);
      const x0 = -L / 2 + L * 0.08;
      out.push({ id: id(0), slot: "top", role: "accent", points: [
        { x: x0, y: top - 0.005, z: inToM(0.5) }, { x: x0, y: top - 0.005, z: -inToM(0.5) },
        { x: x0 + len, y: top - 0.005, z: inToM(0.5) }, { x: x0 + len, y: top - 0.005, z: -inToM(0.5) },
        { x: x0 + len * 0.2, y: top + h, z: inToM(0.4) }, { x: x0 + len * 0.2, y: top + h, z: -inToM(0.4) },
      ] });
      break;
    }
    case "spikes": {
      const n = Math.round(clamp(ex.count ?? 3, 1, 6));
      const len = inToM(ex.lengthIn ?? 4), r = inToM(1.2);
      const y = (core.frontBottomY + (core.noseTopY ?? top)) / 2;
      for (let i = 0; i < n; i++) {
        const z = n === 1 ? 0 : -W * 0.38 + (W * 0.76 * i) / (n - 1);
        out.push({ id: id(i), slot: "front", role: "metal", points: [
          { x: nose - 0.01, y: y - r, z: z - r }, { x: nose - 0.01, y: y + r, z: z - r },
          { x: nose - 0.01, y: y - r, z: z + r }, { x: nose - 0.01, y: y + r, z: z + r },
          { x: nose + len, y, z },
        ] });
      }
      break;
    }
    case "tail": {
      // A scorpion tail curling up over the back, in two segments.
      const h = inToM(ex.heightIn ?? 14), w = inToM(2.5);
      const xr = -L / 2;
      out.push({ id: id(0), slot: "rear", role: "trim",
        points: boxCorners(xr + 0.02, top - 0.01, w / 2, xr - inToM(4), top + h * 0.55, -w / 2) });
      out.push({ id: id(1), slot: "rear", role: "accent",
        points: boxCorners(xr - inToM(4), top + h * 0.5, w * 0.35, xr + inToM(3), top + h, -w * 0.35) });
      break;
    }
    case "stack": {
      const h = inToM(ex.heightIn ?? 7), r = inToM(ex.radiusIn ?? 2.2);
      out.push({ id: id(0), slot: "top", role: "trim", points: cylPts({ x: L * 0.22, y: topAt(L * 0.22) + h / 2 - 0.005, z: 0 }, "y", r, h / 2, 10) });
      break;
    }
    case "eyes": {
      const r = inToM(ex.radiusIn ?? 2.2);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        out.push({ id: id(k), slot: "top", role: "accent", points: cylPts({ x: L * 0.18, y: topAt(L * 0.18, s * W * 0.25) + r * 0.9, z: s * W * 0.25 }, "y", r, r * 0.9, 10) });
      }
      break;
    }
    case "dome": {
      const R = Math.min(L, W) * clamp(ex.size ?? 0.3, 0.1, 0.48), h = inToM(ex.heightIn ?? 5);
      const c = { x: inToM(ex.xIn ?? 0), z: 0 };
      const pts = [];
      const t0 = Math.min(topAt(c.x - R), topAt(c.x + R));
      for (const [r, y] of [[R, t0 - 0.005], [R * 0.8, t0 + h * 0.6], [R * 0.35, t0 + h]]) {
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          pts.push({ x: c.x + Math.cos(a) * r, y, z: Math.sin(a) * r });
        }
      }
      out.push({ id: id(0), slot: "top", role: "trim", points: pts });
      break;
    }
    case "plow": {
      // A scoop wider than the body, raking forward - the wide shovel nose.
      const len = inToM(ex.lengthIn ?? 9), h = Math.min(inToM(ex.heightIn ?? 6), H * 0.95);
      const half = W / 2 + inToM(ex.overhangIn ?? 4);
      const x0 = nose - 0.01;
      out.push({ id: id(0), slot: "wedge", role: "metal", points: [
        { x: x0, y: yb, z: half }, { x: x0, y: yb, z: -half },
        { x: x0, y: yb + h, z: half }, { x: x0, y: yb + h, z: -half },
        { x: x0 + len, y: yb, z: half * 0.92 }, { x: x0 + len, y: yb, z: -half * 0.92 },
        { x: x0 + len, y: yb + 0.006, z: half * 0.92 }, { x: x0 + len, y: yb + 0.006, z: -half * 0.92 },
      ] });
      break;
    }
    case "legs": {
      // A walker's legs: three a side, standing in the wheel arches.
      const n = 3, legH = st.wheelRadiusM * 1.6, w = inToM(2);
      for (let i = 0; i < n; i++) {
        const x = -L * 0.35 + (L * 0.7 * i) / (n - 1);
        for (const [k, s] of [["L", 1], ["R", -1]]) {
          out.push({ id: id(`${k}${i}`), slot: "guard", role: "trim", points: [
            ...boxCorners(x - w, yb + legH * 0.15, s * (W / 2), x + w, yb + legH * 0.9, s * (W / 2 + inToM(3))),
          ] });
        }
      }
      break;
    }
    case "hump": {
      // A raised cab at the back.
      const h = inToM(ex.heightIn ?? 4), len = L * clamp(ex.length ?? 0.35, 0.15, 0.6);
      const x1 = -L / 2 + len, x0 = -L / 2 + 0.01;
      out.push({ id: id(0), slot: "top", role: "trim", points: [
        ...boxCorners(x0, top - 0.005, W * 0.36, x1, top + h, -W * 0.36),
        { x: x1 + h * 0.8, y: top - 0.005, z: W * 0.3 }, { x: x1 + h * 0.8, y: top - 0.005, z: -W * 0.3 },
      ] });
      break;
    }
    case "cage": {
      // A roll hoop over the top, so the bot lands on its cage when flipped.
      const h = inToM(ex.heightIn ?? 5), w = inToM(1.5);
      for (const [k, x] of [["F", L * 0.2], ["R", -L * 0.3]]) {
        out.push({ id: id(k), slot: "top", role: "metal", points: boxCorners(x - w, top - 0.005, W * 0.42, x + w, top + h, -W * 0.42) });
      }
      break;
    }
    case "wings": {
      // Flat side wings out over the wheels, like a hydroplane.
      const len = L * clamp(ex.length ?? 0.6, 0.2, 0.95), reach = inToM(ex.reachIn ?? 4);
      const y = Math.min(top, yb + 2 * st.wheelRadiusM - st.groundClearanceM + 0.01);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        out.push({ id: id(k), slot: "guard", role: "accent", points: boxCorners(-len / 2, y - 0.012, s * (W / 2 - 0.01), len / 2, y, s * (st.trackHalfM + reach)) });
      }
      break;
    }
    case "pod":
      // Built with the weapon, which knows where the hub is (weaponGeometry).
      break;
    case "horns": {
      // A pair of horns off the top front corners, raking up and forward.
      const h = inToM(ex.heightIn ?? 7), r = inToM(ex.baseIn ?? 2.2);
      const x0 = nose - inToM(ex.backIn ?? 5);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        const z = s * W * clamp(ex.spread ?? 0.32, 0.1, 0.48);
        out.push({ id: id(k), slot: "top", role: ex.role || "metal", points: [
          ...boxPts(x0, topAt(x0, z) - 0.005 + r * 0.4, z, r, r * 0.4, r),
          { x: x0 + inToM(ex.forwardIn ?? 4), y: topAt(x0, z) + h, z: z + s * inToM(ex.outIn ?? 2) },
        ] });
      }
      break;
    }
    case "ears": {
      // Two upright triangles on the top, for the animal bots.
      const h = inToM(ex.heightIn ?? 4), b = inToM(ex.baseIn ?? 3), t = inToM(1);
      const x = L * clamp(ex.x ?? 0.15, -0.45, 0.45);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        const z = s * W * clamp(ex.spread ?? 0.3, 0.05, 0.48);
        out.push({ id: id(k), slot: "top", role: ex.role || "accent", points: [
          { x: x - b / 2, y: topAt(x - b / 2, z) - 0.005, z: z - t }, { x: x - b / 2, y: topAt(x - b / 2, z) - 0.005, z: z + t },
          { x: x + b / 2, y: topAt(x + b / 2, z) - 0.005, z: z - t }, { x: x + b / 2, y: topAt(x + b / 2, z) - 0.005, z: z + t },
          { x: x - b * 0.15, y: topAt(x, z) + h, z }, { x: x - b * 0.15, y: topAt(x, z) + h, z: z + 0.001 },
        ] });
      }
      break;
    }
    case "spines": {
      // A row of low pyramids down the spine.
      const n = Math.round(clamp(ex.count ?? 4, 1, 8)), h = inToM(ex.heightIn ?? 3.5) + ctx.armour, b = inToM(ex.baseIn ?? 3.5);
      const x0 = -L / 2 + L * 0.15, x1 = -L / 2 + L * clamp(ex.length ?? 0.7, 0.2, 0.95);
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1);
        out.push({ id: id(i), slot: "top", role: ex.role || "accent", points: [
          ...boxPts(x, Math.min(topAt(x - b / 2), topAt(x + b / 2)) - 0.003, 0, b / 2, 0.003, b / 2), { x: x - b * 0.2, y: topAt(x) + h, z: 0 },
        ] });
      }
      break;
    }
    case "bumper": {
      // A rear bumper across the tail, low.
      const d = inToM(ex.depthIn ?? 1.5), h = H * clamp(ex.height ?? 0.4, 0.15, 0.9);
      out.push({ id: id(0), slot: "rear", role: ex.role || "trim",
        points: boxCorners(-L / 2 - d, yb + 0.012, W * 0.44, -L / 2 + 0.01, yb + h, -W * 0.44) });
      break;
    }
    default:
      throw new Error(`${assembled.id}: unknown body extra "${ex.type}"`);
  }
  return out;
}

// ---------------------------------------------------------------- weapons

/**
 * Where the weapon sits and what it sweeps.
 *
 * The CLASSIC placements are kept exactly as they were (a spinner centred
 * 0.35 r past the nose, a vertical disc or drum touching the floor, and so on),
 * so the old test bots fight exactly as before. Sculpted bodies pick a `mount`.
 *
 * colliders: { type: "cylinder", center, axis, radius, halfHeight }
 *          | { type: "cuboid", center, half }
 *          | { type: "hull", points }
 */
function weaponGeometry(assembled, ctx, core, mountIn) {
  const weapon = assembled.parts.weapon;
  if (!weapon) return null;
  const w = weapon.spec;
  const { H, W } = ctx;
  const [wl, wh, ww] = (w.sizeIn || [12, 4, 12]).map(inToM);
  const nose = core.frontX;
  const top = core.topY;
  const yb = -H / 2;
  const mount = mountIn || defaultMount(w.class);
  const out = { class: w.class, mount, colliders: [], visual: null, pieces: [] };

  if (w.class === "static") {
    // The wedge: a triangular prism off the nose, its rear meeting the body.
    const ramp = degToRad(w.rampAngleDeg || 15);
    const run = wl * Math.cos(ramp), rise = wl * Math.sin(ramp);
    const x0 = nose, y0 = core.frontBottomY ?? yb, hw = Math.min(ww, W * 1.1) / 2;
    const points = [
      { x: x0, y: y0, z: +hw }, { x: x0 + run, y: y0, z: +hw }, { x: x0, y: y0 + rise, z: +hw },
      { x: x0, y: y0, z: -hw }, { x: x0 + run, y: y0, z: -hw }, { x: x0, y: y0 + rise, z: -hw },
    ];
    out.pieces.push({ id: "weapon:wedge", slot: "weapon", role: "metal", points });
    out.visual = { kind: "wedge" };
    out.wedge = { lengthM: wl, heightM: wh, widthM: hw * 2, rampRad: ramp, run, rise, x0, y0 };
    return out;
  }

  if (!w.powered) return out;

  const r = inToM(w.radiusIn || 6);
  if (w.class === "spinner_h") {
    const half = Math.max(0.01, wh / 2);
    let center;
    if (mount === "shell") center = { x: 0, y: yb + H * 0.35, z: 0 };
    else if (mount === "overhead") center = { x: nose - r * 0.55, y: top + inToM(3) + half, z: 0 };
    else if (mount === "low") center = { x: nose + r * 0.3, y: yb + half + inToM(1), z: 0 };
    else center = { x: nose + r * 0.35, y: ctx.p.weaponY != null ? yb + H * ctx.p.weaponY : 0, z: 0 };
    if (core.classic) center = { x: nose + r * 0.35, y: 0, z: 0 };
    const halfH = mount === "shell" ? Math.max(half, H * 0.32) : half;
    out.colliders.push({ type: "cylinder", center, axis: "y", radius: r, halfHeight: halfH });
    out.visual = { kind: "rotor", axis: "y", center, radius: r, thickness: halfH * 2, style: rotorStyle(w, mount, wl, r) };
    if ((mount === "front" || mount === "low" || core.classic) && !core.round) {
      // The bar's shaft is carried in bearings above and below it, Tombstone-
      // style: plates from the body out over (and under) the hub, clear of
      // the sweep, so the bar never hangs off the nose on nothing. A `pod`
      // extra tunes the top one; an undercutter has only the top one, as
      // its bar runs at the floor.
      const pod = ctx.body?.extras?.find((e) => e.type === "pod") || {};
      const hubR = Math.max(inToM(2.5), r * 0.2);
      const x0 = Math.max(-ctx.L / 2, center.x - r - 0.03), x1 = center.x + hubR * 1.1;
      const hw0 = Math.min(W * 0.3, hubR * (pod.width ?? 1.3)), hw1 = hubR * 1.05;
      const plate = (id, y0, y1) => ({ id, slot: "front", role: pod.role || "metal", points: [
        { x: x0, y: y0, z: hw0 }, { x: x0, y: y0, z: -hw0 }, { x: x0, y: y1, z: hw0 }, { x: x0, y: y1, z: -hw0 },
        { x: x1, y: y0, z: hw1 }, { x: x1, y: y0, z: -hw1 }, { x: x1, y: y1, z: hw1 }, { x: x1, y: y1, z: -hw1 },
      ] });
      const yTop = center.y + half + 0.006;
      out.pieces.push(plate("extra:pod:0", yTop, yTop + inToM(pod.thickIn ?? 1.2)));
      const yBot = center.y - half - 0.006;
      const shaft = { y0: center.y - half - 0.004, y1: yTop + 0.002, r: hubR * 0.42 };
      if (mount === "front" && yBot - (yb + 0.004) > 0.012) {
        out.pieces.push(plate("weapon:bearing", yb + 0.004, yBot));
        shaft.y0 = yBot - 0.002;
      }
      out.visual.shaft = shaft;
    }
    if (mount === "overhead") {
      // The mast it spins on.
      const base = core.topAt ? core.topAt(center.x) : top;
      const mastH = center.y - base;
      out.pieces.push({ id: "weapon:mast", slot: "top", role: "trim", points: boxPts(center.x, base + mastH / 2 - 0.005, 0, inToM(2), mastH / 2, inToM(2)) });
    }
  } else if (w.class === "spinner_v" || w.class === "drum") {
    let halfW = Math.max(0.01, ww / 2);
    const bay = core.bayX || 0;
    // Discs and drums ride just off the floor in front of (or in) the nose.
    let center = { x: nose + r * (w.class === "drum" ? 0.6 : 0.5), y: yb + r, z: 0 };
    if (core.classic) center = { x: nose + r * 0.5, y: yb + r, z: 0 };
    else if (bay > 0) center = { x: nose + Math.min(bay, r) * 0.8, y: yb + r + 0.004, z: 0 };
    if (mount === "high") center.y = Math.max(center.y, top - r * 0.3);
    // Sculpted bodies carry the rotor on an axle between two supports: in
    // the slot loftCore cut for it, or standing off a round body's wall.
    const vr = core.vrot || (core.round && mount !== "high" ? roundRotor(ctx, core, w, r) : null);
    if (vr) { center = vr.center; halfW = vr.halfW; }
    out.colliders.push({ type: "cylinder", center, axis: "z", radius: r, halfHeight: halfW });
    out.visual = { kind: "rotor", axis: "z", center, radius: r, thickness: halfW * 2,
      style: w.class === "drum" ? (w.style || "drum") : (w.style || "disc") };
    if (vr) {
      const { z0, z1 } = vr.support;
      // From inside the body (where the slot starts) up or down to the boss
      // round the axle. Outside the rotor's width, so it never cuts the sweep.
      const xa = vr.xa ?? Math.max(vr.x0 + 0.005, center.x - r * 0.8);
      for (const [k, s] of [["L", 1], ["R", -1]]) {
        const zm = s * (z0 + z1) / 2;
        const ya = Math.max(core.topAt ? core.topAt(xa, zm) : (core.wallTopY ?? top), yb + 0.03);
        const pts = [];
        for (const z of [s * z0, s * z1]) {
          pts.push({ x: xa, y: yb + 0.004, z }, { x: xa, y: ya, z }, { x: center.x - vr.bossR * 0.3, y: yb + 0.004, z });
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            pts.push({ x: center.x + Math.cos(a) * vr.bossR, y: center.y + Math.sin(a) * vr.bossR, z });
          }
        }
        out.pieces.push({ id: `weapon:support:${k}`, slot: "front", role: "trim", points: pts });
      }
      out.visual.axle = { halfLen: z1 + 0.004, radius: Math.max(0.01, vr.bossR * 0.42), bossR: vr.bossR };
    }
  } else if (w.class === "hammer") {
    const reach = inToM(w.reachIn || 20);
    let pivot, head;
    if (core.classic) {
      pivot = { x: nose * 0.2, y: H / 2, z: 0 };
      head = { x: nose + reach * 0.45, y: H / 2, z: 0 };
      out.colliders.push({ type: "cuboid", center: head, half: { x: wl / 2 * 0.3, y: wh / 2 * 0.25, z: ww / 2 } });
    } else {
      // Pivot over the back, head parked forward over the nose where it lands.
      pivot = { x: Math.max(-ctx.L / 2 + 0.05, nose - reach * 0.85), y: top + inToM(2), z: 0 };
      head = { x: pivot.x + reach, y: pivot.y, z: 0 };
      out.colliders.push({ type: "cuboid", center: head, half: { x: wl / 2 * 0.3, y: wh / 2 * 0.25, z: ww / 2 } });
      // The pivot block stands on whatever is under it (a deck, a cab roof).
      const base = core.topAt ? Math.min(top, core.topAt(pivot.x)) : top;
      out.pieces.push({ id: "weapon:pivot", slot: "top", role: "trim", points: boxPts(pivot.x, (base + pivot.y) / 2 + 0.01, 0, inToM(2.5), (pivot.y - base) / 2 + inToM(1.5), inToM(3)) });
    }
    out.visual = { kind: "arm", pivot, reach: head.x - pivot.x, head: { l: wl * 0.3, h: wh * 0.3, w: ww }, style: w.style || "axe" };
  } else {
    // Flipper, lifter, crusher: a plate or jaw across the nose.
    const center = core.classic
      ? { x: nose + wl * 0.12, y: yb + wh / 2, z: 0 }
      : { x: nose + wl * 0.12, y: (core.frontBottomY ?? yb) + wh / 2, z: 0 };
    const half = { x: wl / 2 * 0.25, y: Math.max(0.01, wh / 2), z: Math.min(ww, W) / 2 };
    out.colliders.push({ type: "cuboid", center, half });
    out.visual = {
      kind: w.class === "crusher" ? "jaw" : "plate", center, size: { l: wl * 0.5, h: Math.max(0.02, wh), w: half.z * 2 },
      strokeM: inToM(w.strokeIn ?? 1.2), style: w.style || w.class, lid: mount === "lid", top,
      // A lid flipper's plate covers the top of the bot back to its hinge.
      hingeX: -ctx.L / 2 + ctx.L * 0.15,
    };
  }
  return out;
}

function defaultMount(cls) {
  return { spinner_h: "front", spinner_v: "front", drum: "front", hammer: "top",
    flipper: "front", lifter: "front", crusher: "front" }[cls] || "front";
}

function rotorStyle(w, mount, wl, r) {
  if (w.style) return w.style;
  if (mount === "shell") return "shell";
  return wl > r * 1.6 ? "bar" : "disc";
}

// ---------------------------------------------------------------- geometry helpers

function armourThickness(assembled) {
  const t = assembled.parts.armor.map((a) => inToM(a.spec.thicknessIn ?? 0.25));
  return t.length ? Math.max(0.008, Math.min(0.02, Math.max(...t))) : 0;
}

function sectionPts(s) {
  const hwt = s.hwt ?? s.hw, z = s.zc ?? 0, zt = s.zt ?? z;
  return [
    { x: s.x, y: s.yb, z: z + s.hw }, { x: s.x, y: s.yb, z: z - s.hw },
    { x: s.x, y: s.yt, z: zt + hwt }, { x: s.x, y: s.yt, z: zt - hwt },
  ];
}

export function boxPts(cx, cy, cz, hx, hy, hz) {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push({ x: cx + sx * hx, y: cy + sy * hy, z: cz + sz * hz });
  }
  return out;
}

/** Box from two opposite corners. */
function boxCorners(x0, y0, z0, x1, y1, z1) {
  return boxPts((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
    Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
}

/** A polygonal cylinder as points, axis "x" | "y" | "z". */
export function cylPts(c, axis, r, halfH, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const u = Math.cos(a) * r, v = Math.sin(a) * r;
    for (const h of [-halfH, halfH]) {
      if (axis === "y") out.push({ x: c.x + u, y: c.y + h, z: c.z + v });
      else if (axis === "x") out.push({ x: c.x + h, y: c.y + u, z: c.z + v });
      else out.push({ x: c.x + u, y: c.y + v, z: c.z + h });
    }
  }
  return out;
}

/** Bounding points of a weapon collider, for the invertibility check. */
function colliderExtremes(c) {
  if (c.type === "cylinder") return cylPts(c.center, c.axis, c.radius, c.halfHeight, 8);
  if (c.type === "cuboid") return boxPts(c.center.x, c.center.y, c.center.z, c.half.x, c.half.y, c.half.z);
  return c.points;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
