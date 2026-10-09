# ROBO LEAGUE on a phone or tablet

This folder is the phone build of the game. It is the same game - the same
robots, career, tournaments and rules - with on-screen controls, screens laid
out for a phone, and lighter graphics. It uses the game's code and data from
the folder above (`../js`, `../data`, `../css`), so it never falls out of step
with the desktop version, and the desktop version is untouched by it.

## Playing it

A phone cannot run a local server, so the game has to be on a website. Put
the whole `robo-league` folder on any static host (Netlify Drop, Cloudflare
Pages, GitHub Pages) and open `/mobile/` on the phone:

    https://your-site.netlify.app/mobile/

On your own computer, `tools/serve.sh` and http://localhost:8420/mobile/ (a
phone on the same Wi-Fi cannot reach `localhost`, and the browser only allows
installing and offline play over https).

**Full screen, like an app:** on iPhone, tap Share, then Add to Home Screen; on
Android, the menu offers Install (the main menu shows a reminder once). After
the first play it works offline too (`sw.js` keeps every file it has fetched;
with a connection it always fetches fresh, so updates are never stuck behind
a cache).

## Controls

Turn the phone sideways for a fight.

| | |
|---|---|
| drive | put a thumb anywhere on the left half and push: up is forward, left and right turn |
| weapon | hold WEAPON (spins a spinner up, fires a hammer or flipper) |
| brake | hold BRAKE |
| start, rematch, highlights, back | the button at the bottom centre |
| pause | ❚❚ - and from there: hand over to the AI, tap out, quit |
| camera, sound | CAM, ♪ |

**Two players on one tablet** (Quick Fight, blue corner: Player 2): red drives
and fires from the left edge, blue from the right.

## What is different from the desktop build

- **Its own settings** (`robo-league.settings.mobile`), starting with bloom and
  shadows off, 75% render resolution and the damaged-parts list under the health bars
  hidden.
  Everything else - the career, the Hall of Fame, a tournament - is shared
  with the desktop build when both are on the same website.
- Every screen scrolls as one page, with its columns stacked.

## Files

| | |
|---|---|
| `index.html`, `fight.html` | the menu and the fight, ported from `../index.html` and `../fight.html` - keep them in step |
| `mobile.css` | the menus at phone size |
| `fight-mobile.css` | the compact HUD, the controls, the turn-it-sideways card |
| `touch.js` | the on-screen controls: the stick hands its input to `../js/input/input.js` through `globalThis.ROBO_TOUCH`; every button presses the key it stands for |
| `menu-touch.js` | the Add to Home Screen reminder; screens open at the top |
| `manifest.webmanifest`, `sw.js`, `icons/` | installing and offline play; `icons/make_icons.py` draws the icon |

The shared code knows it is in the phone build through `globalThis.ROBO_MOBILE`
(`../js/core/platform.js`): where `data/` is, and its own settings.
