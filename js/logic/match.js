// match.js - the match state machine: clock, referee count, pinning rule,
// tap-outs and the result.
//
// Pure logic, advanced by a dt the caller supplies. It never reads the physics
// world: the referee (js/sim/referee.js) pushes facts in each step, so this
// whole file is testable headlessly and is what Stage 5's season simulation
// will run a few hundred times.
//
// A match ends one of three ways, as on the show:
//   KO        a robot cannot drive under its own power for the count
//   tap-out   a team concedes
//   decision  time runs out and three judges score it (js/logic/judging.js)

import { EV } from "../core/bus.js";
import { makeScorebook } from "./judging.js";

export const PHASE = {
  IDLE: "idle",
  COUNTDOWN: "countdown",
  LIVE: "live",
  PAUSED: "paused",
  ENDED: "ended",
};

export const METHOD = { KO: "ko", TAPOUT: "tapout", DECISION: "decision" };

// Accumulating a float dt for ten seconds lands a hair under the boundary
// (100 additions of 0.1 sum to 9.999999999999998). A referee count should not
// hinge on that, so compare with a slack of one microsecond.
const TIME_EPS = 1e-6;

/** Referee config; rules.json `match` overrides any of it. */
function refConfig(rules) {
  const m = rules.match || {};
  return {
    durationS: m.durationS ?? 180,
    countdownS: m.countdownS ?? 3,
    countS: m.immobilizationCountS ?? 10,
    // How long a robot has to look stuck before the count STARTS. A bot
    // bounced into the air by a hit is briefly wheels-up; that is not a KO.
    countGraceS: m.countGraceS ?? 1.0,
    // Showing controlled movement for this long stops the count.
    recoverS: m.recoverS ?? 0.4,
    pinLimitS: m.pinLimitS ?? 10,
    pinReleaseS: m.pinReleaseS ?? 3,
    tapOutAllowed: m.tapOutAllowed !== false,
    separateAfterS: m.separateAfterS ?? 6,
  };
}

export function makeMatch(rules, bus, { botIds = [], seed = 1 } = {}) {
  const cfg = refConfig(rules);
  const scorebook = makeScorebook(rules, botIds.slice(0, 2));

  const state = {
    phase: PHASE.IDLE,
    clockS: cfg.durationS,
    countdownS: cfg.countdownS,
    elapsedS: 0,
    result: null,
    bots: new Map(),
    pin: null,            // { pinnerId, pinnedId, heldS, warned, sinceWarnS }
  };

  const freshBot = (id) => ({
    id,
    // The referee count. `stuckS` is how long it has looked stuck; the count
    // proper is stuckS minus the grace.
    stuckS: 0,
    countS: 0,
    lastAnnounced: 0,
    recoverS: 0,
    countedOut: false,
    tappedOut: false,
  });
  for (const id of botIds) state.bots.set(id, freshBot(id));

  const other = (id) => botIds.find((b) => b !== id);

  const emitState = () => bus?.emit(EV.MATCH_STATE, {
    phase: state.phase,
    clockS: state.clockS,
    countdownS: state.countdownS,
  });

  function end(result) {
    if (state.phase === PHASE.ENDED) return;
    state.phase = PHASE.ENDED;
    state.result = { ...result, elapsedS: state.elapsedS, clockS: state.clockS, tally: scorebook.raw() };
    bus?.emit(EV.MATCH_END, state.result);
    emitState();
  }

  function decide() {
    const j = scorebook.judge(seed);
    end({
      method: METHOD.DECISION, reason: "time",
      winnerId: j.winnerId, loserId: j.loserId,
      decision: j.decision, cards: j.cards, votes: j.votes,
    });
  }

  return {
    get phase() { return state.phase; },
    get clockS() { return state.clockS; },
    get countdownS() { return state.countdownS; },
    get elapsedS() { return state.elapsedS; },
    get result() { return state.result; },
    get pin() { return state.pin; },
    get config() { return cfg; },
    scorebook,
    bot: (id) => state.bots.get(id),
    bots: () => [...state.bots.values()],

    /** @param opts.countdown false to go straight to live (headless bouts). */
    start({ countdown = true } = {}) {
      state.phase = countdown ? PHASE.COUNTDOWN : PHASE.LIVE;
      state.clockS = cfg.durationS;
      state.countdownS = countdown ? cfg.countdownS : 0;
      state.elapsedS = 0;
      state.result = null;
      state.pin = null;
      for (const id of botIds) state.bots.set(id, freshBot(id));
      scorebook.reset();
      emitState();
    },

    togglePause() {
      if (state.phase === PHASE.LIVE) state.phase = PHASE.PAUSED;
      else if (state.phase === PHASE.PAUSED) state.phase = PHASE.LIVE;
      else return;
      emitState();
    },

    /**
     * The referee's read on one robot this step.
     * @param m.able     it physically CAN drive: upright, wheels on the floor,
     *                   drive and electronics alive
     * @param m.trying   its driver is asking it to move
     * @param m.moving   it is translating or turning
     * @param m.pinned   held down by the opponent - no count while pinned
     * @param m.engaged  in contact with the opponent: a shoving match is a
     *                   fight, not a robot that cannot move
     *
     * The count runs when a robot cannot drive, or is trying and getting
     * nowhere. A robot sitting still by its driver's choice is NOT counted -
     * a spinner parked while its rotor spools is fine; the judges' aggression
     * score is what punishes waiting around.
     */
    reportMobility(botId, m, dt) {
      const b = state.bots.get(botId);
      if (!b || state.phase !== PHASE.LIVE || b.countedOut) return;
      // Some things need no count - down the pit is out.
      if (m.out) {
        b.cause = m.cause ?? "pitted";
        b.countedOut = true;
        bus?.emit(EV.KO, { botId });
        end({ method: METHOD.KO, reason: "ko", cause: b.cause, winnerId: other(botId), loserId: botId });
        return;
      }
      const stuck = !m.pinned && (!m.able || (m.trying && !m.moving && !m.engaged));
      if (stuck) b.cause = m.able ? "stuck" : (m.cause ?? "disabled");
      const showingMovement = m.able && m.moving;

      if (stuck) {
        b.stuckS += dt;
        b.recoverS = 0;
      } else if (showingMovement || !m.trying) {
        // Controlled movement - or simply not trying while able - ends a count,
        // after a beat so a single twitch does not.
        b.recoverS += dt;
        if (b.recoverS >= cfg.recoverS || b.countS === 0) { b.stuckS = 0; b.countS = 0; b.lastAnnounced = 0; }
      }
      b.countS = Math.max(0, b.stuckS - cfg.countGraceS);

      const n = Math.floor(b.countS + TIME_EPS);
      if (n > b.lastAnnounced) {
        b.lastAnnounced = n;
        bus?.emit(EV.REF_COUNT, { botId, count: n, of: cfg.countS });
      }
      if (b.countS >= cfg.countS - TIME_EPS) {
        b.countedOut = true;
        bus?.emit(EV.KO, { botId });
        end({ method: METHOD.KO, reason: "ko", cause: b.cause ?? "disabled", winnerId: other(botId), loserId: botId });
      }
    },

    /**
     * Who, if anyone, is pinning whom this step. After `pinLimitS` the pinner
     * is told to release; if it is still holding `pinReleaseS` later it loses
     * control points, and is told again.
     */
    reportPin(pinnerId, pinnedId, dt) {
      if (state.phase !== PHASE.LIVE) return;
      if (!pinnerId) { state.pin = null; return; }
      const p = state.pin;
      if (!p || p.pinnerId !== pinnerId || p.pinnedId !== pinnedId) {
        state.pin = { pinnerId, pinnedId, heldS: 0, warned: false, sinceWarnS: 0 };
        return;
      }
      p.heldS += dt;
      if (!p.warned && p.heldS >= cfg.pinLimitS) {
        p.warned = true; p.sinceWarnS = 0;
        bus?.emit(EV.PIN_WARNING, { botId: pinnerId, pinnedId });
      } else if (p.warned) {
        p.sinceWarnS += dt;
        if (p.sinceWarnS >= cfg.pinReleaseS) {
          scorebook.recordPinPenalty(pinnerId);
          bus?.emit(EV.PIN_PENALTY, { botId: pinnerId, pinnedId });
          p.sinceWarnS = 0;
        }
      }
    },

    /** A team concedes. */
    tapOut(botId) {
      if (!cfg.tapOutAllowed || state.phase !== PHASE.LIVE) return false;
      const b = state.bots.get(botId);
      if (!b) return false;
      b.tappedOut = true;
      bus?.emit(EV.TAP_OUT, { botId });
      end({ method: METHOD.TAPOUT, reason: "tapout", winnerId: other(botId), loserId: botId });
      return true;
    },

    /** Advance the clock. Returns the phase after the step. */
    update(dt) {
      if (state.phase === PHASE.COUNTDOWN) {
        state.countdownS -= dt;
        if (state.countdownS <= 0) {
          state.countdownS = 0;
          state.phase = PHASE.LIVE;
        }
        emitState();
        return state.phase;
      }

      if (state.phase !== PHASE.LIVE) return state.phase;

      state.clockS -= dt;
      state.elapsedS += dt;
      if (state.clockS <= TIME_EPS) {
        state.clockS = 0;
        decide();
        return state.phase;
      }
      emitState();
      return state.phase;
    },
  };
}
