// materials.js - shared Three.js materials, with procedurally generated maps.
//
// No external texture files: every map is drawn into a canvas at boot. That
// keeps the game a single folder of text, runs from file:// and makes the
// whole look tweakable from code. Materials are keyed by the `material`
// strings used in parts.json and arena.json, so data picks the look.
//
// Art direction: STYLISED, not photoreal. Clean panels, readable shapes, a
// restrained amount of wear. An earlier pass went full photoreal grime - a
// hundred gouges per floor tile, oil slicks, rust creep - and the floor ended
// up so busy it read as noise rather than as a steel deck.
//
// Wear levels come from arena.json's `style` block, so the whole look is a data
// edit: `floorWear` 0 is factory-new, 1 is that old photoreal pass.

import * as THREE from "three";

const cache = new Map();

/** Draw into an offscreen canvas. Returns the canvas itself. */
function paint(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  return c;
}

function texFrom(canvas, repeat, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/**
 * Sobel a grayscale height canvas into a tangent-space normal map.
 * Cheap, and it is what sells dents and gouges under a moving key light.
 */
function normalFromHeight(heightCanvas, strength = 2.2) {
  const s = heightCanvas.width;
  const src = heightCanvas.getContext("2d").getImageData(0, 0, s, s).data;
  const out = document.createElement("canvas");
  out.width = out.height = s;
  const img = out.getContext("2d").createImageData(s, s);

  const h = (x, y) => {
    const xi = (x + s) % s, yi = (y + s) % s;
    return src[(yi * s + xi) * 4] / 255;
  };

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // 3x3 Sobel in both directions.
      const dx = (h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1)) -
                 (h(x - 1, y - 1) + 2 * h(x - 1, y) + h(x - 1, y + 1));
      const dy = (h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) -
                 (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * s + x) * 4;
      img.data[i]     = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

// --- small drawing helpers -------------------------------------------------

const rnd = (a, b) => a + Math.random() * (b - a);

/** Irregular blotch, for oil, rust and scorch. */
function blotch(g, x, y, r, fill) {
  g.beginPath();
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r * rnd(0.55, 1.25);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** A gouge: a bright scrape with a dark shadow beside it. */
function gouge(g, s, len, width) {
  const x = rnd(0, s), y = rnd(0, s), a = rnd(0, Math.PI * 2);
  const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
  g.lineCap = "round";
  g.strokeStyle = `rgba(16,16,19,${rnd(0.35, 0.7)})`;
  g.lineWidth = width * 1.8;
  g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
  g.strokeStyle = `rgba(${rnd(180, 225) | 0},${rnd(180, 225) | 0},${rnd(190, 235) | 0},${rnd(0.3, 0.65)})`;
  g.lineWidth = width;
  g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
  return { x, y, ex, ey, width };
}

// --- the arena floor -------------------------------------------------------

/** Battered steel deck: seams, welds, rust, oil, scorch, rubber, gouges. */
function steelFloorMaps(repeat, wear = 0.22) {
  const S = 1024;
  const scars = [];

  const albedo = paint(S, (g, s) => {
    // Base: a clean, slightly blue steel deck. Lighter than before, because the
    // old one plus heavy grime left the arena reading almost black.
    g.fillStyle = "#565d68";
    g.fillRect(0, 0, s, s);

    // Broad tonal variation so it never reads as flat grey - kept, because this
    // is the part that makes it look like metal rather than like paint.
    for (let i = 0; i < Math.round(70 * (0.4 + wear)); i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(60, 260);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const v = rnd(0, 1) > 0.5 ? "70,74,82" : "26,28,33";
      grd.addColorStop(0, `rgba(${v},${rnd(0.08, 0.3)})`);
      grd.addColorStop(1, `rgba(${v},0)`);
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    // Fine grain, much lighter than the old pass.
    for (let i = 0; i < 18000; i++) {
      const v = rnd(80, 125) | 0;
      g.fillStyle = `rgba(${v},${v + 2},${v + 7},0.14)`;
      g.fillRect(rnd(0, s), rnd(0, s), 2, 2);
    }

    // Plate seams on a 4-plate grid, with weld beads and grime in the gaps.
    for (let i = 1; i < 4; i++) {
      const p = (s / 4) * i;
      g.strokeStyle = "rgba(28,30,36,0.75)";
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
      // A touch of grime in the seam, not a smear across the plate.
      g.strokeStyle = `rgba(26,24,22,${0.1 + 0.18 * wear})`;
      g.lineWidth = 10;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
      // weld beads
      for (let q = 0; q < s; q += 13) {
        g.fillStyle = `rgba(${rnd(120, 165) | 0},${rnd(115, 160) | 0},${rnd(110, 150) | 0},0.55)`;
        g.beginPath(); g.arc(p + rnd(-1, 1), q, rnd(1.6, 3), 0, 7); g.fill();
        g.beginPath(); g.arc(q, p + rnd(-1, 1), rnd(1.6, 3), 0, 7); g.fill();
      }
    }

    // Rust, only where the wear level asks for it.
    for (let i = 0; i < Math.round(46 * wear); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(14, 64),
        `rgba(${rnd(96, 150) | 0},${rnd(50, 80) | 0},${rnd(22, 40) | 0},${rnd(0.1, 0.34)})`);
    }

    // Oil and hydraulic stains - dark, slick, with a faint rainbow edge.
    for (let i = 0; i < Math.round(20 * wear); i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(22, 78);
      blotch(g, x, y, r, `rgba(10,9,12,${rnd(0.3, 0.62)})`);
      blotch(g, x, y, r * 0.62, `rgba(${rnd(30, 70) | 0},${rnd(40, 80) | 0},${rnd(50, 90) | 0},0.18)`);
    }

    // Scorch marks where something burned.
    for (let i = 0; i < Math.round(12 * wear); i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(26, 90);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, "rgba(8,7,7,0.72)");
      grd.addColorStop(0.55, "rgba(28,22,18,0.4)");
      grd.addColorStop(1, "rgba(28,22,18,0)");
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    // Rubber laid down by spinning wheels.
    for (let i = 0; i < Math.round(46 * wear); i++) {
      g.strokeStyle = `rgba(14,13,14,${rnd(0.12, 0.42)})`;
      g.lineWidth = rnd(3, 11);
      g.beginPath();
      g.arc(rnd(0, s), rnd(0, s), rnd(16, 150), rnd(0, 7), rnd(0, 7));
      g.stroke();
    }

    // Spinner gouges. 90 per tile x a 4x4 repeat was ~1500 scars across the
    // floor, which is what made it look like static. A handful reads as
    // "fights happen here"; a thousand reads as noise.
    for (let i = 0; i < Math.round(26 * wear); i++) {
      scars.push(gouge(g, s, rnd(30, 150), rnd(1.0, 3.0)));
    }
    for (let i = 0; i < Math.round(6 * wear); i++) {
      scars.push(gouge(g, s, rnd(90, 240), rnd(3, 6)));
    }
  });

  // Height: seams recessed, welds proud, gouges cut in.
  //
  // Drawn at half the albedo's resolution on purpose. The Sobel pass that turns
  // it into a normal map is the only costly thing at boot, and it scales with
  // pixel count - a normal map carries fine detail perfectly well at 512.
  // Scar coordinates are scaled to match.
  const HS = S / 2;
  const k = HS / S;
  const height = paint(HS, (g, s) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2400; i++) {
      const v = rnd(110, 150) | 0;
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.beginPath(); g.arc(rnd(0, s), rnd(0, s), rnd(2, 16), 0, 7); g.fill();
    }
    for (let i = 1; i < 4; i++) {
      const p = (s / 4) * i;
      g.strokeStyle = "#4a4a4a";
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
      for (let q = 0; q < s; q += 13) {
        g.fillStyle = "#b4b4b4";
        g.beginPath(); g.arc(p, q, 2.4, 0, 7); g.fill();
        g.beginPath(); g.arc(q, p, 2.4, 0, 7); g.fill();
      }
    }
    // Cut the same gouges the albedo drew, scaled to this canvas.
    g.lineCap = "round";
    for (const sc of scars) {
      g.strokeStyle = "#3a3a3a";
      g.lineWidth = Math.max(1, sc.width * 1.5 * k);
      g.beginPath();
      g.moveTo(sc.x * k, sc.y * k);
      g.lineTo(sc.ex * k, sc.ey * k);
      g.stroke();
    }
    // Dents.
    for (let i = 0; i < Math.round(90 * wear); i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(5, 26);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, "rgba(60,60,60,0.75)");
      grd.addColorStop(1, "rgba(60,60,60,0)");
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
  });

  // Roughness: a gentle variation, not a patchwork.
  const rough = paint(512, (g, s) => {
    g.fillStyle = "#9a9a9a";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < Math.round(500 * (0.3 + wear)); i++) {
      const slick = Math.random() > 0.55;
      g.fillStyle = slick ? "rgba(40,40,40,0.4)" : "rgba(215,215,215,0.35)";
      g.beginPath(); g.arc(rnd(0, s), rnd(0, s), rnd(4, 46), 0, 7); g.fill();
    }
  });

  return {
    albedo: texFrom(albedo, repeat),
    normal: texFrom(normalFromHeight(height, 2.6), repeat, false),
    rough: texFrom(rough, repeat, false),
  };
}

// --- metals ----------------------------------------------------------------

/** Brushed metal that has been hit a lot: streaks, rust, chips, spatter. */
function grimyMetal(repeat, tint = "#6f757e", rust = 0.3) {
  const S = 512;
  const albedo = paint(S, (g, s) => {
    g.fillStyle = tint;
    g.fillRect(0, 0, s, s);
    // brush grain
    for (let i = 0; i < 1400; i++) {
      const y = rnd(0, s);
      const a = rnd(0.02, 0.07);
      g.strokeStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      g.lineWidth = rnd(0.5, 2);
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y + rnd(-3, 3)); g.stroke();
    }
    // rust creep from the edges
    for (let i = 0; i < 40 * rust; i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(8, 46),
        `rgba(${rnd(100, 155) | 0},${rnd(52, 84) | 0},${rnd(24, 44) | 0},${rnd(0.12, 0.4)})`);
    }
    // grime in the low spots
    for (let i = 0; i < Math.round(26 * rust); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(12, 60), `rgba(18,17,18,${rnd(0.1, 0.3)})`);
    }
    // impact chips and scrapes
    for (let i = 0; i < Math.round(46 * rust); i++) gouge(g, s, rnd(8, 50), rnd(0.8, 2));
  });

  const height = paint(S, (g, s) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(6, 30);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, "rgba(55,55,55,0.8)");
      grd.addColorStop(1, "rgba(55,55,55,0)");
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    for (let i = 0; i < 1200; i++) {
      const v = rnd(105, 150) | 0;
      g.fillStyle = `rgba(${v},${v},${v},0.4)`;
      g.fillRect(rnd(0, s), rnd(0, s), rnd(1, 4), rnd(1, 3));
    }
  });

  return { albedo: texFrom(albedo, repeat), normal: texFrom(normalFromHeight(height, 1.8), repeat, false) };
}

/** Worn hazard stripes: chipped paint over rusty steel. */
function hazardStripeMaps(repeat, wear = 0.3) {
  const S = 256;
  const albedo = paint(S, (g, s) => {
    g.fillStyle = "#6a5c44";                       // rusty substrate
    g.fillRect(0, 0, s, s);
    g.save();
    g.translate(s / 2, s / 2); g.rotate(Math.PI / 4); g.translate(-s, -s);
    g.fillStyle = "#d9a316";
    g.fillRect(0, 0, s * 2, s * 2);
    g.fillStyle = "#17171b";
    for (let i = 0; i < 12; i++) g.fillRect(i * (s / 6), 0, s / 12, s * 2);
    g.restore();
    // chip the paint back to the substrate
    for (let i = 0; i < Math.round(160 * wear); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(2, 11),
        `rgba(${rnd(95, 140) | 0},${rnd(58, 86) | 0},${rnd(28, 48) | 0},${rnd(0.3, 0.85)})`);
    }
    for (let i = 0; i < Math.round(40 * wear); i++) gouge(g, s, rnd(6, 40), rnd(0.8, 2));
    for (let i = 0; i < Math.round(14 * wear); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(8, 30), `rgba(14,13,14,${rnd(0.15, 0.4)})`);
    }
  });

  const height = paint(S, (g, s) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(${rnd(55, 95) | 0},${rnd(55, 95) | 0},${rnd(55, 95) | 0},0.6)`;
      g.beginPath(); g.arc(rnd(0, s), rnd(0, s), rnd(2, 10), 0, 7); g.fill();
    }
  });

  return { albedo: texFrom(albedo, repeat), normal: texFrom(normalFromHeight(height, 1.6), repeat, false) };
}

/** Scratched, hazed polycarbonate - years of spinner hits. */
function lexanMaps(repeat, wear = 0.3) {
  const S = 512;
  const height = paint(S, (g, s) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, s, s);
    // fine scratch haze
    for (let i = 0; i < Math.round(900 * (0.3 + wear)); i++) {
      g.strokeStyle = `rgba(${rnd(100, 150) | 0},${rnd(100, 150) | 0},${rnd(100, 150) | 0},0.35)`;
      g.lineWidth = rnd(0.5, 1.8);
      const x = rnd(0, s), y = rnd(0, s), a = rnd(0, 7), l = rnd(8, 90);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    // impact stars
    for (let i = 0; i < Math.round(16 * wear); i++) {
      const x = rnd(0, s), y = rnd(0, s);
      for (let k = 0; k < 9; k++) {
        const a = rnd(0, 7), l = rnd(6, 34);
        g.strokeStyle = "rgba(60,60,60,0.7)";
        g.lineWidth = rnd(0.8, 2.2);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    }
  });
  // Grime that actually tints the glass, mostly near the bottom of the panel.
  const albedo = paint(S, (g, s) => {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      blotch(g, rnd(0, s), rnd(s * 0.45, s), rnd(10, 60), `rgba(120,112,96,${rnd(0.05, 0.22)})`);
    }
    for (let i = 0; i < 18; i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(6, 26), `rgba(60,55,50,${rnd(0.06, 0.2)})`);
    }
  });
  return { albedo: texFrom(albedo, repeat), normal: texFrom(normalFromHeight(height, 1.1), repeat, false) };
}

/** Scuffed paint, used to grime up every robot's livery colours. */
function paintWearMaps(repeat, wear = 0.3) {
  const S = 512;
  const albedo = paint(S, (g, s) => {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, s, s);
    // dirt film
    for (let i = 0; i < Math.round(70 * wear); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(14, 80), `rgba(${rnd(96, 140) | 0},${rnd(90, 128) | 0},${rnd(84, 118) | 0},${rnd(0.06, 0.26)})`);
    }
    // scrapes down to bare metal
    for (let i = 0; i < Math.round(110 * wear); i++) {
      g.strokeStyle = `rgba(${rnd(150, 210) | 0},${rnd(150, 210) | 0},${rnd(155, 215) | 0},${rnd(0.15, 0.55)})`;
      g.lineWidth = rnd(0.6, 3.4);
      g.lineCap = "round";
      const x = rnd(0, s), y = rnd(0, s), a = rnd(0, 7), l = rnd(10, 120);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    // soot
    for (let i = 0; i < Math.round(20 * wear); i++) {
      blotch(g, rnd(0, s), rnd(0, s), rnd(10, 46), `rgba(26,24,24,${rnd(0.08, 0.3)})`);
    }
  });
  const height = paint(S, (g, s) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < Math.round(70 * wear); i++) {
      const x = rnd(0, s), y = rnd(0, s), r = rnd(5, 24);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, "rgba(58,58,58,0.7)");
      grd.addColorStop(1, "rgba(58,58,58,0)");
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
  });
  return { albedo: texFrom(albedo, repeat), normal: texFrom(normalFromHeight(height, 1.5), repeat, false) };
}

/**
 * Machined steel's sheen, as a roughness map (green channel; grey 153 is the
 * material's own roughness): brushed streaks, a few polished scratches and
 * duller smudges, so a highlight breaks up as it slides along a bar instead
 * of sitting on it like a sticker.
 */
function machinedRoughness(repeat) {
  const S = 512;
  const c = paint(S, (g, s) => {
    g.fillStyle = "rgb(153,153,153)"; g.fillRect(0, 0, s, s);
    // brushing, along the part
    for (let i = 0; i < 900; i++) {
      const y = rnd(0, s), v = (153 + rnd(-26, 26)) | 0;
      g.strokeStyle = `rgba(${v},${v},${v},${rnd(0.2, 0.6)})`;
      g.lineWidth = rnd(0.5, 2.5);
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y + rnd(-2, 2)); g.stroke();
    }
    // handling smudges: duller
    for (let i = 0; i < 14; i++) blotch(g, rnd(0, s), rnd(0, s), rnd(20, 70), `rgba(205,205,205,${rnd(0.15, 0.35)})`);
    // polished scratches from hits: glossier
    g.lineCap = "round";
    for (let i = 0; i < 60; i++) {
      const x = rnd(0, s), y = rnd(0, s), a = rnd(0, 7), l = rnd(8, 60);
      g.strokeStyle = `rgba(80,80,80,${rnd(0.3, 0.7)})`;
      g.lineWidth = rnd(0.6, 1.8);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  });
  return texFrom(c, repeat, false);
}

/**
 * A photo studio, as an equirectangular map for robot reflections: a dark
 * room, a big softbox overhead, a cool strip on one side, a warm one on the
 * other, and a dim floor. What makes a bar or a disc read as polished steel.
 */
function studioEnvironment() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, "#4a5263");
  sky.addColorStop(0.48, "#2c313b");
  sky.addColorStop(0.52, "#121418");
  sky.addColorStop(1, "#08090b");
  g.fillStyle = sky;
  g.fillRect(0, 0, 512, 256);
  const box = (x, y, w, h, col, blur) => {
    g.save();
    g.shadowColor = col; g.shadowBlur = blur;
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
    g.restore();
  };
  box(0, 0, 512, 22, "#f4f6ff", 30);            // overhead softbox
  box(60, 60, 70, 46, "#ffffff", 26);           // key
  box(300, 72, 120, 26, "#b9d2ff", 24);         // cool strip
  box(190, 84, 50, 60, "#ffd9a0", 22);          // warm practical
  box(0, 150, 512, 8, "#2a2f38", 10);           // floor horizon
  return c;
}

/**
 * Build the material library. Called once, after the renderer exists.
 * `arenaRepeat` scales the floor texture to roughly one plate per 12 ft.
 */
export function makeMaterials({ arenaRepeat = 4, style = {} } = {}) {
  if (cache.has("lib")) return cache.get("lib");

  const floorWear = style.floorWear ?? 0.22;
  const metalWear = style.metalWear ?? 0.3;
  const nrm = style.normalStrength ?? 0.35;

  const floor = steelFloorMaps(arenaRepeat, floorWear);
  const steelM = grimyMetal(3, "#6f757e", metalWear);
  const darkM = grimyMetal(3, "#3d4148", metalWear * 0.7);
  // Weapons are kept clean and bright: brushed grain, hardly any rust.
  const cleanM = grimyMetal(2, "#8e959f", metalWear * 0.12);
  const stripes = hazardStripeMaps(4, metalWear);
  const lexan = lexanMaps(2, metalWear);
  const wear = paintWearMaps(1.4, metalWear);

  const lib = {
    // --- arena. Lower metalness than before: fully metallic surfaces take all
    // their colour from reflections, and with no environment map that reads as
    // muddy. Dialling it back is most of what makes this look stylised.
    steelFloor: new THREE.MeshStandardMaterial({
      map: floor.albedo,
      normalMap: floor.normal,
      normalScale: new THREE.Vector2(nrm, nrm),
      roughnessMap: floor.rough,
      color: 0xffffff,
      // Dialled down from 0.35/0.62: in the chase cam you look down the same
      // line the overhead rigs bounce off, and the deck around the bot was
      // throwing a hot sheen straight back into the lens.
      metalness: 0.18,
      roughness: 0.76,
    }),
    steel: new THREE.MeshStandardMaterial({
      map: steelM.albedo, normalMap: steelM.normal,
      normalScale: new THREE.Vector2(nrm, nrm),
      color: 0xaeb4bd, metalness: 0.45, roughness: 0.48,
    }),
    darkSteel: new THREE.MeshStandardMaterial({
      map: darkM.albedo, normalMap: darkM.normal,
      normalScale: new THREE.Vector2(nrm * 0.8, nrm * 0.8),
      color: 0x8c929b, metalness: 0.4, roughness: 0.58,
    }),
    polycarbonate: new THREE.MeshPhysicalMaterial({
      map: lexan.albedo,
      normalMap: lexan.normal,
      normalScale: new THREE.Vector2(nrm * 0.5, nrm * 0.5),
      color: 0xcfe0ee,
      metalness: 0,
      roughness: 0.14,
      transparent: true,
      opacity: 0.16,
      // FrontSide: a box's inner face already faces into the arena, and drawing
      // both sides of a transparent box made each panel sort against itself.
      side: THREE.FrontSide,
      depthWrite: false,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    }),
    hazardStripe: new THREE.MeshStandardMaterial({
      map: stripes.albedo, normalMap: stripes.normal,
      normalScale: new THREE.Vector2(nrm * 0.7, nrm * 0.7),
      metalness: 0.25, roughness: 0.66,
    }),
    // Killsaw blades: bright, hard, and deliberately a bit shiny so they catch
    // the eye the instant they come up out of the deck.
    // Auger flights: a thin ribbon, so both faces must draw.
    augerFlight: new THREE.MeshStandardMaterial({
      map: darkM.albedo, color: 0x9aa0a8, metalness: 0.45, roughness: 0.5,
      side: THREE.DoubleSide,
    }),
    sawBlade: new THREE.MeshStandardMaterial({
      color: 0xd6dbe2, metalness: 0.75, roughness: 0.22,
    }),

    // --- robot part materials, keyed by `material` in parts.json
    ar500_steel: new THREE.MeshStandardMaterial({
      map: steelM.albedo, normalMap: steelM.normal,
      normalScale: new THREE.Vector2(nrm, nrm),
      color: 0x9ea5ae, metalness: 0.4, roughness: 0.56,
    }),
    grade5_ti: new THREE.MeshStandardMaterial({
      map: steelM.albedo, normalMap: steelM.normal,
      normalScale: new THREE.Vector2(nrm * 0.8, nrm * 0.8),
      color: 0xb4bac3, metalness: 0.38, roughness: 0.5,
    }),
    hardox: new THREE.MeshStandardMaterial({
      map: steelM.albedo, normalMap: steelM.normal,
      normalScale: new THREE.Vector2(nrm, nrm),
      color: 0x7f878f, metalness: 0.45, roughness: 0.5,
    }),
    uhmw: new THREE.MeshStandardMaterial({
      map: wear.albedo, normalMap: wear.normal,
      normalScale: new THREE.Vector2(nrm * 0.6, nrm * 0.6),
      color: 0xded9cd, metalness: 0.0, roughness: 0.78,
    }),
    rubber: new THREE.MeshStandardMaterial({
      map: wear.albedo, normalMap: wear.normal,
      normalScale: new THREE.Vector2(nrm * 0.5, nrm * 0.5),
      color: 0x2a2c31, metalness: 0.0, roughness: 0.92,
    }),
    hub: new THREE.MeshStandardMaterial({
      map: steelM.albedo, normalMap: steelM.normal,
      color: 0x7e858f, metalness: 0.4, roughness: 0.56,
    }),
  };

  // --- robot-only materials. Weapons are bright tool steel, so they read
  // against any paint; `robotDark` is hardened inserts, teeth and rails.
  lib.weaponSteel = new THREE.MeshStandardMaterial({
    map: cleanM.albedo, normalMap: cleanM.normal,
    normalScale: new THREE.Vector2(nrm * 0.5, nrm * 0.5),
    color: 0xf2f4f7, metalness: 0.72, roughness: 0.36,
  });
  lib.robotDark = new THREE.MeshStandardMaterial({
    map: darkM.albedo, color: 0x9aa0a8, metalness: 0.7, roughness: 0.42,
  });
  // The same three with a machined sheen (robot_parts.js BODY_STYLE.surface).
  // The map's mid grey is 0.6, so each roughness here is its plain twin's
  // divided by 0.6.
  const machined = machinedRoughness(2);
  lib.weaponSteelFine = lib.weaponSteel.clone();
  Object.assign(lib.weaponSteelFine, { roughnessMap: machined, roughness: 0.36 / 0.6 });
  lib.robotDarkFine = lib.robotDark.clone();
  Object.assign(lib.robotDarkFine, { roughnessMap: machined, roughness: 0.42 / 0.6 });
  lib.hubFine = lib.hub.clone();
  Object.assign(lib.hubFine, { roughnessMap: machined, roughness: 0.56 / 0.6 });
  // A power light: every bot on the show has to carry one.
  lib.powerLight = new THREE.MeshStandardMaterial({
    color: 0x3dff7a, emissive: 0x2bff6a, emissiveIntensity: 2.2, roughness: 0.3,
  });

  // Robots get a studio reflection map, so steel looks like steel. Only the
  // robots: the arena's look is tuned by hand and stays as it was. It is a
  // painted equirectangular canvas rather than a PMREM render target, because
  // the menus run several renderers off this one library and a render target
  // belongs to one; Three converts a plain texture per renderer by itself.
  const env = texFrom(studioEnvironment(), 1);
  env.mapping = THREE.EquirectangularReflectionMapping;
  env.wrapS = env.wrapT = THREE.ClampToEdgeWrapping;
  env.repeat.set(1, 1);
  const robotMats = new Set();
  const reflective = (m, intensity) => { m.envMap = env; m.envMapIntensity = intensity; robotMats.add(m); return m; };
  reflective(lib.weaponSteel, 1.0);
  reflective(lib.robotDark, 0.8);
  reflective(lib.ar500_steel, 0.7);
  reflective(lib.grade5_ti, 0.7);
  reflective(lib.hardox, 0.7);
  reflective(lib.hub, 0.7);
  reflective(lib.weaponSteelFine, 1.0);
  reflective(lib.robotDarkFine, 0.8);
  reflective(lib.hubFine, 0.7);
  reflective(lib.uhmw, 0.35);
  reflective(lib.rubber, 0.25);

  // Livery materials are made on demand and memoised by colour. The wear map
  // multiplies the livery colour, so every bot's paint is scraped and sooty.
  const liveryCache = new Map();
  lib.livery = (hex) => {
    if (!liveryCache.has(hex)) {
      // Painted panels: low metalness and a flat-ish roughness, so livery
      // colours stay the colour they were picked as instead of going grey.
      liveryCache.set(hex, reflective(new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex),
        map: wear.albedo,
        normalMap: wear.normal,
        normalScale: new THREE.Vector2(nrm * 0.6, nrm * 0.6),
        metalness: 0.12,
        roughness: 0.6,
      }), 0.45));
    }
    return liveryCache.get(hex);
  };

  /**
   * A robot's own paint job (js/render/livery.js paints the canvas). One per
   * robot view; the caller disposes it and its textures with the view.
   * `relief` ({ height, finish } canvases, painted by the same call) adds
   * the surface detail: a bump map, and roughness and metalness from the
   * finish map's green and blue, which then carries the whole value.
   */
  lib.robotPaint = (canvas, relief = null) => {
    const atlasTex = (c, srgb) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.flipY = false;
      t.anisotropy = 8;
      return t;
    };
    const m = new THREE.MeshStandardMaterial({ map: atlasTex(canvas, true), metalness: 0.1, roughness: 0.55 });
    if (relief?.height) {
      m.bumpMap = atlasTex(relief.height, false);
      m.bumpScale = style.bumpScale ?? 1.2;
    }
    if (relief?.finish) {
      m.roughnessMap = m.metalnessMap = atlasTex(relief.finish, false);
      m.roughness = 1;
      m.metalness = 1;
    }
    return reflective(m, 0.3);
  };

  /** Scale every robot reflection, e.g. down in the lit arena. */
  lib.setRobotReflections = (k) => {
    for (const m of robotMats) {
      m.userData.baseEnv ??= m.envMapIntensity;
      m.envMapIntensity = m.userData.baseEnv * k;
    }
  };

  /** Look up a material by the string a data file used; falls back to steel. */
  lib.byName = (name) => lib[name] || lib.darkSteel;

  cache.set("lib", lib);
  return lib;
}
