// menu-touch.js - the phone build's extras on the menus: how to put the game on
// the home screen, where the browser does not offer it itself.

const STANDALONE = matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches || navigator.standalone === true;
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const KEY = "robo-league.mobile.installHint";

let deferred = null;                     // Android's own install prompt, kept for our button
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; show(); });

function dismissed() { try { return localStorage.getItem(KEY) === "no"; } catch { return false; } }

/** A line under the main menu: on iPhone, the Share-button route; on Android, an Install button. */
function show() {
  if (STANDALONE || dismissed()) return;
  if (location.hash && location.hash !== "#") return;
  const left = document.querySelector(".main-left");
  if (!left || left.querySelector(".install-hint")) return;
  if (!IOS && !deferred) return;
  const el = document.createElement("div");
  el.className = "install-hint";
  el.innerHTML = IOS
    ? `<b>Play it full screen:</b> tap <b>Share</b> <span aria-hidden="true">⬆︎</span>, then <b>Add to Home Screen</b>. <button class="ghost tiny" data-x>Not now</button>`
    : `<b>Play it full screen:</b> install ROBO LEAGUE like an app. <button class="ghost tiny" data-install>Install</button> <button class="ghost tiny" data-x>Not now</button>`;
  left.appendChild(el);
  el.querySelector("[data-x]").addEventListener("click", () => { try { localStorage.setItem(KEY, "no"); } catch { /* private mode */ } el.remove(); });
  el.querySelector("[data-install]")?.addEventListener("click", async () => { deferred?.prompt(); await deferred?.userChoice; deferred = null; el.remove(); });
}

// The menu redraws its screens; look again whenever it does.
new MutationObserver(() => show()).observe(document.getElementById("app"), { childList: true });
// (Every screen opens at its top: ../js/menu/menu.js route() sees to it.)
addEventListener("hashchange", () => setTimeout(show, 0));
show();
