// ai.js - the AI driver.
//
// Pure logic: no Three.js, no Rapier. It reads a plain PERCEPTION of the fight
// (built by js/sim/ai_bridge.js from the physics state) and writes the same
// DriveInput a keyboard does - { throttle, steer, brake, weapon } - so the AI
// and the human are interchangeable mid-match (see input/pilot.js).
//
// Who it is comes from the robot file, not from code:
//
//   personality   aggressive | defensive | opportunistic  - WHAT it tries to do
//   rating/league                                          - HOW WELL it does it
//
// Skill is not a cheat dial. A low-rated AI is not slowed down or nerfed; it
// sees the opponent late (perception lag), aims with a wandering error, reads
// hazards poorly, mistimes its weapon and fumbles now and again. A world-class
// AI leads its target, flanks spinners, waits for a full spool and pushes you
// into the pulverizer. Same robot, very different fight.
//
// Every random decision comes from the seeded rng handed in, so an AI-vs-AI
// match replays exactly from its seed (rule 6).

import { clamp, lerp } from "../core/vec.js";

export const AI_STATE = {
  SPOOL: "spool",          // kinetic weapon not up to speed: stay away and spin
  ENGAGE: "engage",        // drive at the attack point
  BACKOFF: "backoff",      // just traded a hit: open the gap and reset
  CIRCLE: "circle",        // hold a standoff and wait for an opening
  UNSTICK: "unstick",      // pinned or wedged: reverse out
};

/** Personality: the shape of the plan. All numbers 0..1 or seconds. */
const PERSONALITY = {
  aggressive: {
    spoolThreshold: 0.55,    // attack with a part-spun weapon rather than wait
    backoffS: 0.35,          // barely pauses after a hit
    standoffM: 1.6,          // circles close when it does circle
    flankBias: 0.25,         // mostly comes straight at you
    herdBias: 0.45,
    patienceS: 0.6,          // how long it will circle before forcing it
    riskTolerance: 0.75,     // will cross hazard zones to get to you
    shoveS: 2.6,             // how long it will grind a stalled pushing match
    tapOutHealth: 0.1,       // concedes below this much robot left (when losing)
  },
  defensive: {
    spoolThreshold: 0.95,
    backoffS: 1.4,
    standoffM: 3.0,
    flankBias: 0.7,
    herdBias: 0.35,
    patienceS: 3.5,
    riskTolerance: 0.2,
    shoveS: 0.9,
    tapOutHealth: 0.32,
  },
  opportunistic: {
    spoolThreshold: 0.8,
    backoffS: 0.8,
    standoffM: 2.3,
    flankBias: 0.9,
    herdBias: 0.9,
    patienceS: 1.8,
    riskTolerance: 0.45,
    shoveS: 1.5,
    tapOutHealth: 0.22,
  },
};

/**
 * What the weapon asks of the driver, on top of the personality. A wedge or
 * lifter has no damage to trade: its fight is shoving the opponent into the
 * hazards and the walls and grinding out the pushing matches, so it herds
 * hard and does not let go. (The Stage 6 advisor's fight plans read this.)
 */
export const PLAYBOOK = {
  wedge: { herdBias: 0.95, shoveMul: 2.2, backoffMul: 0.5, flankBias: 0.8 },
  lifter: { herdBias: 0.6, shoveMul: 1.2 },
  crusher: { herdBias: 0.7, shoveMul: 1.4 },
};

/** League floor and ceiling on skill, so a 45-rated world bot is still a pro. */
const LEAGUE_BAND = {
  rookie: [0.15, 0.55],
  pro: [0.35, 0.72],
  elite: [0.55, 0.88],
  world: [0.7, 1.0],
};

/**
 * Turn a robot's personality, rating and league into concrete driving numbers.
 * Exposed so the workshop / season screens can show what a rating MEANS.
 */
export function aiProfile({ personality = "opportunistic", rating = 50, league = "rookie", archetype = null, skillBonus = 0, tactics = null } = {}) {
  const pers = PERSONALITY[personality] || PERSONALITY.opportunistic;
  const pb = PLAYBOOK[archetype] || {};
  // `tactics`: what this driver has learned works (js/logic/ailearn.js) -
  // offsets on how much it flanks, presses and herds.
  const t = tactics || {};
  const p = {
    ...pers,
    herdBias: clamp(Math.max(pers.herdBias, pb.herdBias ?? 0) + (t.herd || 0), 0, 1),
    flankBias: clamp(Math.max(pers.flankBias, pb.flankBias ?? 0) + (t.flank || 0), 0, 1),
    shoveS: pers.shoveS * (pb.shoveMul ?? 1) * (1 + (t.aggression || 0)),
    backoffS: pers.backoffS * (pb.backoffMul ?? 1) * clamp(1 - (t.aggression || 0), 0.3, 2),
    spoolThreshold: clamp(pers.spoolThreshold - (t.aggression || 0) * 0.3, 0.3, 0.98),
  };
  const [lo, hi] = LEAGUE_BAND[league] || LEAGUE_BAND.rookie;
  // `skillBonus` is the difficulty setting, in fights against the player.
  const skill = clamp(lo + (hi - lo) * clamp(rating / 100, 0, 1) + skillBonus, 0, 1);
  return {
    personality: PERSONALITY[personality] ? personality : "opportunistic",
    skill,
    ...p,
    // How stale its picture of the opponent is.
    reactionS: lerp(0.38, 0.05, skill),
    // Slowly wandering heading error, radians.
    aimNoiseRad: lerp(0.32, 0.03, skill),
    // How far ahead it predicts the opponent's motion, as a fraction of the
    // closing time. Rookies chase where you WERE.
    lead: lerp(0.0, 0.9, skill),
    // Steering sharpness. Too low overshoots; rookies also saw-tooth.
    steerGain: lerp(1.15, 2.4, skill),
    // How strongly it reads and respects hazards (and uses them on you).
    hazardSense: lerp(0.15, 1.0, skill),
    // Weapon timing error, seconds early/late on a discrete weapon.
    triggerJitterS: lerp(0.22, 0.02, skill),
    // Chance per second of a brief fumble (a wrong-way twitch).
    fumblePerS: lerp(0.35, 0.0, skill),
    // Whether it will deliberately come at a spinner from the side.
    flanks: skill > 0.45 || (t.flank || 0) > 0.15,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.robot   the robot def (personality, rating, league)
 * @param {object} opts.rng     seeded rng from core/rng.js
 */
export function makeAI({ robot, rng, learnRate = robot.learnRate ?? 0.7 }) {
  const base = aiProfile(robot);
  // Learning in the fight: every exchange teaches it whether its approach is
  // working. Hit coming in head-on -> flank more; landing hits -> press
  // harder; eating hits while it waits -> stop waiting. A better driver, and
  // a harder difficulty, learns faster. Reset with the fight.
  const live = { flank: 0, aggression: 0, exchanges: 0, landed: 0, took: 0 };
  const lr = clamp(learnRate * (0.4 + base.skill), 0, 2) * 0.06;
  // `prof` is the profile as adjusted for the scorecard this step (see
  // tactics()); `base` is who the driver is.
  let prof = base;

  let state = AI_STATE.ENGAGE;
  let stateT = 0;
  let clock = 0;
  let aimErr = 0;               // current wandering aim error, radians
  let fumbleT = 0;              // seconds of fumble remaining
  let fumbleSteer = 0;
  let stuckT = 0;
  let unstickDir = 1;
  let circleDir = rng.bool() ? 1 : -1;
  let triggerPlanT = null;      // discrete weapon: when to fire
  let myFamily = "none", myArchetype = null;   // from the last perception, for notify()
  let lastThrottle = 0;         // its own last commands, for stuck detection
  let lastSteer = 0;
  let shoveT = 0;               // seconds in a pushing match going nowhere
  let outgunT = 0;              // seconds spent declining a losing exchange
  let tapCheckT = 0;            // seconds since it last considered tapping out
  let tappedOut = false;
  const history = [];           // [{ t, pos, vel }] of the opponent, for lag

  const setState = (s) => { if (s !== state) { state = s; stateT = 0; } };

  /** One exchange's lesson. The approach it was using is what gets the credit or the blame. */
  function learn(ev) {
    live.exchanges++;
    const flanking = state === AI_STATE.CIRCLE || (prof.flanks && prof.flankBias + live.flank > 0.5);
    if (ev.took) {
      live.took++;
      // Hurt coming straight in: go round. Hurt while circling: that is not working either - commit.
      if (flanking) live.aggression += lr * 0.6; else live.flank += lr;
    }
    if (ev.landed) {
      live.landed++;
      live.aggression += lr * 0.5;
      if (flanking) live.flank += lr * 0.3; else live.flank -= lr * 0.3;
    }
    live.flank = clamp(live.flank, -0.35, 0.45);
    live.aggression = clamp(live.aggression, -0.35, 0.45);
  }
  /** The profile with this fight's lessons applied. */
  function adjusted(pr) {
    if (!live.exchanges) return pr;
    return {
      ...pr,
      flankBias: clamp(pr.flankBias + live.flank, 0, 1),
      flanks: pr.flanks || live.flank > 0.15,
      backoffS: pr.backoffS * clamp(1 - live.aggression, 0.3, 2),
      spoolThreshold: clamp(pr.spoolThreshold - live.aggression * 0.3, 0.3, 0.98),
      patienceS: pr.patienceS * clamp(1 - live.aggression, 0.3, 2),
    };
  }

  /** The opponent as this AI perceives it: `reactionS` old. */
  function perceivedOpponent(opp) {
    history.push({ t: clock, pos: { ...opp.pos }, vel: { ...opp.vel } });
    while (history.length > 2 && history[1].t <= clock - prof.reactionS) history.shift();
    const h = history[0];
    // Dead-reckon the stale sample forward by how stale it is - a pro's
    // brain does this, a rookie's barely does.
    const age = clock - h.t;
    const k = prof.skill;
    return {
      ...opp,
      pos: { x: h.pos.x + h.vel.x * age * k, z: h.pos.z + h.vel.z * age * k },
      vel: h.vel,
    };
  }

  return {
    get state() { return state; },
    get profile() { return base; },
    /** The profile as the scorecard has bent it this step. */
    get tactics() { return prof; },

    /** Tell the AI something happened to it. combat events feed this. */
    notify(event) {
      // Told to let go of a pin: let go, and come again from the other side.
      if (event.type === "pinWarning") {
        circleDir = -circleDir;
        setState(AI_STATE.BACKOFF);
        return;
      }
      if (event.type === "hit" && (event.landed || event.took)) {
        // Only weapon hits teach it about its approach - two pushers shoving
        // each other learn nothing about where a weapon comes from.
        if (event.kind === undefined || event.kind === "weapon") learn(event);
        // A crusher that has bitten, or a lifter that has its forks under
        // something, hangs on and carries it - backing off would let go.
        const holding = event.landed && (myFamily === "crusher" || myArchetype === "lifter");
        // Traded blows: reset, unless this personality never lets up.
        if (prof.backoffS > 0.01 && !holding) setState(AI_STATE.BACKOFF);
        if (event.took) circleDir = -circleDir;
      }
    },

    /** What it has learned so far this fight (the career keeps it, ailearn.js). */
    get learned() { return { flank: live.flank, aggression: live.aggression, landed: live.landed, took: live.took }; },

    reset() {
      Object.assign(live, { flank: 0, aggression: 0, exchanges: 0, landed: 0, took: 0 });
      state = AI_STATE.ENGAGE; stateT = 0; clock = 0; aimErr = 0;
      fumbleT = 0; stuckT = 0; triggerPlanT = null; history.length = 0;
      lastThrottle = 0; lastSteer = 0; shoveT = 0; outgunT = 0;
      tapCheckT = 0; tappedOut = false; prof = base;
    },

    /**
     * One decision.
     * @param {object} p  perception - see js/sim/ai_bridge.js for the shape
     * @param {number} dt seconds
     * @returns DriveInput
     */
    drive(p, dt) {
      myFamily = p.self.family;
      myArchetype = p.self.archetype;
      clock += dt;
      stateT += dt;
      prof = adjusted(tactics(base, p));
      const me = p.self;
      const opp = perceivedOpponent(p.opponent);

      // ---- flipped. A bot that can right itself does that before anything
      // else; one that cannot just keeps trying to drive (the referee counts it).
      if ((me.upright ?? 1) < 0.4 && !me.inverted && me.canSelfRight) {
        lastThrottle = 0; lastSteer = 0;
        return { throttle: 0, steer: 0, brake: false, weapon: 0, selfRight: true, tapOut: false };
      }

      // ---- noise processes. An Ornstein-Uhlenbeck wander for aim, so the
      // error drifts like a hand on a stick instead of jittering per frame.
      aimErr += (-aimErr * 1.6 + (rng.next() - 0.5) * 2 * prof.aimNoiseRad * 4.0) * dt;
      if (fumbleT > 0) fumbleT -= dt;
      else if (rng.next() < prof.fumblePerS * dt) {
        fumbleT = 0.12 + rng.next() * 0.25;
        fumbleSteer = rng.bool() ? 1 : -1;
      }

      const toOpp = { x: opp.pos.x - me.pos.x, z: opp.pos.z - me.pos.z };
      const dist = Math.hypot(toOpp.x, toOpp.z);
      const contactDist = me.halfLenM + opp.halfLenM;
      const gap = Math.max(0, dist - contactDist);

      // ---- stuck detection: asking for drive or a turn and getting neither.
      // Throttle alone is not enough to watch - a bot trying to pivot toward a
      // target behind it commands almost no throttle, and one beached on the
      // kickplate sat there "pivoting" for the rest of the match.
      const asking = Math.abs(lastThrottle) > 0.4 || Math.abs(lastSteer) > 0.6;
      const going = me.speed > 0.2 || Math.abs(me.yawRate ?? 1) > 0.35;
      if (state !== AI_STATE.UNSTICK && asking && !going && gap > 0.2) {
        stuckT += dt;
      } else if (state !== AI_STATE.UNSTICK) {
        stuckT = Math.max(0, stuckT - dt * 2);
      }
      if (stuckT > lerp(1.3, 0.5, prof.skill)) {
        setState(AI_STATE.UNSTICK);
        unstickDir = lastThrottle > 0 ? -1 : 1;
        stuckT = 0;
      }

      // ---- stalled pushing match: nose to nose, nobody moving. Break off
      // and come again from a new angle - a pro sooner than a rookie.
      if (state === AI_STATE.ENGAGE && gap < 0.2 && me.speed < 0.3 && opp.speed < 0.3) shoveT += dt;
      else shoveT = Math.max(0, shoveT - dt);
      if (shoveT > prof.shoveS * lerp(1.4, 0.7, prof.skill)) {
        shoveT = 0;
        circleDir = -circleDir;
        setState(AI_STATE.BACKOFF);
      }

      // ---- choose the state.
      const kinetic = me.family === "kinetic";
      // Spinner-on-spinner, whoever has more energy in the rotor at contact
      // wins the exchange (combat.js). A thinking driver does not trade hits
      // while outgunned, and pounces the moment the other rotor is spent.
      // Rookies do not read it at all.
      const ratio = opp.family === "kinetic" && kinetic ? (opp.energyJ + 1) / (me.energyJ + 1) : 0;
      const readsEnergy = prof.skill > 0.45;
      const outgunned = readsEnergy && ratio > (prof.personality === "aggressive" ? 1.9 : 1.2) &&
                        me.spinPct < 0.97 && outgunT < lerp(3, 7, prof.skill);
      outgunT = outgunned ? outgunT + dt : Math.max(0, outgunT - dt * 0.5);
      const pounce = readsEnergy && ratio > 0 && ratio < 0.45 && me.spinPct > 0.35;
      const spooled = !kinetic || me.weaponDead || pounce ||
                      (me.spinPct >= prof.spoolThreshold && !outgunned);
      switch (state) {
        case AI_STATE.UNSTICK:
          if (stateT > 1.2 || (stateT > 0.5 && me.speed > 0.4)) setState(AI_STATE.ENGAGE);
          break;
        case AI_STATE.BACKOFF:
          if (stateT > prof.backoffS || (pounce && stateT > 0.2)) setState(spooled ? AI_STATE.ENGAGE : AI_STATE.SPOOL);
          break;
        case AI_STATE.SPOOL:
          if (spooled) setState(AI_STATE.ENGAGE);
          break;
        case AI_STATE.CIRCLE:
          // Strike when the opening shows, or when patience runs out.
          if (!spooled) setState(AI_STATE.SPOOL);
          else if (pounce || opening(me, opp, prof) || stateT > prof.patienceS) setState(AI_STATE.ENGAGE);
          break;
        case AI_STATE.ENGAGE:
        default:
          if (!spooled) setState(AI_STATE.SPOOL);
          // Don't charge a live spinner's face unless you win the exchange -
          // hold off and wait for it to turn away or spend its rotor. The
          // cautious personalities always think this way; anyone skilled
          // learns to, aggressive or not.
          else if (opp.family === "kinetic" && opp.spinPct > 0.5 && !pounce &&
                   (prof.flankBias > 0.6 || prof.skill > 0.6) && !(ratio > 0 && ratio < 0.8) &&
                   facing(opp, me) && gap > 0.8 && gap < prof.standoffM + 1.5 && stateT > 0.5) {
            setState(AI_STATE.CIRCLE);
          }
          break;
      }

      // ---- where it wants to go.
      let want;
      let throttleCap = 1;
      let reverse = false;
      switch (state) {
        case AI_STATE.UNSTICK: {
          // Back out turning. If it is beached with wheels in the air, rock it
          // - forward, back, forward - which is how drivers shake free.
          const beached = (me.wheelsDown ?? 4) < 3;
          const dir = beached ? (Math.floor(stateT / 0.3) % 2 ? -unstickDir : unstickDir) : unstickDir;
          lastThrottle = dir;
          lastSteer = 0.8 * circleDir;
          return {
            throttle: dir,
            steer: lastSteer,
            brake: false,
            weapon: weaponDemand(me, opp, gap, 0),
            tapOut: considerTapOut(p, dt),
          };
        }
        case AI_STATE.SPOOL:
        case AI_STATE.BACKOFF: {
          // Away from the opponent, curving round so it does not run itself
          // into a wall. Faster away when the opponent is close.
          const away = norm({ x: -toOpp.x, z: -toOpp.z });
          const side = { x: -away.z * circleDir, z: away.x * circleDir };
          const keep = state === AI_STATE.SPOOL ? prof.standoffM + 1.5 : prof.standoffM;
          const k = clamp((keep - gap) / keep, 0, 1);
          want = norm({ x: away.x * k + side.x * (1 - k * 0.5), z: away.z * k + side.z * (1 - k * 0.5) });
          throttleCap = state === AI_STATE.BACKOFF ? 1 : lerp(0.45, 0.85, k);
          // Fresh off a hit, just reverse out rather than turning round.
          if (state === AI_STATE.BACKOFF && stateT < Math.min(0.45, prof.backoffS)) reverse = true;
          break;
        }
        case AI_STATE.CIRCLE: {
          // Orbit at the standoff distance, drifting toward the opponent's flank.
          const n = norm(toOpp);
          const tangent = { x: -n.z * circleDir, z: n.x * circleDir };
          const radial = clamp((gap - prof.standoffM) / prof.standoffM, -1, 1);
          want = norm({ x: tangent.x + n.x * radial * 1.5, z: tangent.z + n.z * radial * 1.5 });
          throttleCap = 0.75;
          break;
        }
        case AI_STATE.ENGAGE:
        default: {
          // Never aim at a point the bot cannot physically reach: a target
          // tight to the wall is driven at as if it were a little inboard.
          const ap = attackPoint(me, opp, gap, prof, p);
          const lim = (h) => h - me.halfLenM - 0.15;
          ap.x = clamp(ap.x, -lim(p.arena.halfX), lim(p.arena.halfX));
          ap.z = clamp(ap.z, -lim(p.arena.halfZ), lim(p.arena.halfZ));
          want = norm(subXZ(ap, me.pos));
          break;
        }
      }

      // ---- hazards and walls bend the path. Skill decides how well it reads
      // them; personality how much risk it takes to reach the opponent.
      const avoid = hazardAvoidance(me, p, prof, state === AI_STATE.ENGAGE ? gap : Infinity);
      want = norm({ x: want.x + avoid.x, z: want.z + avoid.z });

      // ---- steer to it, with the wandering aim error on top.
      let bearing = bearingTo(me.yaw, want) + aimErr;
      if (reverse) bearing = wrapPi(bearing + Math.PI);   // aim the TAIL down the path
      let steer = clamp(-bearing * prof.steerGain, -1, 1);
      // Turn first when far off line, then drive - better pros carry more
      // speed into the turn.
      const align = Math.cos(bearing);
      let throttle = (align > 0 ? align : align * 0.3) * throttleCap;
      if (Math.abs(bearing) > lerp(1.0, 1.35, prof.skill)) throttle *= 0.15;
      if (reverse) throttle = -Math.abs(throttle || 0.8);

      // ---- don't drive into the wall at full speed. Look ahead along the
      // nose; a wedge that hits the angled kickplate flat out rides up it and
      // beaches with its wheels in the air. Skill decides how far it looks.
      const ahead = lerp(0.35, 0.9, prof.skill);
      const hx = Math.cos(me.yaw), hz = -Math.sin(me.yaw);
      const sgn = throttle >= 0 ? 1 : -1;
      const reachX = me.pos.x + hx * sgn * (me.halfLenM + me.speed * ahead);
      const reachZ = me.pos.z + hz * sgn * (me.halfLenM + me.speed * ahead);
      const over = Math.max(Math.abs(reachX) - p.arena.halfX, Math.abs(reachZ) - p.arena.halfZ);
      // ...unless it is pinning the opponent there, which is the point.
      if (over > -0.2 && !(state === AI_STATE.ENGAGE && gap < 0.5)) {
        throttle *= clamp(-over / 0.6, 0.15, 1);
      }
      // ...and never over the edge of an open pit - even shoving the other
      // robot in, it stops with its own nose at the edge.
      for (const h of p.hazards) {
        if (h.kind !== "pit" || h.danger < 0.9) continue;
        const edge = distToZone({ x: reachX, z: reachZ }, h).dist;
        if (edge < 0.35) throttle *= clamp(edge / 0.35, 0.0, 1);
      }

      if (fumbleT > 0) steer = fumbleSteer;
      lastThrottle = clamp(throttle, -1, 1);
      lastSteer = steer;

      return {
        throttle: lastThrottle,
        steer,
        brake: false,
        weapon: weaponDemand(me, opp, gap, bearingTo(me.yaw, norm(toOpp))),
        tapOut: considerTapOut(p, dt),
      };
    },
  };

  // ------------------------------------------------------------------ helpers
  // (closures over prof/rng/state)

  /**
   * Concede? Teams tap out to save what is left of the robot for the next
   * fight. Only when losing, badly hurt, against an opponent that is still
   * dangerous, and with enough time left that hanging on would cost more. Once
   * a second, not every step, and once only.
   */
  function considerTapOut(p, dt) {
    if (tappedOut) return true;
    tapCheckT += dt;
    if (tapCheckT < 1) return false;
    tapCheckT = 0;
    const me = p.self, opp = p.opponent;
    const hurt = (me.health ?? 1) < base.tapOutHealth;
    const losing = (p.lead ?? 0) < -0.1;
    const theyCanHurtMe = !opp.weaponDead && opp.family !== "none";
    const timeLeft = (p.remainingS ?? 0) > 20;
    const outclassed = (opp.health ?? 1) > (me.health ?? 1) + 0.25;
    if (hurt && losing && theyCanHurtMe && timeLeft && outclassed) tappedOut = true;
    return tappedOut;
  }

  /** How hard to run the weapon. */
  function weaponDemand(me, opp, gap, bearingToOpp) {
    if (me.family === "kinetic") return 1;               // always spooling
    if (me.family === "none" || me.weaponDead) return 0;
    const inReach = gap < me.reachM + 0.08 && Math.abs(bearingToOpp) < 0.45;
    if (me.family === "crusher") {
      // Close as it comes into the jaw, and keep it shut on a robot it holds.
      const near = gap < me.reachM + 0.08 && Math.abs(bearingToOpp) < 0.6;
      const holding = (me.weaponPhase === "closed" || me.weaponPhase === "striking") && gap < me.reachM + 0.3;
      return near || holding ? 1 : 0;
    }
    // Discrete: plan a trigger time when the opponent comes into reach, with
    // a timing error that shrinks with skill. A rookie fires early and whiffs.
    if (!me.weaponReady) { triggerPlanT = null; return 0; }
    const closingIn = gap < me.reachM + 0.6 && Math.abs(bearingToOpp) < 0.6;
    if (closingIn && triggerPlanT === null) {
      triggerPlanT = clock + Math.max(0, (rng.next() - 0.5) * 2 * prof.triggerJitterS);
    }
    if (!closingIn) triggerPlanT = null;
    if (triggerPlanT !== null && clock >= triggerPlanT && (inReach || rng.next() < 0.5 - prof.skill * 0.5)) {
      triggerPlanT = null;
      return 1;
    }
    return 0;
  }

  /**
   * The point it actually drives at. Starts as the opponent, then:
   *  - leads a moving target (skill),
   *  - swings round to a flank against a spinner or any front-weapon bot
   *    (personality x skill), approaching wide and cutting in late,
   *  - picks an angle that shoves the opponent toward a live hazard (herding).
   */
  function attackPoint(me, opp, gap, prof, p) {
    const closeT = gap / Math.max(1, me.topSpeed * 0.8);
    const lead = Math.min(1.0, closeT * prof.lead);
    let target = { x: opp.pos.x + opp.vel.x * lead, z: opp.pos.z + opp.vel.z * lead };

    // Flanking.
    const oppFwd = { x: Math.cos(opp.yaw), z: -Math.sin(opp.yaw) };
    const frontDanger = (opp.family === "kinetic" ? opp.spinPct : 0.5) * (opp.frontWeapon ? 1 : 0.3);
    if (prof.flanks && gap > 0.6 && frontDanger > 0.3) {
      // Which flank is nearer to us.
      const rel = subXZ(me.pos, opp.pos);
      const sideSign = oppFwd.x * rel.z - oppFwd.z * rel.x > 0 ? 1 : -1;
      const flankDir = { x: -oppFwd.z * sideSign, z: oppFwd.x * sideSign };
      const bias = Math.max(prof.flankBias, prof.skill > 0.6 ? lerp(0.4, 0.85, (prof.skill - 0.6) / 0.4) : 0);
      const wide = clamp(gap / 3, 0, 1) * bias * frontDanger;
      // Aim between its side and its rear, further out while far away.
      const off = (opp.halfLenM + 0.9) * wide;
      target = {
        x: target.x + (flankDir.x - oppFwd.x * 0.6) * off,
        z: target.z + (flankDir.z - oppFwd.z * 0.6) * off,
      };
    }

    // Herding: come at it from the side opposite a live hazard, so the shove
    // carries it in. Only once it is close enough that a shove is coming.
    if (gap < 3.0 && prof.herdBias * prof.hazardSense > 0.25) {
      const h = bestHerdTarget(opp, p.hazards, p.arena);
      if (h) {
        const push = norm(subXZ(h, opp.pos));
        // Stand-off point behind the opponent along the push line.
        const behind = { x: opp.pos.x - push.x * (contactOf(me, opp) + 0.4), z: opp.pos.z - push.z * (contactOf(me, opp) + 0.4) };
        const w = prof.herdBias * prof.hazardSense * clamp((3.0 - gap) / 2, 0, 1);
        // Once lined up behind it, drive THROUGH it toward the hazard.
        const lined = dotXZ(norm(subXZ(opp.pos, me.pos)), push) > 0.85;
        const goal = lined ? { x: opp.pos.x + push.x, z: opp.pos.z + push.z } : behind;
        target = { x: lerp(target.x, goal.x, w), z: lerp(target.z, goal.z, w) };
      }
    }
    return target;
  }
}

/**
 * Bend the profile to the scorecard. Behind on points in the closing minute,
 * any driver takes more risk - shorter resets, less patience, attacks on a
 * part-spun rotor. Ahead late, the cautious personalities protect the lead.
 * Skill decides how well it reads the scorecard at all.
 */
export function tactics(base, p) {
  const remaining = p.remainingS ?? Infinity;
  const lead = (p.lead ?? 0) * clamp(base.skill * 1.4, 0.3, 1);
  if (remaining > 60) return base;
  const late = clamp((60 - remaining) / 60, 0, 1);
  if (lead < -0.08) {
    const u = clamp(late * 0.7 + 0.3, 0, 1) * clamp(-lead * 4, 0, 1);
    return {
      ...base,
      spoolThreshold: base.spoolThreshold - 0.3 * u,
      backoffS: base.backoffS * (1 - 0.6 * u),
      patienceS: base.patienceS * (1 - 0.7 * u),
      riskTolerance: clamp(base.riskTolerance + 0.35 * u, 0, 1),
      shoveS: base.shoveS * (1 + u),
      urgency: u,
    };
  }
  if (lead > 0.12 && base.personality !== "aggressive") {
    const u = late * clamp(lead * 3, 0, 1);
    return {
      ...base,
      spoolThreshold: Math.min(0.98, base.spoolThreshold + 0.1 * u),
      backoffS: base.backoffS * (1 + 0.5 * u),
      patienceS: base.patienceS * (1 + u),
      riskTolerance: base.riskTolerance * (1 - 0.5 * u),
      urgency: -u,
    };
  }
  return base;
}

/** Is `a` pointing its front at `b`? */
function facing(a, b) {
  const f = { x: Math.cos(a.yaw), z: -Math.sin(a.yaw) };
  return dotXZ(f, norm(subXZ(b.pos, a.pos))) > 0.6;
}

/** A moment worth attacking: it is facing away, stuck, or its weapon is down. */
function opening(me, opp, prof) {
  if (!facing(opp, me)) return true;
  if (opp.speed < 0.15) return true;
  if (opp.family === "kinetic" && opp.spinPct < 0.35) return true;
  if (opp.family === "discrete" && !opp.weaponReady) return true;
  return false;
}

/**
 * Steering push away from hazards and walls. Each danger zone is a circle or a
 * capsule from the perception; danger 0..1 scales it (an armed pulverizer is
 * 1, one on cooldown is low, a stowed killsaw that is about to rise is high).
 */
function hazardAvoidance(me, p, prof, gapToOpp) {
  const out = { x: 0, z: 0 };
  // A risk-taker with the opponent right there will take a hazard on.
  const urgency = gapToOpp < 1.2 ? prof.riskTolerance : 0;
  const sense = prof.hazardSense * (1 - urgency * 0.7);
  const hx = Math.cos(me.yaw), hz = -Math.sin(me.yaw);
  for (const h of p.hazards) {
    const d = distToZone(me.pos, h);
    // An open pit ends the fight: nobody is too green to see a hole in the
    // floor, no opponent is worth driving into it for, and pushing straight
    // away from it only stalls a robot heading across - so it also steers
    // round it, on whichever side the robot is already pointing.
    const lethal = h.kind === "pit";
    const reach = h.radius + me.halfLenM + (lethal ? 1.6 : 1.2);
    if (d.dist > reach) continue;
    const s = lethal ? Math.max(0.65, prof.hazardSense) : sense;
    const k = ((reach - d.dist) / reach) ** 2 * h.danger * s * (lethal ? 6.0 : 3.0);
    out.x += d.away.x * k;
    out.z += d.away.z * k;
    if (lethal) {
      const side = (-d.away.z * hx + d.away.x * hz) >= 0 ? 1 : -1;
      out.x += -d.away.z * side * k * 0.9;
      out.z += d.away.x * side * k * 0.9;
    }
  }
  // Walls: a gentle push inward near them, so it does not grind the kickplate.
  const m = 1.1 + me.halfLenM;
  const ax = p.arena.halfX, az = p.arena.halfZ;
  if (me.pos.x > ax - m) out.x -= ((me.pos.x - (ax - m)) / m) * 1.5;
  if (me.pos.x < -ax + m) out.x += ((-ax + m - me.pos.x) / m) * 1.5;
  if (me.pos.z > az - m) out.z -= ((me.pos.z - (az - m)) / m) * 1.5;
  if (me.pos.z < -az + m) out.z += ((-az + m - me.pos.z) / m) * 1.5;
  return out;
}

/** The hazard this opponent is best shoved into, if any is close enough. */
function bestHerdTarget(opp, hazards, arena) {
  let best = null, bestScore = 0;
  for (const h of hazards) {
    if (h.danger < 0.5) continue;
    const d = distToZone(opp.pos, h).dist;
    if (d > 4.0) continue;
    // A pit ends the fight on the spot; a pulverizer hits harder than the rest.
    const score = h.danger * (1 - d / 4.0) * (h.kind === "pit" ? 1.8 : h.kind === "pulverizer" ? 1.4 : 1);
    if (score > bestScore) { bestScore = score; best = h.center; }
  }
  return best;
}

/** Distance from a point to a hazard zone (circle, or capsule for screws). */
function distToZone(pt, h) {
  if (h.segment) {
    const [a, b] = h.segment;
    const ab = subXZ(b, a);
    const t = clamp(dotXZ(subXZ(pt, a), ab) / Math.max(1e-6, dotXZ(ab, ab)), 0, 1);
    const c = { x: a.x + ab.x * t, z: a.z + ab.z * t };
    const v = subXZ(pt, c);
    const l = Math.hypot(v.x, v.z);
    return { dist: Math.max(0, l - h.radius), away: l > 1e-6 ? { x: v.x / l, z: v.z / l } : { x: 1, z: 0 } };
  }
  const v = subXZ(pt, h.center);
  const l = Math.hypot(v.x, v.z);
  return { dist: Math.max(0, l - h.radius), away: l > 1e-6 ? { x: v.x / l, z: v.z / l } : { x: 1, z: 0 } };
}

const contactOf = (a, b) => a.halfLenM + b.halfLenM;

/** Signed angle from the bot's heading to a direction. Bot forward is local +X. */
export function bearingTo(yaw, dir) {
  const hx = Math.cos(yaw), hz = -Math.sin(yaw);
  return Math.atan2(hx * dir.z - hz * dir.x, hx * dir.x + hz * dir.z);
}

const subXZ = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const dotXZ = (a, b) => a.x * b.x + a.z * b.z;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function norm(v) {
  const l = Math.hypot(v.x, v.z);
  return l > 1e-9 ? { x: v.x / l, z: v.z / l } : { x: 0, z: 0 };
}
