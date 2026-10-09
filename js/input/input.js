// input.js - keyboard and gamepad, normalised into one DriveInput shape.
//
// Nothing downstream knows whether a human or an AI produced a DriveInput:
//   { throttle: -1..1, steer: -1..1, brake: bool, weapon: 0..1 }
// That is what makes mid-match control handoff (see pilot.js) a one-line swap.

export function makeInput(target = window) {
  const keys = new Set();
  // Edge-triggered actions, drained once per frame by the caller.
  const pressed = [];

  const onDown = (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    pressed.push(e.code);
    // Stop the browser scrolling the page out from under the canvas.
    if (SWALLOW.has(e.code)) e.preventDefault();
  };
  const onUp = (e) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", onBlur);

  const axis = (neg, pos) => (keys.has(neg) ? -1 : 0) + (keys.has(pos) ? 1 : 0);

  return {
    /** Human DriveInput for this frame. */
    read() {
      // Keyboard first.
      let throttle = axis("KeyS", "KeyW") + axis("ArrowDown", "ArrowUp");
      // The sim's steer is +1 = turn left (yaw toward -Z from +X, the way the
      // AI uses it), so left keys push it positive.
      let steer = axis("KeyD", "KeyA") + axis("ArrowRight", "ArrowLeft");
      let brake = keys.has("ShiftLeft") || keys.has("ShiftRight");
      let weapon = keys.has("Space") ? 1 : 0;

      // The phone build's on-screen stick (mobile/touch.js), when a thumb is on it.
      const t = touchDrive(0);
      if (t) { throttle = t.throttle; steer = t.steer; }

      // Gamepad overrides when a stick is actually deflected, so you can swap
      // between keyboard and pad without re-selecting anything.
      const pad = gamepads()[0];
      const p = pad && padDrive(pad);
      if (p) { throttle = p.throttle; steer = p.steer; brake = brake || p.brake; weapon = Math.max(weapon, p.weapon); }

      return {
        throttle: clamp(throttle, -1, 1),
        steer: clamp(steer, -1, 1),
        brake,
        weapon,
      };
    },

    /**
     * One player's DriveInput when two share the keyboard (Quick Fight's
     * Player 2). Player 1 (slot 0): W A S D, Space weapon, Left Shift brake.
     * Player 2 (slot 1): the arrows, Right Shift or / weapon, . or Right Alt
     * brake. Gamepads go to players in the order they were plugged in.
     */
    readPlayer(slot) {
      const k = SPLIT[slot];
      let throttle = axis(k.back, k.fwd);
      let steer = axis(k.right, k.left);
      let brake = k.brake.some((c) => keys.has(c));
      let weapon = k.weapon.some((c) => keys.has(c)) ? 1 : 0;
      const t = touchDrive(slot);
      if (t) { throttle = t.throttle; steer = t.steer; }
      const pad = gamepads()[slot];
      if (pad) {
        const p = padDrive(pad);
        if (p) { throttle = p.throttle; steer = p.steer; brake = brake || p.brake; weapon = Math.max(weapon, p.weapon); }
      }
      return { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1), brake, weapon };
    },

    /** Key codes pressed since the last call. */
    drainPressed() {
      const out = pressed.slice();
      pressed.length = 0;
      return out;
    },

    isDown: (code) => keys.has(code),

    dispose() {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

const SWALLOW = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab", "Slash", "Backspace",
]);

/** The two players' halves of the keyboard (readPlayer). */
export const SPLIT = [
  { fwd: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", weapon: ["Space"], brake: ["ShiftLeft"] },
  { fwd: "ArrowUp", back: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", weapon: ["ShiftRight", "Slash"], brake: ["Period", "AltRight"] },
];

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const deadzone = (v, dz = 0.12) =>
  Math.abs(v) < dz ? 0 : Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz));

/**
 * A player's on-screen stick (the phone build, mobile/touch.js), or null when
 * no thumb is on it. Its buttons press keys instead (Space, Shift, Enter...),
 * so everything else reads them like a keyboard.
 */
function touchDrive(slot) {
  const t = globalThis.ROBO_TOUCH?.stick?.(slot);
  return t ? { throttle: clamp(t.throttle, -1, 1), steer: clamp(t.steer, -1, 1) } : null;
}

/** Connected gamepads, in the order they were plugged in. */
function gamepads() {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
  return [...navigator.getGamepads()].filter((p) => p && p.connected);
}

/**
 * A pad's DriveInput, or null if nobody is touching it (so the keyboard keeps
 * working with a pad plugged in): left stick or triggers to drive, right
 * stick to steer, A weapon, B brake.
 */
function padDrive(pad) {
  const ly = -deadzone(pad.axes[1] ?? 0);
  const rx = deadzone(pad.axes[2] ?? pad.axes[0] ?? 0);
  const rt = pad.buttons[7]?.value ?? 0;
  const lt = pad.buttons[6]?.value ?? 0;
  const pressed = !!pad.buttons[0]?.pressed || !!pad.buttons[1]?.pressed;
  if (!(Math.abs(ly) > 0 || Math.abs(rx) > 0 || rt > 0.05 || lt > 0.05 || pressed)) return null;
  return {
    throttle: clamp(ly + rt - lt, -1, 1),
    steer: -rx,   // stick right = turn right = negative steer
    brake: !!pad.buttons[1]?.pressed,
    weapon: pad.buttons[0]?.pressed ? 1 : 0,
  };
}
