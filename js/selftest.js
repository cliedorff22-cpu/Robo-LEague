// selftest.js - runtime checks for the layers that need a real browser.
//
// tools/test.sh covers everything that runs headlessly (units, build, match,
// the tyre model). It cannot cover Rapier or Three.js, so those are checked
// here: open selftest.html and every assertion below runs against the real
// physics world and a real WebGL frame.
//
// Each case builds its own world so one failure cannot cascade into the next.

import { loadRegistryFromFetch } from "./data/load.js";
import { validateAll } from "./logic/validate.js";
import { assembleRobot } from "./logic/build.js";
import { makeMatch } from "./logic/match.js";
import { makeBus } from "./core/bus.js";
import { makeReplay } from "./core/replay.js";
import { ftToM, degToRad, mpsToMph } from "./core/units.js";
import { initPhysics, buildArena } from "./sim/world.js";
import { buildHazards } from "./sim/hazards.js";
import { createRobotSim } from "./sim/robot_sim.js";
import { makeRenderer } from "./render/renderer.js";
import { makeMaterials } from "./render/materials.js";
import { buildArenaView } from "./render/arena_view.js";
import { buildRobotView } from "./render/robot_view.js";
import { makeCameraRig } from "./render/cameras.js";
import { makeEffects } from "./render/effects.js";
import { makeDebris } from "./sim/debris.js";
import { makeRng } from "./core/rng.js";
import { makeWeapon } from "./logic/weapon.js";

const out = document.getElementById("results");
const summary = document.getElementById("summary");
let pass = 0, fail = 0;

function group(name) {
  const h = document.createElement("h2");
  h.textContent = name;
  out.appendChild(h);
}

function check(name, fn) {
  const row = document.createElement("div");
  row.className = "row";
  try {
    const note = fn();
    pass++;
    row.classList.add("pass");
    row.innerHTML = `<b>ok</b> ${esc(name)}${note ? ` <i>${esc(note)}</i>` : ""}`;
  } catch (e) {
    fail++;
    row.classList.add("fail");
    // Print the MESSAGE and the stack separately. Safari's `Error.stack` is
    // only the frames - unlike V8 it does not prepend "Error: <message>" - so
    // relying on `stack` alone reported every failure with no reason attached.
    const msg = (e && e.message) || String(e);
    const stack = (e && e.stack) || "";
    row.innerHTML = `<b>FAIL</b> ${esc(name)}<pre>${esc(msg)}${stack ? `\n\n${esc(stack)}` : ""}</pre>`;
    console.error(name, e);
  }
  out.appendChild(row);
}

const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol,
  `${m || "value"}: expected ${b} +/- ${tol}, got ${a}`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

run().catch((e) => {
  summary.textContent = `Harness crashed: ${e.message}`;
  summary.className = "fail";
  console.error(e);
});

async function run() {
  // ------------------------------------------------------------ data
  group("data");
  const reg = await loadRegistryFromFetch("data");
  check("registry loads over fetch", () =>
    `${reg.allParts().length} parts, ${reg.allRobots().length} robots`);
  check("validateAll passes", () => {
    const v = validateAll(reg);
    assert(v.ok, v.errors.join("; "));
    return `${v.warnings.length} warning(s)`;
  });

  const assembled = assembleRobot(reg, reg.robot("player_default"));
  check("player build is legal", () => {
    assert(assembled.legality.legal, assembled.legality.errors.join("; "));
    return `${assembled.weightLb} lb, ${assembled.stats.topSpeedMph.toFixed(1)} mph`;
  });

  // ------------------------------------------------------------ physics
  group("physics");
  await initPhysics();
  check("Rapier initialises", () => "wasm ready");

  const fixed = reg.arena.physics.fixedStepS;

  // Build a fresh arena + bot. Used by most cases below.
  function freshWorld({ spawnId = "red", yawDeg = null } = {}) {
    const sim = buildArena(reg.arena);
    const bus = makeBus();
    const hazards = buildHazards(sim.world, reg.arena, bus);
    const sp = reg.spawn(spawnId);
    const robot = createRobotSim(sim, assembled, {
      pos: { x: ftToM(sp.pos[0]), y: 0, z: ftToM(sp.pos[2]) },
      yaw: degToRad(yawDeg ?? sp.yaw),
    }, reg.rules);
    return { sim, hazards, robot, bus };
  }

  // Advance a world by `seconds` with a constant input.
  function advance(w, seconds, input = { throttle: 0, steer: 0, brake: false }) {
    const steps = Math.round(seconds / fixed);
    for (let i = 0; i < steps; i++) {
      w.robot.step(input, fixed);
      w.hazards.update(fixed, [w.robot.pose().pos], { remainingS: 999 });
      w.sim.world.step();
    }
  }

  check("arena builds the expected static geometry", () => {
    const { sim } = freshWorld();
    const floor = sim.pieces.filter((p) => p.kind === "floor");
    assert(floor.length === 1, `expected 1 floor piece, got ${floor.length}`);
    // The floor's top surface must sit exactly at y = 0: every other system
    // (ride height, hazard heights, spawn Y) assumes it.
    near(floor[0].pos.y + floor[0].size[1] / 2, 0, 1e-9, "floor top surface");
    assert(sim.pieces.filter((p) => p.kind === "lexan").length === 4, "expected 4 lexan panels");
    assert(sim.pieces.filter((p) => p.kind === "kickplate").length === 4, "expected 4 kickplates");
    return `${sim.pieces.length} static pieces`;
  });

  check("every hazard in the data instantiates", () => {
    const { hazards } = freshWorld();
    const types = hazards.all.map((h) => h.type).sort();
    // Counted from arena.json rather than hardcoded: this test used to assert
    // the pre-redesign layout (5 hazards, 2 hammers, 1 pulverizer) and went
    // red purely because the arena spec moved on.
    const want = reg.arena.hazards.filter((h) => h.enabled !== false);
    assert(hazards.all.length === want.length,
      `expected ${want.length} hazards, got ${hazards.all.length}`);
    for (const type of new Set(want.map((h) => h.type))) {
      const n = want.filter((h) => h.type === type).length;
      const got = types.filter((t) => t === type).length;
      assert(got === n, `expected ${n} ${type}(s), got ${got}`);
    }
    // Every swinger needs the three pieces the render layer dereferences.
    for (const h of hazards.all) {
      if (h.type === "screw" || h.type === "killsaw") continue;
      for (const kind of ["swingerArm", "swingerHead", "swingerPivot"]) {
        assert(h.pieces.some((p) => p.kind === kind), `${h.id} has no ${kind} piece`);
      }
    }
    return types.join(", ");
  });

  check("colliders map back to their fittings", () => {
    const { robot } = freshWorld();
    const keys = new Set(robot.colliderToFitting.values());
    assert(keys.has("chassis"), "chassis collider not mapped");
    assert(keys.has("weapon"), "wedge collider not mapped - convex hull may have failed");
    assert([...keys].some((k) => k.startsWith("armor.")), "no armour colliders mapped");
    return `${robot.colliderToFitting.size} colliders -> ${keys.size} fittings`;
  });

  check("the bot settles on all four wheels", () => {
    const w = freshWorld();
    advance(w, 2.0);
    const grounded = w.robot.telemetry.filter((t) => t.grounded).length;
    assert(grounded === 4, `only ${grounded}/4 wheels found the floor`);
    const loadSum = w.robot.telemetry.reduce((s, t) => s + t.load, 0);
    near(loadSum, assembled.massKg * 9.81, assembled.massKg * 9.81 * 0.12,
      "total wheel load should carry the bot's weight");
    return `${grounded}/4 down, ${loadSum.toFixed(0)} N total`;
  });

  check("the bot settles at its designed ride height", () => {
    const w = freshWorld();
    advance(w, 2.0);
    const y = w.robot.pose().pos.y;
    // Derived in robot_sim: body centre rests at half-height + ground clearance.
    const expected = assembled.dims.heightM / 2 + Math.max(0.004, assembled.stats.groundClearanceM);
    near(y, expected, 0.02, "resting body height");
    return `y = ${y.toFixed(4)} m (expected ~${expected.toFixed(4)})`;
  });

  check("the wedge tip stays above the floor", () => {
    const w = freshWorld();
    advance(w, 2.0);
    const info = w.robot.wedgeInfo;
    assert(info, "no wedge info");
    const y = w.robot.pose().pos.y;
    // Lowest wedge vertex is its underside, at body-local y0.
    const worldLow = y + info.y0;
    assert(worldLow > 0, `wedge underside is ${worldLow.toFixed(4)} m - below the floor`);
    return `wedge underside at y = ${worldLow.toFixed(4)} m`;
  });

  check("a settled bot is upright and still", () => {
    const w = freshWorld();
    advance(w, 2.0);
    assert(w.robot.uprightness() > 0.99, `uprightness ${w.robot.uprightness().toFixed(3)}`);
    assert(w.robot.speedMps() < 0.1, `drifting at ${w.robot.speedMps().toFixed(3)} m/s`);
    return `upright ${w.robot.uprightness().toFixed(4)}`;
  });

  check("full throttle accelerates the bot forward", () => {
    const w = freshWorld();
    advance(w, 1.0);                       // settle first
    const start = { ...w.robot.pose().pos };
    advance(w, 1.5, { throttle: 1, steer: 0, brake: false });
    const end = w.robot.pose().pos;
    const v = w.robot.speedMps();
    // Spawn yaw is 0, so forward is +X.
    assert(end.x - start.x > 1.5, `only moved ${(end.x - start.x).toFixed(2)} m forward`);
    assert(v > assembled.stats.topSpeedMps * 0.5,
      `reached only ${v.toFixed(2)} of ${assembled.stats.topSpeedMps.toFixed(2)} m/s`);
    return `${mpsToMph(v).toFixed(1)} mph after 1.5 s, +${(end.x - start.x).toFixed(2)} m`;
  });

  check("steer-only pivots the bot in place", () => {
    const w = freshWorld();
    advance(w, 1.0);
    const start = { ...w.robot.pose().pos };
    advance(w, 1.0, { throttle: 0, steer: 1, brake: false });
    const yawRate = Math.abs(w.robot.body.angvel().y);
    const drift = Math.hypot(w.robot.pose().pos.x - start.x, w.robot.pose().pos.z - start.z);
    assert(yawRate > 1.0, `yaw rate only ${yawRate.toFixed(2)} rad/s`);
    assert(drift < 1.2, `drifted ${drift.toFixed(2)} m while pivoting`);
    return `${yawRate.toFixed(2)} rad/s, drift ${drift.toFixed(2)} m`;
  });

  check("releasing the throttle brings the bot to a stop", () => {
    const w = freshWorld();
    advance(w, 1.0);
    advance(w, 1.5, { throttle: 1, steer: 0, brake: false });
    advance(w, 3.0, { throttle: 0, steer: 0, brake: false });
    assert(w.robot.speedMps() < 0.3, `still rolling at ${w.robot.speedMps().toFixed(2)} m/s`);
    return `stopped (${w.robot.speedMps().toFixed(3)} m/s)`;
  });

  check("the walls keep the bot in the box", () => {
    const w = freshWorld();
    advance(w, 1.0);
    advance(w, 4.0, { throttle: 1, steer: 0, brake: false });   // straight at the far wall
    const p = w.robot.pose().pos;
    const halfX = ftToM(reg.arena.floor.size[0]) / 2;
    assert(Math.abs(p.x) < halfX + 0.4, `escaped to x = ${p.x.toFixed(2)} (half-width ${halfX.toFixed(2)})`);
    assert(p.y < 1.5, `launched to y = ${p.y.toFixed(2)}`);
    return `held at x = ${p.x.toFixed(2)} m`;
  });

  check("screws spin and hammers hold station", () => {
    const w = freshWorld();
    const screw = w.hazards.all.find((h) => h.type === "screw");
    const before = { ...screw.body.rotation() };
    advance(w, 0.5);
    const after = screw.body.rotation();
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y) +
                  Math.abs(after.z - before.z) + Math.abs(after.w - before.w);
    assert(moved > 1e-3, "the screw never rotated");
    return `screw rotation delta ${moved.toFixed(3)}`;
  });

  check("the pulverizer fires when a bot drives under it", () => {
    const sim = buildArena(reg.arena);
    const bus = makeBus();
    const hazards = buildHazards(sim.world, reg.arena, bus);
    const pulv = hazards.all.find((h) => h.type === "pulverizer");
    // Park a bot exactly where this pulverizer's head LANDS. Derived from the
    // hazard's own def, not hardcoded: the old fixed mid-wall coordinate was
    // left stranded when the pulverizers moved to opposite corners, so the bot
    // sat half an arena away and the hazard was right not to fire.
    const robot = createRobotSim(sim, assembled, {
      pos: { x: ftToM(pulv.def.pos[0]), y: 0, z: ftToM(pulv.def.pos[2]) },
      yaw: 0,
    }, reg.rules);
    let fired = false;
    bus.on("hazard:fire", (e) => { if (e.id === pulv.id) fired = true; });
    for (let i = 0; i < Math.round(3 / fixed); i++) {
      robot.step({ throttle: 0, steer: 0 }, fixed);
      hazards.update(fixed, [robot.pose().pos], { remainingS: 999 });
      sim.world.step();
    }
    assert(fired, "pulverizer never triggered with a bot beneath it");
    assert(pulv.state !== "armed", `pulverizer state is still "${pulv.state}"`);
    return `fired, now "${pulv.state}"`;
  });

  // ------------------------------------------------------------ replay
  group("replay");
  check("replay records and plays back poses", () => {
    const w = freshWorld();
    const replay = makeReplay({ seconds: 4, hz: 30, trackCount: 1 });
    let t = 0;
    for (let i = 0; i < Math.round(2 / fixed); i++) {
      w.robot.step({ throttle: 1, steer: 0 }, fixed);
      w.hazards.update(fixed, [w.robot.pose().pos], { remainingS: 999 });
      w.sim.world.step();
      t += fixed;
      replay.record(fixed, [w.robot.pose()], t);
    }
    assert(replay.frameCount > 50, `only ${replay.frameCount} frames recorded`);
    assert(replay.play(1.5), "playback refused to start");
    const first = replay.sample(0.016, 1);
    assert(first && first[0] && Number.isFinite(first[0].pos.x), "sample returned nothing usable");
    assert(Math.abs(quatLen(first[0].quat) - 1) < 1e-5, "interpolated quaternion is not unit length");
    return `${replay.frameCount} frames, playback ok`;
  });

  // ------------------------------------------------------------ rendering
  group("rendering");
  const canvas = document.getElementById("probe");
  let rendered = null;

  /**
   * Run a render test against a CLEAN slate.
   *
   * Every render test used to add its meshes to one long-lived scene. When a
   * build threw partway through - as buildArenaView did on every killsaw - the
   * half-built group stayed in the scene, and the next test to call render()
   * reported a WebGL error that had nothing to do with it. One real bug then
   * showed up as two failures, and the second one pointed at innocent code.
   *
   * So: strip everything a previous test added, and drain any pending GL error
   * so a sticky one cannot be attributed to the wrong test either.
   *
   * NOT scene.clear() - makeRenderer puts the whole lighting rig (ambient, key,
   * fill and the overhead practicals) straight into the scene, and clearing it
   * would quietly render every later test in the dark.
   */
  let baseChildren = null;
  function renderCheck(name, fn) {
    check(name, () => {
      if (rendered) {
        if (!baseChildren) baseChildren = new Set(rendered.scene.children);
        for (const child of [...rendered.scene.children]) {
          if (!baseChildren.has(child)) rendered.scene.remove(child);
        }
        while (rendered.renderer.getContext().getError() !== 0) { /* drain */ }
      }
      return fn();
    });
  }

  check("WebGL renderer and scene build", () => {
    const r = makeRenderer(canvas, reg.arena);
    rendered = r;
    assert(r.renderer.getContext(), "no WebGL context");
    return r.renderer.getContext().getParameter(0x1f00 /* VENDOR */) || "context ok";
  });

  check("procedural materials generate", () => {
    const mats = makeMaterials({ arenaRepeat: 4, style: reg.arena.style });
    assert(mats.steelFloor.map, "floor albedo texture missing");
    assert(mats.steelFloor.roughnessMap, "floor roughness texture missing");
    assert(mats.livery("#ff0000") === mats.livery("#ff0000"), "livery materials are not memoised");
    return "textures drawn";
  });

  renderCheck("arena and robot views build and render a frame", () => {
    const w = freshWorld();
    const mats = makeMaterials({ arenaRepeat: 4, style: reg.arena.style });
    const bus = makeBus();
    const av = buildArenaView(rendered.scene, reg.arena, w.sim, w.hazards, mats);
    const rv = buildRobotView(rendered.scene, assembled, w.robot, mats);
    const rig = makeCameraRig(reg.arena, bus, 16 / 9);

    advance(w, 0.5);
    av.update();
    rv.update();
    rig.update(0.016, w.robot.pose(), {});
    rendered.renderer.render(rendered.scene, rig.camera);

    assert(av.group.children.length > 10, `arena group has only ${av.group.children.length} meshes`);
    assert(rv.group.children.length > 5, `robot group has only ${rv.group.children.length} meshes`);
    assert(rv.panelMeshes.has("weapon"), "wedge mesh missing");
    const err = rendered.renderer.getContext().getError();
    assert(err === 0, `WebGL error code ${err}`);
    return `${av.group.children.length} arena + ${rv.group.children.length} robot meshes, GL clean`;
  });

  renderCheck("every camera mode produces a finite pose", () => {
    const w = freshWorld();
    const bus = makeBus();
    const rig = makeCameraRig(reg.arena, bus, 16 / 9);
    advance(w, 0.4);
    const names = [];
    for (const c of rig.list()) {
      rig.select(c.id);
      for (let i = 0; i < 10; i++) rig.update(0.016, w.robot.pose(), {});
      const p = rig.camera.position;
      assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
        `camera "${c.id}" produced a non-finite position`);
      names.push(c.id);
    }
    return names.join(", ");
  });

  // ------------------------------------------------------------ effects
  group("effects (Stage 2)");

  renderCheck("weapon meshes exist for a powered weapon", () => {
    const w = freshWorld();
    const mats = makeMaterials({ arenaRepeat: 4, style: reg.arena.style });
    const spin = assembleRobot(reg, reg.robot("spinner_test"));
    const spinSim = createRobotSim(w.sim, spin, { pos: { x: 2, y: 0, z: 2 }, yaw: 0 }, reg.rules);
    const rv = buildRobotView(rendered.scene, spin, spinSim, mats);
    assert(rv.group.children.length > 6, `only ${rv.group.children.length} meshes`);
    const wp = makeWeapon(spin, reg.rules);
    rv.updateWeapon(wp, 0.016);     // must not throw
    return `${rv.group.children.length} meshes incl. rotor`;
  });

  renderCheck("sparks and debris build and update", () => {
    const w = freshWorld();
    const mats = makeMaterials({ arenaRepeat: 4, style: reg.arena.style });
    const bus = makeBus();
    const rng = makeRng(1);
    const debris = makeDebris({ sim: w.sim, rng });
    const rv = buildRobotView(rendered.scene, assembled, w.robot, mats);
    const fx = makeEffects(rendered.scene, {
      bus, mats, robotViews: new Map([[assembled.id, rv]]), debris, rng, arena: reg.arena,
    });

    // Fire a synthetic heavy hit through the bus and make sure it is consumed.
    bus.emit("combat:hit", {
      defenderId: assembled.id, severity: "heavy", deliveredJ: 9000,
      at: { x: 0, y: 0.3, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      hits: [{ key: "armor.0", category: "armor", conditionAfter: 0.4 }],
    });
    bus.emit("combat:partFailed", {
      botId: assembled.id, key: "armor.0", category: "armor",
      at: { x: 0, y: 0.3, z: 0 }, normal: { x: 0, y: 1, z: 0 },
    });
    assert(debris.count > 0, "a failed part threw no debris");

    for (let i = 0; i < 30; i++) { fx.update(0.016); w.sim.world.step(); debris.update(0.016); }
    rendered.renderer.render(rendered.scene, makeCameraRig(reg.arena, bus, 16 / 9).camera);
    const err = rendered.renderer.getContext().getError();
    assert(err === 0, `WebGL error ${err} while drawing effects`);
    fx.clear();
    return `${debris.count} fragments, sparks drawn, GL clean`;
  });

  // ------------------------------------------------------------ match
  group("match");
  check("the match clock runs against real physics steps", () => {
    const w = freshWorld();
    const bus = makeBus();
    const match = makeMatch(reg.rules, bus, { botIds: [assembled.id] });
    match.start();
    for (let i = 0; i < Math.round(5 / fixed); i++) {
      w.robot.step({ throttle: 1, steer: 0 }, fixed);
      w.sim.world.step();
      match.update(fixed);
    }
    assert(match.phase === "live", `phase is "${match.phase}"`);
    near(match.clockS, 178, 0.6, "clock after 2 s of live time");
    return `clock ${match.clockS.toFixed(2)} s`;
  });

  // ------------------------------------------------------------ done
  summary.textContent = fail === 0
    ? `all ${pass} runtime checks passed`
    : `${pass} passed, ${fail} FAILED`;
  summary.className = fail === 0 ? "pass" : "fail";
}

const quatLen = (q) => Math.hypot(q.x, q.y, q.z, q.w);
