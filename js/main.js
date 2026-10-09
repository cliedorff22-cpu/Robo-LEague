// main.js - boot and the frame loop.
//
// The only file that knows about all four layers at once. Its job is wiring:
//
//   data   -> js/data      JSON in, indexed registry out
//   logic  -> js/logic     build stats, rule checks, match clock  (no gfx, no physics)
//   sim    -> js/sim       Rapier bodies, the wheel model, hazards
//   render -> js/render    Three.js scene, cameras, HUD
//
// Physics runs on a FIXED timestep with an accumulator; rendering runs as fast
// as the display allows. That separation is what keeps the handling identical
// on a 60 Hz and a 144 Hz monitor, and it is also what lets Stage 5 run a whole
// season headlessly at maximum speed.

import { loadRegistryFromFetch } from "./data/load.js";
import { dataDir } from "./core/platform.js";
import { validateAll } from "./logic/validate.js";
import { assembleRobot, assemblePartner } from "./logic/build.js";
import { makeMatch, PHASE } from "./logic/match.js";
import { makeReferee } from "./sim/referee.js";
import { makeWeapon } from "./logic/weapon.js";
import { effectiveStats, conditionReport, worstFirst, repairBill } from "./logic/condition.js";
import { makeRng } from "./core/rng.js";
import { makeBus, EV } from "./core/bus.js";
import { makeReplay } from "./core/replay.js";
import { ftToM, degToRad } from "./core/units.js";
import { initPhysics, buildArena } from "./sim/world.js";
import { buildHazards } from "./sim/hazards.js";
import { createRobotSim } from "./sim/robot_sim.js";
import { makeCombat } from "./sim/combat.js";
import { makeDebris } from "./sim/debris.js";
import { makeRenderer } from "./render/renderer.js";
import { makeMaterials } from "./render/materials.js";
import { buildArenaView } from "./render/arena_view.js";
import { buildVenueView } from "./render/venue_view.js";
import { composeArena, venueOf, layoutOf, layoutForFight, venueForLeague, DEFAULT_VENUE, DEFAULT_LAYOUT } from "./logic/arenas.js";
import { buildRobotView } from "./render/robot_view.js";
import { makeCameraRig } from "./render/cameras.js";
import { registerCareerRobots } from "./logic/field.js";
import { difficultyOf } from "./logic/settings.js";
import { loadSettings, saveSettings, renderSettings } from "./menu/settings_ui.js";
import { makePost } from "./render/post.js";
import { makeEffects } from "./render/effects.js";
import { makeHud, controlsHtml } from "./render/hud.js";
import { makeInput } from "./input/input.js";
import { makePilot, PILOT } from "./input/pilot.js";
import { makeAI } from "./logic/ai.js";
import { perceive } from "./sim/ai_bridge.js";
import { hashSeed } from "./core/rng.js";
import { makeAudio } from "./audio/audio.js";
import { makeSpeech } from "./audio/speech.js";
import { makeCommentary } from "./logic/commentary.js";
import { makeCommentaryView } from "./render/commentary_view.js";
import { familyOf } from "./logic/weapon.js";

const DEFAULT_RED = "player_default";
const DEFAULT_OPPONENT = "spinner_test";

// URL switches. The menu's Quick Fight sends the first three:
//   ?red=<robot id>     the red corner - the robot you drive (default: yours)
//   ?blue=<robot id>    the blue corner, always AI (?opp= still works)
//   ?driver=ai          the AI drives red too - AI vs AI (same as ?ai=1)
//   ?seed=N             fix the session seed, to reproduce a match exactly
//   ?rating=&league=&personality=   override the blue corner's driver
const params = new URLSearchParams(location.search);
// ?career=1: a career fight, handed over by the career screen (js/menu/career_ui.js).
// The result goes back through localStorage; M returns to the career.
const CAREER = params.get("career") === "1";
// ?tourney=1: a tournament fight (js/menu/tournament_ui.js), handed over and
// back through localStorage the same way.
const TOURNEY = params.get("tourney") === "1" && !CAREER;
const TOURNEY_FIGHT_KEY = "robo-league.tournament.fight";
const TOURNEY_RESULT_KEY = "robo-league.tournament.result";
// ?scout=1: the scouting tape - an opponent's last fight, re-run AI v AI with
// both robots as they are now (career_ui.js watchTape). Nothing is reported.
const SCOUT = params.get("scout") === "1" && !CAREER && !TOURNEY;
const SCOUT_KEY = "robo-league.career.scout";
const MENU_URL = CAREER || SCOUT ? "index.html#career" : TOURNEY ? "index.html#tournament" : "index.html#quick";
const CAREER_FIGHT_KEY = "robo-league.career.fight";
const CAREER_RESULT_KEY = "robo-league.career.result";
const RESULT_KEYS = CAREER ? "<b>M</b> back to your career &nbsp; <b>P</b> highlights"
  : TOURNEY ? "<b>M</b> back to the tournament &nbsp; <b>P</b> highlights"
  : SCOUT ? "<b>Enter</b> run the tape again &nbsp; <b>P</b> highlights &nbsp; <b>M</b> back to your career" : undefined;
// ?p2=1: two players on one keyboard - Player 2 drives the blue corner
// (input.js readPlayer). Never in a career fight.
const TWO_PLAYER = params.get("p2") === "1" && !CAREER;

/**
 * Let the browser paint before a long synchronous block.
 *
 * Deliberately NOT a bare requestAnimationFrame: rAF does not fire at all
 * while the tab is in the background or the window is fully occluded (Safari
 * is especially eager about this), so awaiting one could stall boot forever -
 * which is exactly what the watchdog used to report as "stuck while starting,
 * got as far as painting textures". The timeout is the floor, so boot always
 * finishes whether or not anyone is looking at the page.
 */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 50);
});
const REPLAY_SECONDS = 6;

boot().catch((err) => {
  console.error(err);
  // Tell the inline watchdog in fight.html to stand down. Without this it
  // fired 30 s later and REPLACED this real stack trace with its own generic
  // "stuck while starting" guess - so the actual error was on screen, then
  // silently thrown away before anyone read it.
  window.__ROBO_FAILED__ = true;
  const o = document.getElementById("boot");
  if (!o) return;
  const status = document.getElementById("boot-status");
  o.classList.add("error");
  o.innerHTML = `<h1>Failed to start</h1>
    <p>Got as far as: <code>${status ? status.textContent : "?"}</code></p>
    <pre>${String((err && err.stack) || err)}</pre>
    <p>If this mentions fetch or CORS, serve the folder over HTTP:
       <code>tools/serve.sh</code>, then open
       <a href="http://localhost:8420/">http://localhost:8420/</a>.</p>
    <p>If it mentions WebGL, this browser or VM cannot render 3D.</p>`;
});

async function boot() {
  const status = (msg) => {
    const o = document.getElementById("boot-status");
    if (o) o.textContent = msg;
  };

  // ---------------------------------------------------------- data + logic
  status("loading data...");
  const reg = await loadRegistryFromFetch(dataDir());
  // Robots that joined the field during the career (field.js) live in the save.
  try { registerCareerRobots(reg, JSON.parse(localStorage.getItem("robo-league.career") || "null")); } catch { /* no career */ }
  let settings = loadSettings();
  // A tournament fight: people's own robots are not in the data files.
  let tourneyHandoff = null;
  if (TOURNEY) {
    try { tourneyHandoff = JSON.parse(localStorage.getItem(TOURNEY_FIGHT_KEY) || "null"); } catch { tourneyHandoff = null; }
    for (const def of Object.values(tourneyHandoff?.custom || {})) reg.addRobot(def);
  }

  const check = validateAll(reg);
  for (const w of check.warnings) console.warn("[data]", w);
  if (!check.ok) {
    throw new Error(`Data validation failed:\n- ${check.errors.join("\n- ")}`);
  }

  const PLAYER_ID = reg.hasRobot(params.get("red") || "") ? params.get("red") : DEFAULT_RED;
  // In a career fight you fight the robot you built in the workshop (Stage 6),
  // handed over by the career screen with the fixture. Only if it builds.
  let playerDef = reg.robot(PLAYER_ID);
  if (CAREER) {
    try {
      const h = JSON.parse(localStorage.getItem(CAREER_FIGHT_KEY) || "null");
      if (h?.meDef && h.meId === PLAYER_ID) {
        const mine = { ...playerDef, ...h.meDef, id: PLAYER_ID };
        assembleRobot(reg, mine);
        playerDef = mine;
      }
    } catch (e) { console.warn("[career] ignoring the workshop hand-off", e); }
  }
  // The scouting tape: both robots as the career has them now.
  let scoutHandoff = null;
  if (SCOUT) {
    try { scoutHandoff = JSON.parse(localStorage.getItem(SCOUT_KEY) || "null"); } catch { scoutHandoff = null; }
    if (scoutHandoff?.red?.id === PLAYER_ID) {
      try { const d = { ...playerDef, ...scoutHandoff.red.def, id: PLAYER_ID }; assembleRobot(reg, d); playerDef = d; } catch (e) { console.warn("[scout] ignoring red", e); }
    }
  }
  const assembled = assembleRobot(reg, playerDef);
  // A career robot turns up with whatever damage its pit did not fix (Stage 7).
  let careerHandoff = null;
  if (CAREER) { try { careerHandoff = JSON.parse(localStorage.getItem(CAREER_FIGHT_KEY) || "null"); } catch { careerHandoff = null; } }
  if (careerHandoff?.meId === PLAYER_ID && careerHandoff.meCondition) Object.assign(assembled.condition, careerHandoff.meCondition);
  console.info(
    `[build] ${assembled.name}: ${assembled.weightLb} lb, ` +
    `${assembled.stats.topSpeedMph.toFixed(1)} mph, ` +
    `push ${assembled.stats.pushRatio.toFixed(2)}x, ` +
    `${assembled.legality.legal ? "legal" : "ILLEGAL"}`
  );

  // The opponent. Its driver - personality, rating, league - comes from its
  // robot file, with URL overrides so you can feel the difference.
  const oppIds = reg.allRobots().map((r) => r.id).filter((id) => id !== PLAYER_ID);
  const blueParam = params.get("blue") || params.get("opp") || "";
  const oppId = reg.hasRobot(blueParam) ? blueParam : DEFAULT_OPPONENT;
  let oppDef = { ...reg.robot(oppId) };
  // A career opponent fights as its current version - the off-season's
  // upgrades and driver rating (js/logic/evolution.js) - handed over by the
  // career screen. Only if it still builds; a bad hand-off falls back.
  if (CAREER) {
    try {
      const h = JSON.parse(localStorage.getItem(CAREER_FIGHT_KEY) || "null");
      if (h?.oppId === oppId && h.oppDef) {
        const evolved = { ...oppDef, ...h.oppDef, id: oppId };
        assembleRobot(reg, evolved);
        oppDef = evolved;
      }
    } catch (e) { console.warn("[career] ignoring the opponent hand-off", e); }
  }
  if (SCOUT && scoutHandoff?.blue?.id === oppId) {
    try { const d = { ...oppDef, ...scoutHandoff.blue.def, id: oppId }; assembleRobot(reg, d); oppDef = d; } catch (e) { console.warn("[scout] ignoring blue", e); }
  }
  // Quick Fight: the opponent drives at the difficulty setting (a career
  // fight's opponent brings the career's, already set up for you). On the
  // scouting tape both drive as themselves.
  if (SCOUT) oppDef.skillBonus = 0;
  else if (!CAREER || oppDef.skillBonus == null) {
    const diff = difficultyOf(reg, settings.difficulty);
    oppDef.skillBonus = diff.skillBonus; oppDef.learnRate = diff.learnRate;
  }
  if (params.get("rating")) oppDef.rating = Number(params.get("rating"));
  if (params.get("league")) oppDef.league = params.get("league");
  if (params.get("personality")) oppDef.personality = params.get("personality");
  const oppAssembled = assembleRobot(reg, oppDef);
  if (careerHandoff?.oppId === oppId && careerHandoff.oppCondition?.[0]) Object.assign(oppAssembled.condition, careerHandoff.oppCondition[0]);
  // Two copies of the same robot would share an id and collide in every map
  // keyed by it.
  if (oppAssembled.id === assembled.id) oppAssembled.id = `${oppAssembled.id}_2`;
  console.info(`[opponent] ${oppAssembled.name}: ${oppDef.personality}, rating ${oppDef.rating} (${oppDef.league})`);

  // One seed per session drives every roll: damage, debris, the judges, both
  // AI drivers and which killsaws come up in the last minute.
  // ?seed=N replays a session exactly - same judges, same AI, same saws.
  const matchSeed = params.get("seed") ? Number(params.get("seed")) >>> 0 : Date.now() & 0xffff;
  console.info(`[match] seed ${matchSeed} (add ?seed=${matchSeed} to replay it)`);
  const bus = makeBus();
  const match = makeMatch(reg.rules, bus, { botIds: [assembled.id, oppAssembled.id], seed: matchSeed });

  // Where: a venue round the box and a hazard layout in it (data/arenas.json).
  // A career fight brings its own; Quick Fight passes ?venue= and ?layout=
  // ("random" draws from the venue's pool by the seed).
  const where = (() => {
    const h = careerHandoff?.arena;
    let venue = h?.venue || params.get("venue") || (CAREER ? venueForLeague(reg, oppDef.league) : DEFAULT_VENUE);
    if (!venueOf(reg, venue)) venue = venueForLeague(reg, venue);
    let layout = h?.layout || params.get("layout") || DEFAULT_LAYOUT;
    if (layout === "random" || !layoutOf(reg, layout)) layout = layoutForFight(reg, venue, matchSeed);
    return { venue, layout };
  })();
  const arena = composeArena(reg, where);
  console.info(`[arena] ${venueOf(reg, where.venue)?.name ?? where.venue} · ${arena.name}`);

  // ---------------------------------------------------------- physics
  status("starting physics...");
  await initPhysics();
  const sim = buildArena(arena);
  const hazards = buildHazards(sim.world, arena, bus, { seed: matchSeed });

  const spawnDef = reg.spawn("red");
  const robotSim = createRobotSim(sim, assembled, {
    pos: { x: ftToM(spawnDef.pos[0]), y: 0, z: ftToM(spawnDef.pos[2]) },
    yaw: degToRad(spawnDef.yaw),
  }, reg.rules, { seed: matchSeed });
  const oppSpawn = reg.spawn("blue");
  const oppSim = createRobotSim(sim, oppAssembled, {
    pos: { x: ftToM(oppSpawn.pos[0]), y: 0, z: ftToM(oppSpawn.pos[2]) },
    yaw: degToRad(oppSpawn.yaw),
  }, reg.rules, { seed: matchSeed + 1 });

  // Multibots: the second unit of either corner, AI driven, spawned beside
  // its main unit. Each fights its own fight; the corner is out when more
  // than half its weight cannot drive (js/sim/referee.js).
  const partners = [];
  for (const [corner, def, main, spawn, tag] of [["red", playerDef, assembled, spawnDef, "p2"], ["blue", oppDef, oppAssembled, oppSpawn, "o2"]]) {
    if (!def.partner) continue;
    const pa = assemblePartner(reg, def);
    if (corner === "blue" && oppAssembled.id !== oppId) pa.id = `${pa.id}_2`;   // same robot in both corners
    const yaw = degToRad(spawn.yaw), off = 1.1;
    const psim = createRobotSim(sim, pa, {
      pos: { x: ftToM(spawn.pos[0]) + Math.sin(yaw) * off, y: 0, z: ftToM(spawn.pos[2]) + Math.cos(yaw) * off }, yaw,
    }, reg.rules, { seed: hashSeed(`${matchSeed}:${tag}`) });
    partners.push({ corner, mainId: main.id, def, assembled: pa, sim: psim, id: pa.id, tag });
  }
  const partnersOf = (corner) => partners.filter((p) => p.corner === corner);
  // A multibot's second unit carries its own damage in from the career too.
  if (careerHandoff?.mePartnerCondition && partnersOf("red")[0]) Object.assign(partnersOf("red")[0].assembled.condition, careerHandoff.mePartnerCondition);
  if (careerHandoff?.oppCondition?.[1] && partnersOf("blue")[0]) Object.assign(partnersOf("blue")[0].assembled.condition, careerHandoff.oppCondition[1]);
  // How every robot came in: a rematch (Enter) starts from this, not from new.
  const startCondition = new Map([assembled, oppAssembled, ...partners.map((p) => p.assembled)].map((a) => [a, { ...a.condition }]));
  const restoreStart = (a) => { for (const k of Object.keys(a.condition)) a.condition[k] = 1; Object.assign(a.condition, startCondition.get(a) || {}); };

  // ---------------------------------------------------------- rendering
  status("building arena...");
  const canvas = document.getElementById("view");
  const { renderer, scene, resize } = makeRenderer(canvas, arena);

  // Generating the grime textures (and Sobelling them into normal maps) is a
  // second or so of synchronous work. Yield a frame first so the status line
  // actually paints, otherwise it looks like a hang.
  status("painting textures...");
  await nextFrame();
  const mats = makeMaterials({ arenaRepeat: 4, style: arena.style });
  const arenaView = buildArenaView(scene, arena, sim, hazards, mats);
  // The building round the box: stands, crowd, lights and screens.
  const venueView = buildVenueView(scene, venueOf(reg, where.venue), arena, {
    bus, seed: matchSeed, names: { red: assembled.name, blue: oppAssembled.name },
  });
  const robotView = buildRobotView(scene, assembled, robotSim, mats);
  const oppView = buildRobotView(scene, oppAssembled, oppSim, mats);
  // Damage carried in from the last fight shows from the first frame.
  for (const [a, v] of [[assembled, robotView], [oppAssembled, oppView]]) {
    for (const [key, c] of Object.entries(a.condition)) if (c < 0.999) v.setPanelCondition(key, c);
  }

  const first = resize();
  const cameraRig = makeCameraRig(arena, bus, first.aspect);

  status("compiling shaders...");
  await nextFrame();
  const post = makePost(renderer, scene, cameraRig.camera, arena);
  console.info(`[render] post-processing ${post.enabled ? "on" : "off"}`);

  addEventListener("resize", () => {
    const r = resize();
    cameraRig.setAspect(r.aspect);
    post.setSize(r.w, r.h);
  });

  // Sparks, dents and flying parts. Driven entirely off the bus, so the logic
  // layer has no idea it is being watched.
  //
  // The rng and the debris pool are declared HERE rather than down with the
  // combat wiring because makeEffects takes both - declared later they were a
  // const temporal-dead-zone reference and boot threw every time.
  const rng = makeRng(matchSeed);
  const debris = makeDebris({ sim, rng });
  for (const p of partners) p.view = buildRobotView(scene, p.assembled, p.sim, mats);
  const robotViews = new Map([[assembled.id, robotView], [oppAssembled.id, oppView], ...partners.map((p) => [p.id, p.view])]);
  // The damage a career robot carries in shows before the bell: dents, loose
  // panels, a bent weapon, smoke.
  const showStartDamage = () => {
    robotView.applyCondition(assembled.condition);
    oppView.applyCondition(oppAssembled.condition);
    for (const p of partners) p.view.applyCondition(p.assembled.condition);
  };
  showStartDamage();
  const effects = makeEffects(scene, {
    bus, mats, robotViews, debris, rng, arena,
  });

  const hud = makeHud(document.getElementById("hud"), {
    assembled, opponent: oppAssembled, rules: reg.rules, cameraRig, bus,
    where: { venue: venueOf(reg, where.venue)?.name ?? "", layout: arena.name },
    // A career fight's history with this opponent (career_ui.js storyOf).
    story: careerHandoff?.oppId === oppId ? careerHandoff.story || null : null,
    corners: {
      [assembled.id]: { corner: "red", assembled, driver: tourneyHandoff?.names?.red || (params.get("driver") === "ai" ? "AI" : TWO_PLAYER ? "player 1" : "you") },
      [oppAssembled.id]: { corner: "blue", assembled: oppAssembled, driver: tourneyHandoff?.names?.blue || (TWO_PLAYER ? "player 2" : `${oppDef.personality} · ${oppDef.rating} · ${oppDef.league}`) },
    },
    twoPlayer: TWO_PLAYER,
    tag: SCOUT && scoutHandoff ? { title: scoutHandoff.label, sub: scoutHandoff.real ? `The real fight: ${scoutHandoff.real}` : "" } : null,
  });

  // ---------------------------------------------------------- sound and commentary
  // Synthesised sound off the bus (js/audio/audio.js) and two commentators
  // (js/logic/commentary.js) - spoken, captioned, or both (Settings).
  const audio = makeAudio({ bus, volume: Number(settings.volume), crowd: Number(settings.crowd), enabled: settings.sound });
  const speech = makeSpeech();
  speech.setVolume(settings.sound ? Number(settings.volume) : 0);
  const WEAPON_WORDS = { spinner_v: "vertical spinner", spinner_h: "horizontal spinner", drum: "drum", hammer: "hammer", flipper: "flipper", lifter: "lifter", crusher: "crusher" };
  const weaponWord = (a) => WEAPON_WORDS[a.stats.weapon.class] || "wedge";
  const commentary = makeCommentary({
    names: { [assembled.id]: assembled.name, [oppAssembled.id]: oppAssembled.name, ...Object.fromEntries(partners.map((p) => [p.id, p.assembled.name])) },
    corners: { [assembled.id]: "red", [oppAssembled.id]: "blue" },
    weapons: { [assembled.id]: weaponWord(assembled), [oppAssembled.id]: weaponWord(oppAssembled) },
    story: careerHandoff?.oppId === oppId ? careerHandoff.story || null : null,
    // Two players: nobody is "you" - the booth calls it straight.
    playerId: TWO_PLAYER || SCOUT ? null : assembled.id,
    where: { venue: venueOf(reg, where.venue)?.name ?? "", layout: arena.name },
    rng: makeRng(hashSeed(`${matchSeed}:booth`)),
    durationS: reg.rules.match?.durationS ?? 180,
  });
  const boothEl = document.createElement("div");
  boothEl.className = "booth-root";
  document.getElementById("hud").appendChild(boothEl);
  const booth = makeCommentaryView(boothEl, { speech, mode: settings.commentary });
  const boothLog = [];                  // what the booth has said this session (the boot check reads it)
  const say = (lines) => { if (!lines?.length) return; booth.push(lines); for (const l of lines) { boothLog.push(l); if (boothLog.length > 200) boothLog.shift(); } };
  // Browsers start sound only after a key or a click.
  let introSaid = false;
  const unlockAudio = () => {
    audio.unlock(); speech.unlock();
    if (!introSaid && match.phase === PHASE.IDLE) { introSaid = true; say(commentary.intro()); }
  };
  addEventListener("keydown", unlockAudio);
  addEventListener("pointerdown", unlockAudio);
  // iPhones only let sound start on a touch's END.
  addEventListener("touchend", unlockAudio);
  const matchT = () => (reg.rules.match?.durationS ?? 180) - match.clockS;
  bus.on(EV.HIT, (e) => say(commentary.event("hit", e, matchT())));
  bus.on(EV.PART_FAILED, (e) => say(commentary.event("failed", e, matchT())));
  bus.on(EV.REF_COUNT, (e) => say(commentary.event("count", e, matchT())));
  bus.on(EV.PIN_WARNING, (e) => say(commentary.event("pin", e, matchT())));
  bus.on(EV.SEPARATE, (e) => say(commentary.event("separate", e, matchT())));
  bus.on(EV.HAZARD_FIRE, (e) => say(commentary.event("hazard", e, matchT())));
  bus.on(EV.MATCH_END, (r) => say(commentary.event("end", r, matchT())));
  // The countdown's beeps, the horn and the booth's "FIGHT!", off the phase.
  let lastPhase = null, lastCountN = null;
  const lastDrive = new Map();          // robot id -> its last DriveInput (for the motor sound)
  const weaponPhase = new Map();        // robot id -> last weapon phase (hammer and flipper fire)
  function soundFrame(dt) {
    if (match.phase !== lastPhase) {
      if (match.phase === PHASE.COUNTDOWN) { say(commentary.event("countdown")); lastCountN = null; }
      if (match.phase === PHASE.LIVE && lastPhase === PHASE.COUNTDOWN) { say(commentary.event("live")); audio.startHorn(); }
      lastPhase = match.phase;
    }
    if (match.phase === PHASE.COUNTDOWN) {
      const n = Math.ceil(match.countdownS ?? 0);
      if (n !== lastCountN && n > 0) { audio.countdownBeep(n); lastCountN = n; }
    }
    const live = match.phase === PHASE.LIVE;
    say(commentary.tick({ clockS: match.clockS, live, dt }));
    booth.update(dt);
    if (!audio.ready) return;
    // Where each robot is, from the camera: left-right pan and distance.
    const cam = cameraRig.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const right = { x: e[0], z: e[2] };
    const units = [
      { id: assembled.id, a: assembled, sim: robotSim, w: weapon },
      { id: oppAssembled.id, a: oppAssembled, sim: oppSim, w: oppWeapon },
      ...partners.map((p) => ({ id: p.id, a: p.assembled, sim: p.sim, w: p.weapon })),
    ];
    const bots = units.map((u) => {
      const p = u.sim.pose().pos;
      const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
      const d = Math.hypot(dx, dz, p.y - cam.position.y) || 1;
      const fam = familyOf(u.a.stats.weapon.class);
      const ph = u.w.phase;
      if (fam === "discrete" && ph === "striking" && weaponPhase.get(u.id) !== "striking") audio.weaponFired((dx * right.x + dz * right.z) / d);
      weaponPhase.set(u.id, ph);
      const dr = lastDrive.get(u.id) || {};
      const top = u.a.stats.topSpeedMps || 6;
      return {
        id: u.id, family: fam, out: u.sim.effective().immobile,
        speed: Math.min(1, u.sim.speedMps() / top), throttle: Math.min(1, Math.abs(dr.throttle || 0) + Math.abs(dr.steer || 0) * 0.5),
        spin: fam === "kinetic" ? u.w.spinPct : 0, omega: u.w.omegaRadS || 0,
        pan: (dx * right.x + dz * right.z) / d, dist: Math.min(1, d / 18),
      };
    });
    const pit = hazards.all.find((h) => h.type === "pit");
    audio.update(dt, { bots, live, pitWarning: pit?.warning || 0, energy: venueOf(reg, where.venue)?.crowd?.energy ?? 0.4 });
  }

  // ---------------------------------------------------------- settings
  // Everything on the Settings page that touches the fight applies the moment
  // it changes - from the pause overlay (Esc) as much as from the menus.
  const CAMERA_START = { chase: /chase/i, overhead: /overhead/i, arena: /arena/i };
  const camStart = cameraRig.list().findIndex((c) => CAMERA_START[settings.camera]?.test(c.label) || CAMERA_START[settings.camera]?.test(c.id));
  if (camStart >= 0) cameraRig.selectIndex(camStart);
  // Two players share the screen: a camera that keeps both robots in it.
  if (TWO_PLAYER) cameraRig.select("versus");
  function applySettings(changed = null) {
    if (post.bloom) post.bloom.enabled = settings.bloom;
    if (renderer.shadowMap && renderer.shadowMap.enabled !== settings.shadows) {
      renderer.shadowMap.enabled = settings.shadows;
      // Shadow maps are compiled into the shaders: every material rebuilds.
      scene.traverse((o) => { const m = o.material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
    }
    const pr = Math.min(devicePixelRatio, 2) * Number(settings.renderScale || 1);
    if (renderer.getPixelRatio && Math.abs(renderer.getPixelRatio() - pr) > 1e-3) {
      renderer.setPixelRatio(pr);
      post.composer?.setPixelRatio(pr);
      const r = resize();
      post.setSize(r.w, r.h);
      cameraRig.setAspect(r.aspect);
    }
    document.getElementById("hud").classList.toggle("no-damage", !settings.hudDamage);
    audio.setEnabled(settings.sound);
    audio.setVolume(Number(settings.volume));
    audio.setCrowd(Number(settings.crowd));
    speech.setVolume(settings.sound ? Number(settings.volume) : 0);
    booth.setMode(settings.commentary);
    if (changed === "difficulty") {
      // A new difficulty takes over the opponent's driving straight away.
      const diff = difficultyOf(reg, settings.difficulty);
      oppDef.skillBonus = diff.skillBonus; oppDef.learnRate = diff.learnRate;
      oppBrain = makeAI({ robot: oppDef, rng: makeRng(hashSeed(`${matchSeed}:opp:${settings.difficulty}`)) });
      for (const p of partnersOf("blue")) p.brain = makeAI({ robot: { ...p.def, skillBonus: diff.skillBonus, learnRate: diff.learnRate }, rng: makeRng(hashSeed(`${matchSeed}:${p.tag}:ai:${settings.difficulty}`)) });
      brains.splice(0, brains.length, [assembled.id, playerBrain], [oppAssembled.id, oppBrain], ...partners.map((p) => [p.id, p.brain]));
      hud.banner(`DIFFICULTY: ${diff.label?.toUpperCase() || settings.difficulty.toUpperCase()}`, 1.5);
    }
  }

  // The pause overlay: Esc pauses a live match and shows the settings.
  const overlay = document.createElement("div");
  overlay.id = "pause-overlay";
  overlay.innerHTML = `<div class="po-card"><div class="po-head"><div class="po-title">PAUSED</div>
    <div class="po-keys"><b>Esc</b> resume &nbsp; <b>M</b> ${CAREER ? "back to your career" : "menu"}</div></div><div class="po-sub">Controls</div><div class="po-controls keys">${controlsHtml(TWO_PLAYER)}</div><div id="po-settings"></div></div>`;
  document.body.appendChild(overlay);
  let overlayOpen = false;
  function toggleOverlay() {
    overlayOpen = !overlayOpen;
    overlay.classList.toggle("open", overlayOpen);
    if (overlayOpen) {
      renderSettings(document.getElementById("po-settings"), {
        note: "Changes apply at once.",
        onChange: (s, id) => { settings = s; applySettings(id); },
      });
    }
    if (overlayOpen ? match.phase === PHASE.LIVE : match.phase === PHASE.PAUSED) match.togglePause();
  }

  // ---------------------------------------------------------- combat
  const weapon = makeWeapon(assembled, reg.rules);
  const oppWeapon = makeWeapon(oppAssembled, reg.rules);
  const combat = makeCombat({ sim, rules: reg.rules, rng, bus });
  combat.registerBot(assembled.id, robotSim, weapon, "red");
  combat.registerBot(oppAssembled.id, oppSim, oppWeapon, "blue");
  for (const p of partners) {
    p.weapon = makeWeapon(p.assembled, reg.rules);
    combat.registerBot(p.id, p.sim, p.weapon, p.corner);
  }
  combat.registerHazards(hazards);

  // ---------------------------------------------------------- control
  // Both bots have an AI brain. The opponent's always drives; yours drives
  // only when you hand over with Tab (or start with ?ai=1). Each gets its own
  // seeded stream so one driver's dice never shift the other's.
  const input = makeInput(window);
  const playerBrain = makeAI({ robot: playerDef, rng: makeRng(hashSeed(`${matchSeed}:player`)) });
  let oppBrain = makeAI({ robot: oppDef, rng: makeRng(hashSeed(`${matchSeed}:opp`)) });
  for (const p of partners) p.brain = makeAI({ robot: p.def, rng: makeRng(hashSeed(`${matchSeed}:${p.tag}:ai`)) });
  const pilot = makePilot(bus, {
    initial: params.get("ai") === "1" || params.get("driver") === "ai" ? PILOT.AI : PILOT.HUMAN,
    brain: playerBrain,
  });
  // Two players: blue is Player 2's until they hand it to the AI (\).
  let p2Human = TWO_PLAYER;
  const replay = makeReplay({ seconds: 12, hz: 30, trackCount: 2 + partners.length });

  // Hits are the AI's cue to back off and reset.
  const brains = [[assembled.id, playerBrain], [oppAssembled.id, oppBrain], ...partners.map((p) => [p.id, p.brain])];
  applySettings();
  bus.on(EV.HIT, (e) => {
    for (const [id, brain] of brains) {
      if (e.attackerId === id) brain.notify({ type: "hit", landed: true, kind: e.kind });
      if (e.defenderId === id) brain.notify({ type: "hit", took: true, kind: e.kind });
    }
  });
  // The referee told someone to let go of a pin.
  bus.on(EV.PIN_WARNING, (e) => {
    for (const [id, brain] of brains) if (e.botId === id) brain.notify({ type: "pinWarning" });
  });

  // ---------------------------------------------------------- referee
  // Watches the physics and feeds the match: the KO count, pins, and the
  // facts the judges score. Same module the headless bouts use.
  const referee = makeReferee({
    match, bus, world: sim.world, arena: { halfX: sim.dims.halfX, halfZ: sim.dims.halfZ },
    sides: [
      { id: assembled.id, units: [{ id: assembled.id, robotSim, weapon }, ...partnersOf("red").map((p) => ({ id: p.id, robotSim: p.sim, weapon: p.weapon }))] },
      { id: oppAssembled.id, units: [{ id: oppAssembled.id, robotSim: oppSim, weapon: oppWeapon }, ...partnersOf("blue").map((p) => ({ id: p.id, robotSim: p.sim, weapon: p.weapon }))] },
    ],
  });

  // Replays wait for the bell - nothing interrupts the fight. Big hits are
  // clipped as they happen, a beat after landing so the aftermath is in the
  // clip, and the best few play back as a highlight reel once the match ends,
  // in the order they happened, before the result card. A flurry of hits a
  // second or two apart is one exchange and makes one clip.
  const REEL_MAX = 3;             // clips in the reel
  const REEL_MIN_HP = 25;         // a hit has to be worth seeing again
  const CLIP_S = 4;               // length of each clip
  // Playback speed: the hit of the match in deep slow motion, the rest quicker
  // so the reel stays around 20 s. P skips it.
  const BEST_SPEED = 0.45, REEL_SPEED = 0.7;
  const CLIP_TAIL_S = 1.5;        // how long after the hit the clip runs on
  let reel = [];                  // { clip, hp, atS } - the best REEL_MAX so far
  let pendingClip = null;         // { hp, hitAtS, captureAtS } - waiting for its aftermath
  let reelQueue = null;           // clips still to play in the showing under way
  let reelTotal = 0;
  bus.on(EV.HIT, (e) => {
    if (match.phase !== PHASE.LIVE) return;
    const hp = (e.hits || []).reduce((sum, h) => sum + (h.hpLost || 0), 0);
    if (hp <= REEL_MIN_HP) return;
    if (pendingClip) {
      // Same exchange: run the clip on to cover this hit's aftermath too, but
      // not so far that the first hit falls off the front of it.
      pendingClip.hp = Math.max(pendingClip.hp, hp);
      pendingClip.captureAtS = Math.min(simTime + CLIP_TAIL_S, pendingClip.hitAtS + CLIP_S - 0.5);
    } else {
      pendingClip = { hp, hitAtS: simTime, captureAtS: simTime + CLIP_TAIL_S };
    }
  });
  function captureClip() {
    const clip = replay.capture(CLIP_S);
    if (clip) {
      reel.push({ clip, hp: pendingClip.hp, atS: pendingClip.hitAtS });
      reel = reel.sort((a, b) => b.hp - a.hp).slice(0, REEL_MAX);
    }
    pendingClip = null;
  }
  let resultsAtS = null;          // when to show the result (after the reel)
  let reelDue = false;            // play the reel first
  bus.on(EV.MATCH_END, (r) => {
    // The sim keeps running past the bell, so a clip still waiting on its
    // aftermath is captured before this fires.
    resultsAtS = simTime + CLIP_TAIL_S + 0.1;
    reelDue = true;
    if (CAREER) reportCareerResult(r);
    if (TOURNEY) reportTourneyResult(r);
  });

  // A tournament fight's result goes back to the tournament, once.
  let tourneyReported = false;
  function reportTourneyResult(r) {
    if (tourneyReported) return;
    tourneyReported = true;
    try {
      if (!tourneyHandoff || tourneyHandoff.red !== PLAYER_ID || tourneyHandoff.blue !== oppId) return;
      const fix = (id) => (id === oppAssembled.id ? oppId : id);
      const damage = Object.fromEntries([assembled.id, oppAssembled.id].map((id) => [fix(id), Math.round(r.tally?.[id]?.damage ?? 0)]));
      localStorage.setItem(TOURNEY_RESULT_KEY, JSON.stringify({
        fixtureId: tourneyHandoff.fixtureId,
        result: { winnerId: fix(r.winnerId), loserId: fix(r.loserId), method: r.method, cause: r.cause ?? null, elapsedS: Math.round(r.elapsedS), decision: r.decision ?? null, damage, by: "played" },
      }));
    } catch (e) { console.error("[tournament] could not hand the result back", e); }
  }

  // A career fight's result goes back to the career, once: the fixture it
  // was for, how it ended, the judges' damage scores and what is left of
  // your robot (the repair bill is worked out from that).
  let careerReported = false;
  function reportCareerResult(r) {
    if (careerReported) return;
    careerReported = true;
    try {
      const handoff = JSON.parse(localStorage.getItem(CAREER_FIGHT_KEY) || "null");
      if (!handoff || handoff.oppId !== oppId) return;
      const damage = {};
      for (const id of [assembled.id, oppAssembled.id]) damage[id === oppAssembled.id ? oppId : id] = Math.round(r.tally?.[id]?.damage ?? 0);
      const fix = (id) => (id === oppAssembled.id ? oppId : id);
      localStorage.setItem(CAREER_RESULT_KEY, JSON.stringify({
        fixtureId: handoff.fixtureId,
        result: {
          winnerId: fix(r.winnerId), loserId: fix(r.loserId), method: r.method, cause: r.cause ?? null,
          elapsedS: Math.round(r.elapsedS), decision: r.decision ?? null, votes: r.votes ?? null, damage, by: "played",
        },
        condition: { ...assembled.condition },
        partnerCondition: partnersOf("red")[0] ? { ...partnersOf("red")[0].assembled.condition } : null,
        // What the opponent's driver learned in this fight (ailearn.js keeps it).
        oppLearned: oppBrain.learned,
        // The opponent goes back to its own pit with what it took.
        oppCondition: [{ ...oppAssembled.condition }, ...partnersOf("blue").map((p) => ({ ...p.assembled.condition }))],
      }));
    } catch (e) { console.error("[career] could not hand the result back", e); }
  }
  // Tap-out needs a second press to confirm - the viewer has no dialogs.
  let tapArmedUntilS = -Infinity;
  let p2TapArmedUntilS = -Infinity;

  const arenaHalfM = ftToM(arena.floor.size[0]) / 2;
  const fixedStep = arena.physics.fixedStepS;
  const maxSubsteps = arena.physics.maxSubsteps;

  let simTime = 0;
  let cameraBeforeReplay = null;

  function toReplayCam() {
    if (!cameraBeforeReplay) cameraBeforeReplay = cameraRig.id;
    cameraRig.select("replay");
  }
  function fromReplayCam() {
    if (cameraBeforeReplay) cameraRig.select(cameraBeforeReplay);
    cameraBeforeReplay = null;
  }

  let replaySpeed = BEST_SPEED;
  /** The last few seconds of the ring - only outside a match (free driving). */
  function startReplay(seconds) {
    if (!replay.play(seconds)) return false;
    replaySpeed = BEST_SPEED;
    toReplayCam();
    return true;
  }

  /** Start the highlight reel from the top. False if there is nothing in it. */
  function playReel() {
    reelQueue = [...reel].sort((a, b) => a.atS - b.atS);
    reelTotal = reelQueue.length;
    return playNextInReel();
  }
  function playNextInReel() {
    while (reelQueue && reelQueue.length) {
      const item = reelQueue.shift();
      if (!replay.playClip(item.clip)) continue;
      toReplayCam();
      const best = reel.every((r) => r.hp <= item.hp);
      replaySpeed = best ? BEST_SPEED : REEL_SPEED;
      const n = reelTotal - reelQueue.length;
      const title = best ? "HIT OF THE MATCH" : reelTotal > 1 ? `REPLAY ${n} / ${reelTotal}` : "REPLAY";
      hud.banner(n === 1 ? `${title} · P TO SKIP` : title, 1.6);
      return true;
    }
    reelQueue = null;
    return false;
  }
  /** Stop whatever is playing, skipping the rest of the reel. */
  function stopReplay() {
    replay.stop();
    reelQueue = null;
    fromReplayCam();
    bus.emit(EV.REPLAY_END);
  }

  const arenaDims = { halfX: sim.dims.halfX, halfZ: sim.dims.halfZ };
  const IDLE_DRIVE = { throttle: 0, steer: 0, brake: false, weapon: 0 };
  // Same wiring as js/sim/bout.js, which the headless AI tests fight with.
  // Keep the two in step.
  const perceptionFor = (selfSim, selfWeapon, otherSim, otherWeapon) => perceive({
    selfSim, selfWeapon, oppSim: otherSim, oppWeapon: otherWeapon,
    hazards, arenaDims, remainingS: match.clockS,
    lead: match.scorebook.lead(selfSim === robotSim || partnersOf("red").some((p) => p.sim === selfSim) ? assembled.id : oppAssembled.id),
  });
  // Every unit goes after the nearest opposing unit that can still drive.
  const corners = {
    red: () => [{ sim: robotSim, weapon }, ...partnersOf("red").map((p) => ({ sim: p.sim, weapon: p.weapon }))],
    blue: () => [{ sim: oppSim, weapon: oppWeapon }, ...partnersOf("blue").map((p) => ({ sim: p.sim, weapon: p.weapon }))],
  };
  function nearestFoe(selfSim, corner) {
    const p = selfSim.pose().pos;
    const foes = corners[corner === "red" ? "blue" : "red"]();
    const working = foes.filter((f) => !f.sim.effective().immobile);
    let best = null, bd = Infinity;
    for (const f of working.length ? working : foes) {
      const q = f.sim.pose().pos;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  const perceiveFoe = (selfSim, selfWeapon, corner) => {
    const f = nearestFoe(selfSim, corner);
    return perceptionFor(selfSim, selfWeapon, f.sim, f.weapon);
  };

  // One physics step. Everything inside runs at exactly `h` seconds.
  function stepSim(h) {
    // Two players split the keyboard; a lone human has all of it.
    const split = p2Human && pilot.mode === PILOT.HUMAN;
    const human = split ? input.readPlayer(0) : input.read();
    const p2 = p2Human ? (split ? input.readPlayer(1) : input.read()) : null;
    const pose = robotSim.pose();
    // Bots hold still until the match is live - the AI does not get a head
    // start on the countdown.
    const live = match.phase === PHASE.LIVE;
    const drive = pilot.read(human, {
      perception: pilot.mode === PILOT.AI ? perceiveFoe(robotSim, weapon, "red") : null,
      dt: h,
      pose, arenaHalf: arenaHalfM,
    });
    const sens = (d) => ({ ...d, steer: Math.max(-1, Math.min(1, (d.steer || 0) * Number(settings.steering || 1))) });
    const oppDrive = p2 ? sens(p2) : live ? oppBrain.drive(perceiveFoe(oppSim, oppWeapon, "blue"), h) : IDLE_DRIVE;
    for (const p of partners) p.drive = live ? p.brain.drive(perceiveFoe(p.sim, p.weapon, p.corner), h) : IDLE_DRIVE;
    // Before the match, the human can still drive around to try the bot.
    // Settings -> Steering sensitivity scales a human's steering.
    const steered = pilot.mode === PILOT.HUMAN ? sens(drive) : drive;
    const myDrive = live || pilot.mode === PILOT.HUMAN ? steered : IDLE_DRIVE;

    // Weapons first: they need this step's effective stats, and the result
    // feeds the contact resolution below.
    weapon.update(h, { demand: myDrive.weapon || 0, effective: robotSim.effective() });
    oppWeapon.update(h, { demand: oppDrive.weapon || 0, effective: oppSim.effective() });
    for (const p of partners) p.weapon.update(h, { demand: p.drive.weapon || 0, effective: p.sim.effective() });

    // The AI concedes through its DriveInput, like everything else it does.
    if (live && !p2 && oppDrive.tapOut) match.tapOut(oppAssembled.id);
    if (live && pilot.mode === PILOT.AI && myDrive.tapOut) match.tapOut(assembled.id);

    lastDrive.set(assembled.id, myDrive); lastDrive.set(oppAssembled.id, oppDrive);
    for (const p of partners) lastDrive.set(p.id, p.drive);
    robotSim.step(myDrive, h);
    oppSim.step(oppDrive, h);
    for (const p of partners) p.sim.step(p.drive, h);
    // The killsaws deploy off the match clock, so they need it.
    hazards.update(h, [pose.pos, oppSim.pose().pos, ...partners.map((p) => p.sim.pose().pos)], { remainingS: match.clockS });
    sim.world.step(combat.eventQueue);
    combat.resolve(h);
    robotSim.clampMotion(); oppSim.clampMotion();
    for (const p of partners) p.sim.clampMotion();
    debris.update(h);

    referee.step(h, { [assembled.id]: myDrive, [oppAssembled.id]: oppDrive, ...Object.fromEntries(partners.map((p) => [p.id, p.drive])) });
    match.update(h);

    simTime += h;
    if (pendingClip && simTime >= pendingClip.captureAtS) captureClip();
    replay.record(h, [robotSim.pose(), oppSim.pose(), ...partners.map((p) => p.sim.pose())], simTime);
  }

  function handleKeys() {
    for (const code of input.drainPressed()) {
      switch (code) {
        case "Enter":
          if (CAREER && careerReported) { hud.banner("PRESS M TO RETURN TO YOUR CAREER", 2); break; }
          if (TOURNEY && tourneyReported) { hud.banner("PRESS M TO RETURN TO THE TOURNAMENT", 2); break; }
          match.start();
          robotSim.reset();
          oppSim.reset();
          for (const p of partners) { p.sim.reset(); restoreStart(p.assembled); p.sim.invalidate(); p.weapon.reset(); p.brain.reset(); }
          // A match starts with the robots as they came in: fresh in a Quick
          // Fight, carrying what the pit did not fix in a career (Stage 7).
          restoreStart(assembled);
          restoreStart(oppAssembled);
          robotSim.invalidate();
          oppSim.invalidate();
          for (const v of robotViews.values()) v.resetCondition();
          showStartDamage();
          weapon.reset();
          oppWeapon.reset();
          playerBrain.reset();
          oppBrain.reset();
          referee.reset();
          if (replay.playing) stopReplay();
          reel = []; pendingClip = null; reelQueue = null; resultsAtS = null; reelDue = false;
          hud.hideResults();
          combat.reset();
          debris.clear();
          effects.clear();
          cameraRig.resetChase();
          commentary.reset();
          booth.clear();
          break;
        case "Escape":
          toggleOverlay();
          break;
        case "KeyN": {
          // Sound on/off, remembered like any other setting.
          settings = { ...settings, sound: !settings.sound };
          saveSettings(settings);
          applySettings("sound");
          hud.banner(settings.sound ? "SOUND ON" : "SOUND OFF", 1.0);
          break;
        }
        case "KeyM":
          // Back to the menu, which remembers the matchup.
          location.href = MENU_URL;
          break;
        case "KeyC":
          input.isDown("ShiftLeft") || input.isDown("ShiftRight")
            ? cameraRig.prev() : cameraRig.next();
          break;
        case "Digit1": case "Digit2": case "Digit3": case "Digit4": case "Digit5": case "Digit6": case "Digit7":
          cameraRig.selectIndex(Number(code.slice(5)) - 1);
          break;
        case "Tab":
          pilot.toggle(assembled.id);
          break;
        case "KeyT":
          if (match.phase !== PHASE.LIVE) break;
          if (simTime <= tapArmedUntilS) { match.tapOut(assembled.id); tapArmedUntilS = -Infinity; }
          else { tapArmedUntilS = simTime + 2; hud.banner(TWO_PLAYER ? "RED: PRESS T AGAIN TO TAP OUT" : "PRESS T AGAIN TO TAP OUT", 2); }
          break;
        case "Backspace":
          // Player 2's tap out, twice like T.
          if (!p2Human || match.phase !== PHASE.LIVE) break;
          if (simTime <= p2TapArmedUntilS) { match.tapOut(oppAssembled.id); p2TapArmedUntilS = -Infinity; }
          else { p2TapArmedUntilS = simTime + 2; hud.banner("BLUE: PRESS BACKSPACE AGAIN TO TAP OUT", 2); }
          break;
        case "Backslash":
          // Player 2 hands blue to the AI, or takes it back.
          if (!TWO_PLAYER) break;
          p2Human = !p2Human;
          if (!p2Human) oppBrain.reset();
          bus.emit(EV.CONTROL_CHANGED, { botId: oppAssembled.id, pilot: p2Human ? PILOT.HUMAN : PILOT.AI });
          hud.banner(p2Human ? "PLAYER 2 HAS BLUE" : "BLUE HANDED TO THE AI", 1.2);
          break;
        case "KeyO": {
          if (CAREER || TOURNEY || SCOUT) break;   // a career or tournament fight is the fight you were drawn
          // Next opponent. A full reload is the honest way to swap a robot:
          // new physics body, new meshes, fresh match.
          if (!oppIds.length) break;
          const next = oppIds[(oppIds.indexOf(oppId) + 1) % oppIds.length];
          params.set("blue", next);
          location.search = params.toString();
          break;
        }
        case "KeyR":
          robotSim.reset();
          for (const p of partnersOf("red")) p.sim.reset();
          cameraRig.resetChase();
          hud.banner("BOT RESET", 1.0);
          break;
        case "KeyP":
          if (replay.playing) {
            // Skip: straight to the result card if the reel was showing.
            stopReplay();
          } else if (match.phase === PHASE.ENDED) {
            // After the bell, P shows the highlight reel again.
            hud.hideResults();
            if (playReel()) resultsAtS = 0;
            else { hud.banner("NO BIG HITS TO REPLAY", 1.2); hud.showResults(match.result, RESULT_KEYS); }
          } else if (match.phase !== PHASE.IDLE) {
            // Replays never interrupt a match.
            hud.banner("REPLAYS AFTER THE BELL", 1.2);
          } else if (!startReplay(REPLAY_SECONDS)) {
            hud.banner("NOT ENOUGH FOOTAGE", 1.0);
          }
          break;
      }
    }
  }

  // ---------------------------------------------------------- frame loop
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    // Cap dt so an alt-tab does not fire a thousand catch-up steps.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    handleKeys();

    let focus;
    let pair = null;                // both corners, for the Versus cam

    if (replay.playing) {
      // Physics is frozen; the scene is driven from recorded transforms.
      const poses = replay.sample(dt, replaySpeed);
      if (poses) {
        robotView.setPose(poses[0].pos, poses[0].quat);
        if (poses[1]) oppView.setPose(poses[1].pos, poses[1].quat);
        partners.forEach((p, i) => { if (poses[2 + i]) p.view.setPose(poses[2 + i].pos, poses[2 + i].quat); });
        focus = poses[0];
        if (poses[1]) pair = [poses[0].pos, poses[1].pos];
      } else {
        focus = robotSim.pose();
        bus.emit(EV.REPLAY_END);
        // Straight on to the next clip of the reel, or back to the live camera.
        if (!playNextInReel()) fromReplayCam();
      }
    } else {
      acc += dt;
      let steps = 0;
      while (acc >= fixedStep && steps < maxSubsteps) {
        stepSim(fixedStep);
        acc -= fixedStep;
        steps++;
      }
      // Fell behind badly - drop the backlog rather than spiralling.
      if (steps === maxSubsteps && acc > fixedStep) acc = 0;

      robotView.update();
      robotView.updateWeapon(weapon, dt);
      oppView.update();
      oppView.updateWeapon(oppWeapon, dt);
      for (const p of partners) { p.view.update(); p.view.updateWeapon(p.weapon, dt); }
      focus = robotSim.pose();
      pair = [focus.pos, oppSim.pose().pos];

      // The bell: the highlight reel, then the result.
      if (resultsAtS !== null && simTime >= resultsAtS && !replay.playing) {
        resultsAtS = null;
        const wantReel = reelDue;
        reelDue = false;
        if (wantReel && settings.replays && playReel()) {
          resultsAtS = 0;          // results once the reel finishes
        } else {
          hud.showResults(match.result, RESULT_KEYS);
        }
      }
    }

    arenaView.update(dt);
    venueView.update(dt, match);
    effects.update(dt);
    cameraRig.update(dt, focus, { replay: replay.playing, pair: pair || [robotSim.pose().pos, oppSim.pose().pos] });
    // A camera outside the box looks through the near walls: they clear out of its way.
    arenaView.setViewpoint(cameraRig.camera.position);
    soundFrame(replay.playing ? 0 : dt);
    hud.update(dt, {
      match, sim: robotSim, pilot, replay, weapon, assembled, rules: reg.rules,
      opponent: { assembled: oppAssembled, def: oppDef, sim: oppSim, weapon: oppWeapon, brain: oppBrain, human: p2Human },
    });

    post.render(scene, cameraRig.camera);
    requestAnimationFrame(frame);
  }

  // Stops the inline watchdog in fight.html from reporting a false stall.
  window.__ROBO_BOOTED__ = true;
  document.getElementById("boot")?.remove();
  requestAnimationFrame(frame);

  // Handy for poking at things from the console: window.ROBO_LEAGUE
  window.ROBO_LEAGUE = {
    reg, assembled, match, robotSim, sim, hazards, cameraRig, replay, pilot, post, bus, PHASE, input,
    get twoPlayer() { return p2Human; },
    weapon, combat, debris, effects, views: robotViews, audio, boothLog,
    /** Clips waiting for the end-of-match highlight reel. */
    get reel() { return reel.map((r) => ({ hp: r.hp, atS: r.atS })); },
    // Stage 3: the opponent and both AI brains.
    opponent: { assembled: oppAssembled, def: oppDef, sim: oppSim, weapon: oppWeapon, brain: oppBrain, view: oppView },
    partners,
    playerBrain,
    // Console helpers for poking at the damage model:
    //   ROBO_LEAGUE.report()  - condition of every part, worst first
    //   ROBO_LEAGUE.bill()    - what the pit would charge
    report: () => worstFirst(conditionReport(assembled, reg.rules)),
    bill: () => repairBill(conditionReport(assembled, reg.rules)),
    effective: () => effectiveStats(assembled, reg.rules),
  };
}
