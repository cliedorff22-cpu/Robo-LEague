// commentary.js - two commentators call the fight.
//
// Pure: facts in (the bus's events, the clock, the story so far), lines out.
// The play-by-play voice ("pbp") calls what happens; the colour voice
// ("color") says what it means. Who speaks them, and whether they appear as
// captions, is js/render/commentary_view.js and the audio layer.
//
// Every line carries a priority (0 chatter .. 3 must-say) so the booth never
// talks over a knockout with a remark about the weather, and `hazard: true`
// on anything about the arena's hazards - those are spoken, never captioned
// (the user does not want hazard words on screen).

const PICK_MEMORY = 6;    // don't repeat any of the last few lines of a kind

/**
 * @param opts.names     { botId: name }
 * @param opts.corners   { botId: "red" | "blue" }
 * @param opts.weapons   { botId: weapon description, e.g. "vertical disc" }
 * @param opts.story     the career's story so far (career_ui.js storyOf), or null
 * @param opts.playerId  the player's bot (the red corner's main unit) - the story is from their side
 * @param opts.where     { venue, layout } names
 * @param opts.rng       a seeded rng ({ next() })
 * @param opts.durationS the match length
 */
export function makeCommentary({ names = {}, corners = {}, weapons = {}, story = null, playerId = null, where = null, rng, durationS = 180 } = {}) {
  const recent = new Map();      // template set -> recent picks
  const nm = (id) => names[id] || "the robot";
  const other = (id) => Object.keys(names).find((x) => x !== id && corners[x] && corners[x] !== corners[id]) || null;
  const damage = {};             // botId -> damage taken, as the booth has seen it
  let sinceAction = 0, lastBigHitT = -99, calledClock = new Set(), counting = new Set(), firstBlood = false;
  let liveT = 0, lullsSaid = 0;

  function pick(set, list) {
    const seen = recent.get(set) || [];
    const fresh = list.filter((x) => !seen.includes(x));
    const pool = fresh.length ? fresh : list;
    const t = pool[Math.floor(rng.next() * pool.length)];
    seen.push(t);
    if (seen.length > Math.min(PICK_MEMORY, list.length - 1)) seen.shift();
    recent.set(set, seen);
    return t;
  }
  const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
  const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const line = (who, set, list, vars = {}, pri = 1, extra = {}) => ({ who, text: capFirst(fill(pick(set, list), vars)), pri, ...extra });

  // ---------------------------------------------------------------- before the bell
  function intro() {
    const ids = Object.keys(corners);
    const red = ids.find((x) => corners[x] === "red"), blue = ids.find((x) => corners[x] === "blue");
    const out = [];
    out.push(line("pbp", "welcome", [
      "Welcome to {venue}! In the red square, {red}. In the blue square, {blue}.",
      "Live from {venue}! {red} in red, {blue} in blue - and this one should be good.",
      "Good evening from {venue}. It's {red} against {blue}.",
    ], { venue: where?.venue || "the box", red: nm(red), blue: nm(blue) }, 2));
    if (weapons[red] && weapons[blue]) {
      out.push(line("color", "matchup", weapons[red] === weapons[blue] ? [
        "Two {w}s. Somebody's leaving in pieces.",
        "{w} against {w}. Whoever spins up first wins this.",
      ] : [
        "{rw} against {bw}. That's a fascinating matchup.",
        "The {rw} of {red} against the {bw} of {blue}. Watch the first exchange.",
        "Can the {bw} handle that {rw}? We're about to find out.",
      ], { w: weapons[red], rw: weapons[red], bw: weapons[blue], red: nm(red), blue: nm(blue) }, 1));
    }
    if (story) {
      if (story.grudge) out.push({ who: "color", text: story.asked === "them" ? `This is a grudge match - ${nm(blue)} called them out, and there is no love lost.` : `A grudge match! ${nm(red)} asked for this one.`, pri: 2 });
      else if (story.level >= 3) out.push({ who: "color", text: `${nm(blue)} is ${nm(red)}'s nemesis. The crowd knows it.`, pri: 2 });
      else if (story.level >= 1) out.push({ who: "color", text: `These two have history - the fans are calling it a rivalry.`, pri: 2 });
      if (story.series && story.series.fights) {
        const { w, l } = story.series;
        out.push({ who: "pbp", text: w === l ? `The series is level at ${w} apiece.` : w > l ? `${nm(red)} leads the series ${w} to ${l}.` : `${nm(blue)} leads the series ${l} to ${w}.`, pri: 1 });
      }
      if (story.last && !story.last.won) out.push({ who: "color", text: `${nm(blue)} won the last one${story.last.method === "ko" ? " by knockout" : ""}. ${nm(red)} wants revenge.`, pri: 1 });
    }
    return out;
  }

  // ---------------------------------------------------------------- the fight
  const SEV = { scratch: 0, glance: 1, hit: 2, heavy: 3, catastrophic: 4 };

  function hit(e, t) {
    const sev = SEV[e.severity] ?? 1;
    counting.clear();          // a count that is still running would have ended in a KO
    const a = nm(e.attackerId), d = nm(e.defenderId);
    damage[e.defenderId] = (damage[e.defenderId] || 0) + (e.deliveredJ || 0);
    const out = [];
    if (e.kind === "hazard") {
      // Spoken only - never a caption.
      if (sev < 2) return out;
      const H = {
        pulverizer: ["The hammer comes down on {d}!", "Pulverized! {d} takes the hammer!", "Right under the hammer - ouch!"],
        screw: ["The screws grab {d}!", "{d} is chewed up by the screws!"],
        killsaw: ["Up come the saws under {d}!", "Killsaws! {d} gets launched!"],
      }[e.hazardType] || ["{d} finds a hazard!"];
      out.push(line("pbp", `haz:${e.hazardType}`, H, { d }, sev >= 3 ? 2 : 1, { hazard: true }));
      sinceAction = 0;
      return out;
    }
    if (sev < 2) return out;
    sinceAction = 0;
    if (!firstBlood && sev >= 2 && e.kind === "weapon") {
      firstBlood = true;
      out.push(line("pbp", "first", ["First real contact goes to {a}!", "{a} draws first blood!", "And {a} lands the first big one!"], { a, d }, 2));
      return out;
    }
    if (e.kind === "ram") {
      if (sev < 3) return out;
      out.push(line("pbp", "ram", ["{a} slams into {d}!", "Big shove from {a}!", "{a} drives {d} across the box!", "{a} bulldozes straight through {d}!"], { a, d }, 1));
      return out;
    }
    if (sev >= 4) {
      out.push(line("pbp", "huge", ["OH! What a hit from {a}!", "MASSIVE hit! {d} goes flying!", "{a} absolutely destroys {d} with that one!", "Did you SEE that?! {a} nearly cut {d} in half!"], { a, d }, 3));
      lastBigHitT = t;
      if (rng.next() < 0.7) out.push(line("color", "hugeC", ["You can't take many of those.", "That's going to be an expensive night in the pit.", "The whole building felt that one.", "That's what that weapon was built for."], { a, d }, 1));
    } else if (sev >= 3) {
      out.push(line("pbp", "heavy", ["Big hit from {a}!", "{a} connects - hard!", "Huge shot on {d}!", "{a} finds the mark!", "Clean hit on {d}!"], { a, d }, 2));
      lastBigHitT = t;
    } else if (rng.next() < 0.35) {
      out.push(line("pbp", "hit", ["{a} gets a piece of {d}.", "Contact from {a}.", "{a} chips away at {d}.", "Good bite from {a}."], { a, d }, 0));
    }
    // Who is winning the damage war.
    const gap = (damage[e.defenderId] || 0) - (damage[e.attackerId] || 0);
    if (sev >= 3 && gap > 30000 && rng.next() < 0.4) {
      out.push(line("color", "beating", ["{d} is taking a real beating.", "This is getting one-sided.", "{d} needs something to happen, and fast."], { d }, 1));
    }
    return out;
  }

  function failed(e) {
    const d = nm(e.botId);
    const L = {
      armor: ["There goes a chunk of {d}'s armour!", "Armour off {d}! That panel is in the stands!", "{d} is shedding parts!"],
      chassis: ["{d}'s frame is buckled!", "That's cracked {d}'s chassis!"],
      weapon: ["{d}'s weapon is gone!", "The weapon's dead on {d}!", "{d} has lost its weapon - it's a pusher now!"],
      weaponMotor: ["{d}'s weapon is slowing down - that motor's hurt!", "No more spin from {d}!"],
      wheel: ["{d} has lost a wheel!", "Wheel off! {d} is limping!"],
      drive: ["{d}'s drive is failing!", "{d} is limping now - that's the drivetrain!"],
      motor: ["{d}'s drive motor is smoking!", "Smoke from {d}! That's a motor gone!"],
      battery: ["{d} is on fire! That's the battery!", "Fire! {d}'s battery has gone up!"],
      electronics: ["{d} is twitching - the electronics are fried!", "Sparks from inside {d}!"],
    }[e.category];
    if (!L) return [];
    sinceAction = 0;
    return [line("pbp", `fail:${e.category}`, L, { d }, e.category === "battery" || e.category === "weapon" ? 3 : 2)];
  }

  function count(e) {
    const d = nm(e.botId);
    sinceAction = 0;
    if (e.count === 1) {
      counting.add(e.botId);
      return [line("pbp", "count", ["{d} isn't moving! The referee is counting!", "Is {d} stuck? Here comes the count!", "{d} is in trouble - the count is on!"], { d }, 3)];
    }
    if (e.count === e.of - 3) return [line("color", "countLate", ["{d} has to move, NOW!", "Come on {d}, wiggle out of it!"], { d }, 2)];
    return [];
  }

  /** The story, finished: who won the series, revenge, a streak. */
  function storyEnd(winnerId) {
    if (!story || !playerId) return [];
    const won = winnerId === playerId;
    const s = story.series || { w: 0, l: 0 };
    const w = s.w + (won ? 1 : 0), l = s.l + (won ? 0 : 1);
    const me = nm(playerId), them = nm(other(playerId));
    const out = [];
    if (story.last && !story.last.won && won) out.push({ who: "color", text: `Revenge for ${me}!`, pri: 2 });
    if (story.grudge) out.push({ who: "color", text: won ? `${me} settles the grudge.` : `${them} wins the grudge match. That'll sting.`, pri: 1 });
    if (s.fights) out.push({ who: "pbp", text: w === l ? `That levels the series at ${w} apiece.` : w > l ? `${me} goes up ${w} to ${l} in the series.` : `${them} goes up ${l} to ${w} in the series.`, pri: 1 });
    return out;
  }

  function end(r) {
    const W = nm(r.winnerId), L = nm(r.loserId);
    const out = [];
    if (r.method === "ko") {
      out.push(line("pbp", "ko", ["It's over! {l} is knocked out! {w} wins!", "KNOCKOUT! {w} takes it!", "{l} is done! The winner, by knockout, {w}!"], { w: W, l: L }, 3));
    } else if (r.method === "tapout") {
      out.push(line("pbp", "tap", ["{l} taps out! {w} wins!", "And that's the towel - {l} taps out!"], { w: W, l: L }, 3));
    } else {
      out.push(line("pbp", "bell", ["That's the bell! We go to the judges.", "Time! This one goes to the judges."], {}, 3));
      const how = r.decision === "split" ? "On a split decision" : r.decision === "unanimous" ? "By unanimous decision" : "On the judges' cards";
      out.push({ who: "pbp", text: `${how}... ${W}!`, pri: 3 });
      if (r.decision === "split") out.push(line("color", "split", ["That could have gone either way.", "{l}'s team won't like that one.", "Close. Very close."], { l: L }, 1));
    }
    out.push(...storyEnd(r.winnerId));
    return out;
  }

  return {
    intro,

    /**
     * One bus event. `t` is match time in seconds (since the bell).
     * @returns [{ who, text, pri, hazard? }]
     */
    event(type, e, t = 0) {
      switch (type) {
        case "countdown": return [line("pbp", "ready", ["Robots ready...", "Drivers ready...", "Here we go..."], {}, 3)];
        case "live": liveT = t; return [line("pbp", "fight", ["FIGHT!", "Activate! FIGHT!", "And they're off!"], {}, 3)];
        case "hit": return hit(e, t);
        case "failed": return failed(e);
        case "count": return count(e);
        case "recovered": counting.delete(e.botId); return [line("color", "free", ["{d} gets free!", "And {d} is moving again!"], { d: nm(e.botId) }, 2)];
        case "pin": return [line("pbp", "pin", ["{a} has {d} pinned - the referee wants a release!", "{a} needs to let go!"], { a: nm(e.botId), d: nm(e.pinnedId) }, 2)];
        case "separate": return [line("color", "sep", ["They're locked together. The referee pulls them apart.", "Tangled up - and separated."], {}, 1)];
        case "hazard": {
          if (e.type === "pit") return [line("pbp", "pitopen", ["The pit is open!", "Down goes the floor - the pit is open!"], {}, 2, { hazard: true })];
          if (e.type === "killsaw") return rng.next() < 0.25 ? [line("color", "saws", ["Watch the floor - the saws are coming up!"], {}, 0, { hazard: true })] : [];
          return [];
        }
        case "ko": return [];      // the end() line says it
        case "end": return end(e);
        default: return [];
      }
    },

    /**
     * Once per frame while the fight is live: clock calls and the chatter
     * that fills a lull.
     * @param state { clockS (remaining), live, dt }
     */
    tick({ clockS, live, dt = 0 }) {
      if (!live) return [];
      sinceAction += dt;
      const out = [];
      for (const [at, text] of [[60, "One minute left!"], [30, "Thirty seconds!"], [10, "Ten seconds to go!"]]) {
        if (at < durationS && clockS <= at && !calledClock.has(at)) { calledClock.add(at); out.push({ who: "pbp", text, pri: 2 }); }
      }
      if (sinceAction > 11 && lullsSaid < 6 && !counting.size) {
        sinceAction = 0; lullsSaid++;
        const ids = Object.keys(corners);
        const x = ids[Math.floor(rng.next() * ids.length)];
        out.push(line(rng.next() < 0.5 ? "color" : "pbp", "lull", [
          "Neither driver wants to commit.", "{x} is circling, looking for an opening.", "Cagey stuff. Somebody has to go in.",
          "The crowd wants action!", "{x} is waiting for a mistake.", "A bit of a standoff here.",
        ], { x: nm(x) }, 0));
      }
      return out;
    },

    /** Between rematches: forget the fight, keep the voice. */
    reset() { sinceAction = 0; lastBigHitT = -99; calledClock = new Set(); counting = new Set(); firstBlood = false; lullsSaid = 0; for (const k of Object.keys(damage)) delete damage[k]; },
  };
}
