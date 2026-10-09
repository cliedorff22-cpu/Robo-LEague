// weapon.js - weapon state over time.
//
// Pure logic, advanced by a dt. Covers the three families the archetypes need:
//
//   kinetic  (spinner_h, spinner_v, drum)  - stores energy in a rotor, spools
//            up over seconds, and LOSES that energy when it lands a hit
//   discrete (hammer, flipper, lifter)     - a fixed strike per cycle, with a
//            reload, and in the flipper's case a limited number of charges
//   crusher                                - closes a jaw and applies damage
//            while held, rather than throwing energy
//
// The thing that matters most for feel: a kinetic weapon's stored energy is
// real. Spool a bar to 15 kJ, land a hit, and you are down to a few kJ and
// need another eight seconds. That is why real spinner drivers circle.

export const PHASE = {
  IDLE: "idle",
  SPOOLING: "spooling",
  READY: "ready",
  STRIKING: "striking",
  RELOADING: "reloading",
  CLOSED: "closed",
  DEAD: "dead",
};

export const FAMILY = {
  KINETIC: "kinetic",
  DISCRETE: "discrete",
  CRUSHER: "crusher",
  NONE: "none",
};

export function familyOf(weaponClass) {
  if (["spinner_h", "spinner_v", "drum"].includes(weaponClass)) return FAMILY.KINETIC;
  if (["hammer", "flipper", "lifter"].includes(weaponClass)) return FAMILY.DISCRETE;
  if (weaponClass === "crusher") return FAMILY.CRUSHER;
  return FAMILY.NONE;
}

/**
 * @param {object} assembled  the robot (read for its weapon spec)
 * @param {object} rules
 */
export function makeWeapon(assembled, rules) {
  const spec = assembled.parts.weapon ? assembled.parts.weapon.spec : null;
  const family = familyOf(assembled.stats.weapon.class);

  const state = {
    phase: family === FAMILY.NONE ? PHASE.IDLE : PHASE.IDLE,
    energyJ: 0,          // kinetic: energy stored right now
    omegaRadS: 0,        // kinetic: implied rotor speed
    chargesLeft: assembled.stats.weapon.charges ?? Infinity,
    timerS: 0,           // time in the current phase
    sinceBiteS: 0,       // crusher: time since it last bit
    spinPct: 0,          // 0..1 of full energy, for the HUD
    struckThisStep: false,
    // Discrete: a swing started by the trigger that has not connected yet.
    unspent: false,
  };

  /** Rotor speed implied by stored energy: omega = sqrt(2E/I). */
  function omegaFor(energyJ, inertia) {
    return inertia > 0 ? Math.sqrt(Math.max(0, 2 * energyJ) / inertia) : 0;
  }

  return {
    get phase() { return state.phase; },
    get family() { return family; },
    get energyJ() { return state.energyJ; },
    get omegaRadS() { return state.omegaRadS; },
    get spinPct() { return state.spinPct; },
    get chargesLeft() { return state.chargesLeft; },
    get ready() { return state.phase === PHASE.READY || state.phase === PHASE.CLOSED; },
    /**
     * Would a contact with the weapon right now be a weapon hit? combat.js asks
     * this. It used to test `energyJ > 0`, which a hammer or flipper only has
     * mid-swing - and the only thing that started a swing was a weapon hit. So
     * no discrete weapon could ever land anything.
     */
    get armed() {
      if (family === FAMILY.DISCRETE) {
        return state.phase === PHASE.STRIKING ? state.unspent : state.energyJ > 0;
      }
      return state.energyJ > 0;
    },
    state,

    /**
     * Advance the weapon.
     * @param {number} dt
     * @param {object} ctx { demand: 0..1, effective: effectiveStats(...) }
     */
    update(dt, { demand = 0, effective }) {
      const ew = effective.weapon;
      state.struckThisStep = false;

      if (family === FAMILY.NONE) { state.phase = PHASE.IDLE; return; }

      if (ew.dead) {
        // Dead weapon: bleed off whatever is still spinning and stay dead.
        state.phase = PHASE.DEAD;
        state.energyJ = Math.max(0, state.energyJ - state.energyJ * dt);
        state.omegaRadS = omegaFor(state.energyJ, ew.rotorInertiaKgM2);
        state.spinPct = 0;
        return;
      }

      if (family === FAMILY.KINETIC) {
        const maxE = ew.energyJ;
        const spinUp = Math.max(0.0001, ew.spinUpS);
        const spinDown = Math.max(0.0001, ew.spinDownS || spinUp * 2.2);
        const d = clamp01(demand);

        // Under power the motor overcomes bearing and air drag, so spin-up
        // takes exactly the derived spinUpS - the number the HUD and the
        // workshop quote. Drag only bites as you ease off, giving an
        // exponential coast-down. An earlier version applied drag at all times,
        // which quietly made every weapon ~80% slower to spool than advertised.
        const powerInW = (maxE / spinUp) * d;
        const dragW = (state.energyJ / spinDown) * (1 - d);

        state.energyJ = clamp(state.energyJ + (powerInW - dragW) * dt, 0, maxE);
        state.omegaRadS = omegaFor(state.energyJ, ew.rotorInertiaKgM2);
        state.spinPct = maxE > 0 ? state.energyJ / maxE : 0;
        state.phase = state.spinPct > 0.98 ? PHASE.READY
                    : state.spinPct > 0.02 ? PHASE.SPOOLING
                    : PHASE.IDLE;
        return;
      }

      if (family === FAMILY.DISCRETE) {
        state.timerS += dt;
        const swingS = spec.swingS ?? spec.fireS ?? 0.2;
        const cycleS = spec.cycleS ?? 2;

        // The trigger fires the weapon whether or not anything is there - a
        // whiffed hammer costs its reload just like a real one. A contact
        // during the swing then lands it, once (see strike()).
        if (demand > 0.5 && state.phase === PHASE.READY && state.chargesLeft > 0) {
          state.phase = PHASE.STRIKING;
          state.timerS = 0;
          state.unspent = true;
          if (state.chargesLeft !== Infinity) state.chargesLeft--;
        }

        if (state.phase === PHASE.STRIKING && state.timerS >= swingS) {
          state.phase = PHASE.RELOADING; state.timerS = 0;
        } else if (state.phase === PHASE.RELOADING && state.timerS >= cycleS) {
          state.phase = PHASE.READY; state.timerS = 0;
        } else if (state.phase === PHASE.IDLE) {
          state.phase = PHASE.READY;
        }

        if (state.chargesLeft <= 0) state.phase = PHASE.DEAD;
        state.energyJ = state.phase === PHASE.STRIKING ? ew.energyJ : 0;
        state.spinPct = state.phase === PHASE.READY ? 1
                      : state.phase === PHASE.RELOADING ? clamp01(state.timerS / cycleS) : 0;
        return;
      }

      if (family === FAMILY.CRUSHER) {
        state.timerS += dt;
        state.sinceBiteS += dt;
        const closeS = spec.closeS ?? 1;
        const cycleS = spec.cycleS ?? 3;
        const holding = demand > 0.5;

        if (holding && state.phase !== PHASE.CLOSED && state.phase !== PHASE.RELOADING) {
          if (state.phase !== PHASE.STRIKING) { state.phase = PHASE.STRIKING; state.timerS = 0; }
          else if (state.timerS >= closeS) { state.phase = PHASE.CLOSED; state.timerS = 0; }
        } else if (state.phase === PHASE.CLOSED && !holding) {
          state.phase = PHASE.RELOADING; state.timerS = 0;
        } else if (state.phase === PHASE.RELOADING && state.timerS >= cycleS) {
          state.phase = PHASE.READY; state.timerS = 0;
        } else if (state.phase === PHASE.IDLE) {
          state.phase = PHASE.READY;
        }

        // A closed jaw keeps working, so it delivers energy per second held.
        state.energyJ = state.phase === PHASE.CLOSED ? ew.energyJ : 0;
        state.spinPct = state.phase === PHASE.CLOSED ? 1 : clamp01(state.timerS / closeS);
        return;
      }
    },

    /**
     * Try to land a hit. Returns the energy available for `resolveHit`, or 0.
     *
     * For a kinetic weapon this does NOT consume anything yet - the rotor loses
     * energy in `absorbRecoil` once the hit is resolved and we know how much
     * actually went in. For discrete weapons it starts the swing and burns a
     * charge.
     */
    strike(effective) {
      const ew = effective.weapon;
      if (ew.dead) return 0;

      if (family === FAMILY.KINETIC) {
        return state.energyJ;
      }
      if (family === FAMILY.DISCRETE) {
        // A triggered swing connecting.
        if (state.phase === PHASE.STRIKING && state.unspent) {
          state.unspent = false;
          state.struckThisStep = true;
          return ew.energyJ;
        }
        // Contact with a cocked weapon fires it on the spot.
        if (state.phase !== PHASE.READY || state.chargesLeft <= 0) return 0;
        state.unspent = false;
        state.phase = PHASE.STRIKING;
        state.timerS = 0;
        state.struckThisStep = true;
        if (state.chargesLeft !== Infinity) state.chargesLeft--;
        return ew.energyJ;
      }
      if (family === FAMILY.CRUSHER) {
        // A closed jaw keeps working, but it bites at a rate - otherwise the
        // simulation would ask 120 times a second and shred anything instantly.
        if (state.phase !== PHASE.CLOSED) return 0;
        const interval = ew.biteIntervalS ?? 0.7;
        if (state.sinceBiteS < interval) return 0;
        state.sinceBiteS = 0;
        state.struckThisStep = true;
        return ew.energyJ;
      }
      return 0;
    },

    /**
     * Energy leaves the rotor when it lands. This is what makes a spinner
     * driver pick their moments: a big hit costs you your spin-up.
     */
    absorbRecoil(deliveredJ) {
      if (family !== FAMILY.KINETIC) return;
      state.energyJ = Math.max(0, state.energyJ - deliveredJ);
      state.spinPct = 0;
      state.struckThisStep = true;
    },

    /** Called between matches - the rotor is not still spinning in the pit. */
    reset() {
      state.phase = PHASE.IDLE;
      state.energyJ = 0;
      state.omegaRadS = 0;
      state.timerS = 0;
      state.sinceBiteS = 0;
      state.spinPct = 0;
      state.unspent = false;
      state.chargesLeft = assembled.stats.weapon.charges ?? Infinity;
    },
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
