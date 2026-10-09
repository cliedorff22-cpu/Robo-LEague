// condition.js - what a damaged robot can actually still do.
//
// Every part carries a persistent condition from 1.0 (factory fresh) to 0.0
// (destroyed), and it survives the match (see build.js `condition`, keyed by
// FITTING so twin panels degrade independently). This file is the other half of
// that: it turns those numbers back into drive torque, grip, top speed, armour
// and weapon output.
//
// Without this, damage is just a number going down. With it, losing your
// weapon motor means your spinner never spools, and losing wheels means you
// get shoved around. That feedback loop is the point of the whole stage.
//
// Pure logic: no physics, no rendering. Degradation floors all come from
// rules.json, never from code.

export const STATUS = {
  OK: "ok",
  IMPAIRED: "impaired",
  CRITICAL: "critical",
  FAILED: "failed",
};

/** Which band a condition value falls into. */
export function partStatus(condition, thresholds) {
  if (condition <= thresholds.failed) return STATUS.FAILED;
  if (condition < thresholds.critical) return STATUS.CRITICAL;
  if (condition < thresholds.impaired) return STATUS.IMPAIRED;
  return STATUS.OK;
}

/** Linear fade from a floor at zero condition up to full at 1.0. */
const degrade = (condition, floor) => floor + (1 - floor) * clamp01(condition);

/**
 * Effective stats for a robot in its current condition.
 *
 * Returns a NEW object; `assembled.stats` stays the pristine rated figures, so
 * the workshop can always show "rated vs. right now". The simulation reads
 * this every step.
 */
export function effectiveStats(assembled, rules) {
  const d = rules.damage;
  const th = d.thresholds;
  const c = assembled.condition;
  const base = assembled.stats;

  const cond = (key) => (c[key] === undefined ? 1 : clamp01(c[key]));

  const wheelC = cond("wheel");
  const motorC = cond("motor");
  const driveC = cond("drive");
  const battC = cond("battery");
  const elecC = cond("electronics");
  const chassisC = cond("chassis");
  const weaponC = assembled.parts.weapon ? cond("weapon") : 0;
  const wmotorC = assembled.parts.weaponMotor ? cond("weaponMotor") : 0;

  // --- drivetrain
  const motorFactor = degrade(motorC, d.degrade.motorTorque);
  const driveFactor = degrade(driveC, d.degrade.driveTorque);
  const battFactor = degrade(battC, d.degrade.batteryPower);

  // Wheels are a SET, so condition thins the set out. Rounding up means you
  // keep a wheel until the set is genuinely finished - losing two at 60% would
  // be brutal and would read as a bug.
  const wheelsRemaining = Math.ceil(wheelC * base.wheelCount);
  const drivenRemaining = Math.min(base.drivenWheels, wheelsRemaining);

  const gripFactor = degrade(wheelC, d.degrade.wheelGrip);
  const forcePerWheelN = base.forcePerWheelN * motorFactor * driveFactor * battFactor;

  // Top speed is voltage-limited, so only the battery drags it down.
  const topSpeedMps = base.topSpeedMps * battFactor;

  // --- armour, per fitting, so a hole in one panel does not protect anything
  const armorRemainingHp = {};
  let armorHp = 0;
  for (const f of assembled.fittings) {
    if (f.part.category !== "armor") continue;
    const hp = f.part.hp * degrade(cond(f.key), d.degrade.armorProtection);
    armorRemainingHp[f.key] = hp;
    armorHp += hp;
  }

  // --- weapon. A bent rotor stores less; a dead weapon motor never spins it.
  const w = base.weapon;
  const weaponEnergyJ = w.energyJ * degrade(weaponC, d.degrade.weaponOutput);
  const weaponMotorPowerW = (w.motorPowerW || 0) * degrade(wmotorC, d.degrade.motorTorque);
  const weaponDead =
    !assembled.parts.weapon ||
    weaponC <= th.failed ||
    (w.powered && wmotorC <= th.failed);
  const spinUpS = weaponMotorPowerW > 0 ? weaponEnergyJ / weaponMotorPowerW : Infinity;

  // --- electronics. A dying radio stutters before it quits.
  const controlReliability = clamp01(elecC);
  const dropoutHz = d.electronicsDropoutHz * (1 - controlReliability);

  // --- is this bot still a going concern?
  const chassisGone = d.chassisKillsBot && chassisC <= th.failed;
  const electronicsGone = elecC <= th.failed;
  const noWheels = wheelsRemaining <= 0;
  const immobile = chassisGone || electronicsGone || noWheels;

  return {
    ...base,

    forcePerWheelN,
    tractiveForceN: forcePerWheelN * drivenRemaining,
    topSpeedMps,
    grip: base.grip * gripFactor,
    gripLimitN: base.gripLimitN * gripFactor,
    wheelCount: wheelsRemaining,
    drivenWheels: drivenRemaining,
    wheelsLost: base.wheelCount - wheelsRemaining,
    accelMps2: Math.min(forcePerWheelN * drivenRemaining, base.gripLimitN * gripFactor) / assembled.massKg,

    armorHp,
    armorRemainingHp,

    weapon: {
      ...w,
      energyJ: weaponDead ? 0 : weaponEnergyJ,
      motorPowerW: weaponMotorPowerW,
      spinUpS,
      dead: weaponDead,
    },

    controlReliability,
    dropoutHz,
    dropoutS: d.electronicsDropoutS,

    immobile,
    chassisGone,
    electronicsGone,

    // Pivot authority has to be recomputed: fewer driven wheels and less grip
    // move both sides of that balance.
    pivotAuthority: computePivotAuthority(assembled, forcePerWheelN, drivenRemaining, gripFactor),
  };
}

function computePivotAuthority(assembled, forcePerWheelN, drivenWheels, gripFactor) {
  const s = assembled.stats;
  const drive = drivenWheels * forcePerWheelN * s.trackHalfM;
  const resist = s.grip * gripFactor * s.lateralGripFraction * assembled.massKg * 9.81 * s.wheelbaseHalfM;
  return resist > 0 ? drive / resist : Infinity;
}

/**
 * Per-fitting condition report - what the pit screen in Stage 7 will show, and
 * what the HUD damage panel reads from.
 */
export function conditionReport(assembled, rules) {
  const th = rules.damage.thresholds;
  return assembled.fittings.map((f) => {
    const condition = assembled.condition[f.key] ?? 1;
    return {
      key: f.key,
      partId: f.part.id,
      name: f.part.name,
      category: f.part.category,
      condition,
      status: partStatus(condition, th),
      hpRemaining: f.part.hp * condition,
      hpFull: f.part.hp,
      // Stage 7 spends these.
      repairCost: Math.round(f.part.hp * (1 - condition) * f.part.repairCostPerHp),
      repairMinutes: Math.round(f.part.hp * (1 - condition) * f.part.repairMinPerHp),
    };
  });
}

/** Worst-affected fittings first - for a damage report that leads with the news. */
export function worstFirst(report) {
  return report.slice().sort((a, b) => a.condition - b.condition);
}

/** Total value of the damage on a robot, in repair currency. */
export function repairBill(report) {
  return report.reduce((sum, r) => sum + r.repairCost, 0);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
