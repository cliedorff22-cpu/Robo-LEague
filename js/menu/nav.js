// nav.js - the menus' back and forward arrows.
//
// Every screen is a URL hash (#quick, #career, #career/workshop, ...), so the
// browser's own history is the record of where you have been, and the arrows
// step through it like the browser's buttons do. Each history entry carries
// its place in this visit (history.state.nav), so the arrows know when there
// is nothing to go back or forward to - and back never steps out of the menus
// into the fight you just left.
//
// Plain DOM; shared by the desktop menus and the phone build (mobile/).

const MAX_KEY = "robo-league.nav.max";

export function makeNav(app) {
  const canPush = typeof history !== "undefined" && typeof history.pushState === "function";
  let idx = 0, max = 0;

  const readMax = () => { try { return Number(sessionStorage.getItem(MAX_KEY)) || 0; } catch { return 0; } };
  const writeMax = () => { try { sessionStorage.setItem(MAX_KEY, String(max)); } catch { /* private mode */ } };
  const stamp = () => { if (canPush) history.replaceState({ ...(history.state || {}), nav: idx }, ""); };

  // Coming back to an entry of this visit (a reload, or back from elsewhere)
  // keeps its place; a fresh arrival starts a new trail.
  if (canPush && typeof history.state?.nav === "number") { idx = history.state.nav; max = Math.max(idx, readMax()); }
  else { idx = 0; max = 0; stamp(); writeMax(); }

  // ---------------------------------------------------------------- the arrows
  const el = document.createElement("div");
  el.className = "nav-arrows";
  el.innerHTML = `<button class="nav-arrow" data-nav="back" title="Back (Alt+←)" aria-label="Back">‹</button>`
    + `<button class="nav-arrow" data-nav="fwd" title="Forward (Alt+→)" aria-label="Forward">›</button>`;
  const $back = el.querySelector?.("[data-nav=back]"), $fwd = el.querySelector?.("[data-nav=fwd]");
  $back?.addEventListener("click", () => back());
  $fwd?.addEventListener("click", () => forward());

  function paint() {
    if ($back) $back.disabled = idx <= 0;
    if ($fwd) $fwd.disabled = idx >= max;
  }

  /** Put the arrows at the front of the screen's top bar, or in the corner where there is none. */
  function mount() {
    const bar = app.querySelector?.("header.bar");
    if (bar) {
      if (el.parentNode !== bar) bar.insertBefore(el, bar.firstChild);
      el.classList.remove("floating");
    } else {
      if (el.parentNode !== document.body) document.body.appendChild(el);
      el.classList.add("floating");
    }
    paint();
  }
  // Screens redraw themselves in many places; follow every redraw.
  if (typeof MutationObserver !== "undefined") new MutationObserver(mount).observe(app, { childList: true });

  // ---------------------------------------------------------------- moving
  /** A new screen: a new history entry, and nothing left to go forward to. */
  function push(hash) {
    const cur = location.hash === "#" ? "" : location.hash;
    if (cur === hash) return;
    if (!canPush) { location.hash = hash; return; }
    idx += 1; max = idx;
    history.pushState({ nav: idx }, "", hash || location.pathname + location.search);
    writeMax();
    paint();
  }

  /** The URL changed under us (the arrows, the browser's buttons, a typed hash). */
  function sync() {
    if (canPush && typeof history.state?.nav === "number") idx = history.state.nav;
    else { idx += 1; max = idx; stamp(); writeMax(); }
    paint();
  }

  function back() { if (idx > 0) history.back(); }
  function forward() { if (idx < max) history.forward(); }

  paint();
  return { push, sync, back, forward, mount, get idx() { return idx; }, get max() { return max; } };
}
