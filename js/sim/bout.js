// bout.js - a complete fight with no graphics: arena, hazards, two bots, their
// weapons, their AI drivers, combat and the match clock.
//
// This is what the Stage 3 tests and tools/aimatch.js fight with, and what
// Stage 5 will run a few hundred times to simulate a season. main.js does the
// same wiring by hand because it also has to feed the renderer; keep the two
// in step.

import { assembleRobot, assemblePartner } from "../logic/build.js";
import { makeWeapon } from "../logic/weapon.js";
import { makeAI } from "../logic/ai.js";
import { makeMatch } from "../logic/match.js";
import { makeRng, hashSeed } from "../core/rng.js";
import { makeBus, EV } from "../core/bus.js";
import { ftToM, degToRad } from "../core/units.js";
import { buildArena } from "./world.js";
import { buildHazards } from "./hazards.js";
import { createRobotSim } from "./robot_sim.js";
import { makeCombat } from "./combat.js";
import { perceive } from "./ai_bridge.js";
import { makeReferee } from "./referee.js";

/**
 * @param opts.reg        registry
 * @param opts.a, opts.b  robot DEFS (plain objects - override personality or
 *                        rating on a copy to experiment)
 * @param opts.seed       drives damage rolls, both AIs and the killsaw draw
 * @param opts.aiA/aiB    false = that bot gets `inputA`/`inputB` from the
 *                        caller each step instead of an AI
 * @param opts.spawnA/B   { pos:{x,z[,y]} metres, yaw radians } overrides (y lifts the
 *                        bot off the deck - a drop test)
 * @param opts.remainingS fixed match clock reading (default: a live clock)
 * @param opts.refereed   true (default) runs the real match: KO count, pins,
 *                        tap-outs, judges. The bout stops when it ends.
 * @param opts.arena     a composed arena (js/logic/arenas.js); default the classic box
 * @param opts.multibots  true (default): a multibot brings its partner, AI
 *                        driven, spawned beside it. false fights the main unit
 *                        alone.
 */
export function makeBout({ reg, a, b, seed = 1, aiA = true, aiB = true, spawnA, spawnB, remainingS, refereed = true, multibots = true, arena: arenaIn = null } = {}) {
  const rules = reg.rules;
  // A layout from data/arenas.json (js/logic/arenas.js composeArena), or the box.
  const arena = arenaIn || reg.arena;
  const fixed = arena.physics.fixedStepS;
  const bus = makeBus();
  const sim = buildArena(arena);
  const hazards = buildHazards(sim.world, arena, bus, { seed });
  const rng = makeRng(seed);

  const sideDef = (def, spawnId, override, aiOn, tag) => {
    const sp = reg.spawn(spawnId);
    const spawn = override ?? { pos: { x: ftToM(sp.pos[0]), z: ftToM(sp.pos[2]) }, yaw: degToRad(sp.yaw) };
    const unit = (assembled, id, pos, ai) => {
      const robotSim = createRobotSim(sim, assembled, { pos, yaw: spawn.yaw }, rules, { seed: hashSeed(`${seed}:${id}`) });
      return { id, assembled, robotSim, weapon: makeWeapon(assembled, rules), ai };
    };
    // Each AI gets its own stream so one bot's decisions cannot shift the
    // other's dice.
    const main = unit(assembleRobot(reg, def), tag, { x: spawn.pos.x, y: spawn.pos.y ?? 0, z: spawn.pos.z },
      aiOn ? makeAI({ robot: def, rng: makeRng(hashSeed(`${seed}:${tag}`)) }) : null);
    const units = [main];
    if (multibots && def.partner) {
      // The partner starts beside the main unit, square to its heading.
      const off = 1.1;
      const pos = { x: spawn.pos.x + Math.sin(spawn.yaw) * off, y: spawn.pos.y ?? 0, z: spawn.pos.z + Math.cos(spawn.yaw) * off };
      units.push(unit(assemblePartner(reg, def), `${tag}2`, pos, makeAI({ robot: def, rng: makeRng(hashSeed(`${seed}:${tag}2`)) })));
    }
    return { tag, def, units, assembled: main.assembled, robotSim: main.robotSim, weapon: main.weapon, ai: main.ai, stats: blankStats() };
  };
  const A = sideDef(a, "red", spawnA, aiA, "A");
  const B = sideDef(b, "blue", spawnB, aiB, "B");
  const byTag = { A, B };
  const sideOfUnit = new Map([...A.units.map((u) => [u.id, A]), ...B.units.map((u) => [u.id, B])]);
  const allUnits = [...A.units, ...B.units];

  const combat = makeCombat({ sim, rules, rng, bus });
  for (const s of [A, B]) for (const u of s.units) combat.registerBot(u.id, u.robotSim, u.weapon, s.tag);
  combat.registerHazards(hazards);

  const match = makeMatch(rules, bus, { botIds: ["A", "B"], seed });
  match.start({ countdown: false });
  const referee = makeReferee({
    match, bus, world: sim.world, arena: { halfX: sim.dims.halfX, halfZ: sim.dims.halfZ },
    sides: [A, B].map((s) => ({ id: s.tag, units: s.units.map((u) => ({ id: u.id, robotSim: u.robotSim, weapon: u.weapon })) })),
  });
  bus.on(EV.PIN_WARNING, (e) => { for (const u of byTag[e.botId]?.units || []) u.ai?.notify({ type: "pinWarning" }); });
  let clockS = remainingS ?? rules.match.durationS;
  let t = 0;

  bus.on(EV.HIT, (e) => {
    const hp = (e.hits || []).reduce((s, h) => s + (h.hpLost || 0), 0);
    const def = sideOfUnit.get(e.defenderId);
    if (def) { def.stats.hpTaken += hp; if (e.kind === "hazard") def.stats.hazardHits++; }
    const atk = sideOfUnit.get(e.attackerId);
    if (atk) {
      atk.stats.hpDealt += hp;
      if (e.kind === "weapon") atk.stats.weaponHits++;
      else if (e.kind === "ram") atk.stats.rams++;
    }
    // Tell both drivers - a hit is the cue to back off and reset.
    allUnits.find((u) => u.id === e.attackerId)?.ai?.notify({ type: "hit", landed: true, kind: e.kind });
    allUnits.find((u) => u.id === e.defenderId)?.ai?.notify({ type: "hit", took: true, kind: e.kind });
  });

  const dims = { halfX: sim.dims.halfX, halfZ: sim.dims.halfZ };

  /** The opposing unit a unit should go after: the nearest one still driving. */
  function targetFor(u, opp) {
    const p = u.robotSim.body.translation();
    const working = opp.units.filter((o) => !o.robotSim.effective().immobile);
    let best = null, bd = Infinity;
    for (const o of working.length ? working : opp.units) {
      const q = o.robotSim.body.translation();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function stepSide(me, opp, manual) {
    for (const u of me.units) {
      const target = targetFor(u, opp);
      const drive = u.ai
        ? u.ai.drive(perceive({
            selfSim: u.robotSim, selfWeapon: u.weapon,
            oppSim: target.robotSim, oppWeapon: target.weapon,
            hazards, arenaDims: dims, remainingS: clockS, lead: match.scorebook.lead(me.tag),
          }), fixed)
        : (manual || { throttle: 0, steer: 0, brake: false, weapon: 0 });
      u.lastDrive = drive;
      if (u === me.units[0]) me.lastDrive = drive;
      if (drive.tapOut && refereed && u === me.units[0]) match.tapOut(me.tag);
      u.weapon.update(fixed, { demand: drive.weapon || 0, effective: u.robotSim.effective() });
      u.robotSim.step(drive, fixed);
    }
  }

  function step({ inputA, inputB } = {}) {
    stepSide(A, B, inputA);
    stepSide(B, A, inputB);
    hazards.update(fixed, allUnits.map((u) => u.robotSim.pose().pos), { remainingS: clockS });
    sim.world.step(combat.eventQueue);
    combat.resolve(fixed);
    for (const u of allUnits) u.robotSim.clampMotion();
    t += fixed;
    if (refereed) {
      referee.step(fixed, Object.fromEntries(allUnits.map((u) => [u.id, u.lastDrive])));
      match.update(fixed);
      if (remainingS === undefined) clockS = match.clockS;
    } else if (remainingS === undefined) {
      clockS = Math.max(0, clockS - fixed);
    }

    // Behaviour stats, for tests and tuning.
    const pa = A.robotSim.body.translation(), pb = B.robotSim.body.translation();
    const gap = Math.hypot(pa.x - pb.x, pa.z - pb.z) - (A.assembled.dims.lengthM + B.assembled.dims.lengthM) / 2;
    for (const s of [A, B]) {
      if (gap < 0.6) s.stats.closeS += fixed;
      if (s.robotSim.groundSpeedMps() < 0.1) s.stats.stillS += fixed;
      const st = s.ai?.state;
      if (st) s.stats.stateS[st] = (s.stats.stateS[st] || 0) + fixed;
    }
  }

  return {
    A, B, sim, hazards, combat, bus, match, referee, fixed,
    get t() { return t; },
    get clockS() { return clockS; },
    get over() { return refereed && match.phase === "ended"; },
    get result() { return match.result; },
    step,
    /** Run for `seconds`; `onStep(bout)` may return true to stop early. */
    run(seconds, opts = {}, onStep) {
      const n = Math.round(seconds / fixed);
      for (let i = 0; i < n; i++) {
        if (this.over) break;
        step(opts);
        if (onStep && onStep(this)) break;
      }
      return this;
    },
    /** Fight to the finish: KO, tap-out or the judges. */
    runToEnd(maxS = rules.match.durationS + 1) { return this.run(maxS); },
    gap() {
      const pa = A.robotSim.body.translation(), pb = B.robotSim.body.translation();
      return Math.hypot(pa.x - pb.x, pa.z - pb.z) - (A.assembled.dims.lengthM + B.assembled.dims.lengthM) / 2;
    },
  };
}

function blankStats() {
  return { hpDealt: 0, hpTaken: 0, weaponHits: 0, rams: 0, hazardHits: 0, closeS: 0, stillS: 0, stateS: {} };
}
