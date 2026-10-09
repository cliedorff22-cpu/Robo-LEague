// market_ui.js - the career's Market tab: the bank, the paddock market and
// selling your robot. All the rules are js/logic/market.js; this file only
// shows them and wires the buttons to the career screen's actions.

import { loanOffers, debt, marketOf, sparesOffers, robotOffer } from "../logic/market.js";
import { LEAGUE_TITLES } from "../logic/career.js";

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const CATEGORY = { weaponMotor: "weapon motor", armor: "armour", srimech: "self-righter", electronics: "electronics", motor: "drive motors", wheel: "wheels" };

/** The Market tab's HTML. `rname` names a robot the way the career does. */
export function marketHtml({ reg, career, esc, rname, message }) {
  const loans = loanOffers(reg, career);
  const owed = debt(career);
  const m = marketOf(reg, career);
  const offers = sparesOffers(reg, career);
  const ro = robotOffer(reg, career);
  const sales = career.robotSales || [];
  const partName = (id) => esc(reg.part(id).name);
  const lg = (x) => esc(LEAGUE_TITLES[x] || x);
  return `
    ${message ? `<div class="callout mk-msg ${message.ok ? "ok" : "bad"}"><div class="callout-text">${esc(message.text)}</div></div>` : ""}
    <div class="scout-sub">The bank${owed ? ` <span class="muted">· you owe ${money(owed)}</span>` : ""}</div>
    <p class="muted small">Interest is added at the start of every season and a payment taken then, so a loan is paid off over its term. Pay any of it off early with no penalty. Limits go up with your league.</p>
    <table class="ledger mk-bank">${loans.map((l) => `
      <tr><td><b>${esc(l.name)}</b><div class="muted small">${esc(l.blurb)} ${pct(l.rate)} a season, over ${l.seasons} seasons.</div></td>
        <td class="muted small">${l.owed ? `owe ${money(l.owed)}${l.seasonsLeft ? ` · ${l.seasonsLeft} season${l.seasonsLeft > 1 ? "s" : ""} left` : ""}` : "nothing owed"}<br>up to ${money(l.available)} more</td>
        <td class="mk-act">
          <input class="mk-amt" type="number" min="0" step="500" placeholder="amount" data-amt="${esc(l.id)}" aria-label="Amount for ${esc(l.name)}">
          <button class="ghost tiny" data-borrow="${esc(l.id)}"${l.available ? "" : " disabled"}>Borrow</button>
          <button class="ghost tiny" data-repay="${esc(l.id)}"${l.owed ? "" : " disabled"}>Pay off</button>
        </td></tr>`).join("")}
    </table>

    <div class="scout-sub">For sale in the paddock</div>
    <p class="muted small">Spare parts from other teams' pits, cheaper than the shop - and a team in a higher league may sell you a part the shop will not yet. New stock after every fight.</p>
    ${m.listings.length ? `<table class="ledger">${m.listings.map((l) => `
      <tr><td><b>${partName(l.partId)}</b>${l.locked ? ` <span class="rival-tag l1">not in your shop yet</span>` : ""}
          <div class="muted small">${esc(CATEGORY[reg.part(l.partId).category] || reg.part(l.partId).category)} · from ${esc(l.team)} (${esc(l.robot)}, ${lg(l.league)})</div></td>
        <td class="muted small">list ${money(l.list)}</td>
        <td>${money(l.price)} <button class="ghost tiny" data-buy="${esc(l.id)}">Buy</button></td></tr>`).join("")}</table>`
      : `<p class="muted">Nothing left today. Come back after your next fight.</p>`}

    <div class="scout-sub">Your spares</div>
    ${offers.length ? `<table class="ledger">${offers.map((o) => `
      <tr><td><b>${partName(o.partId)}</b>${o.count > 1 ? ` <span class="muted">x${o.count}</span>` : ""}
          <div class="muted small">${o.price ? `${esc(o.team)} would pay ${money(o.price)}` : "no team bidding today"} · the shop pays ${money(o.resale)}</div></td>
        <td></td>
        <td>${o.price ? `<button class="ghost tiny" data-sellteam="${esc(o.partId)}">Sell to ${esc(o.team)}</button>` : ""}
          <button class="ghost tiny" data-sellshop="${esc(o.partId)}">Sell to the shop</button></td></tr>`).join("")}</table>`
      : `<p class="muted">No spares: everything you own is on the robot.</p>`}

    <div class="scout-sub">Sell ${esc(rname(career.playerId))}</div>
    ${ro.buyerId ? `
      <p class="small">${esc(ro.team)} (${esc(ro.robot)}, ${lg(ro.league)}) will buy your robot - parts, paint and name - and race it from next season in place of ${esc(ro.robot)}. You could meet it in the box.</p>
      <table class="ledger">
        <tr><td>Its parts</td><td></td><td class="pos">${money(ro.parts)}</td></tr>
        ${ro.reputation ? `<tr><td>Its record</td><td></td><td class="pos">${money(ro.reputation)}</td></tr>` : ""}
        ${ro.damage ? `<tr><td>Less its damage</td><td></td><td class="neg">${money(-ro.damage)}</td></tr>` : ""}
        <tr class="total"><td>They pay</td><td></td><td>${money(ro.price)}</td></tr>
        <tr><td>A stock kit to fight with (${esc(reg.robot(reg.playerId).name)}'s parts${ro.kit.buy.length ? "" : ", all from your spares"})</td><td></td><td class="neg">${money(-ro.kit.cost)}</td></tr>
        <tr class="total"><td>You end up with</td><td></td><td class="${ro.net < 0 ? "neg" : "pos"}">${money(ro.net)}</td></tr>
      </table>
      ${ro.ok ? `<div class="mk-act"><input class="mk-name" id="mk-newname" maxlength="28" placeholder="Name your new robot" aria-label="Name your new robot">
        <button class="ghost" id="mk-sellrobot">Sell it</button></div>` : `<p class="muted small">${esc(ro.reason)}</p>`}`
      : `<p class="muted">${esc(ro.reason)}</p>`}
    ${sales.length ? `<div class="scout-sub">Robots you have sold</div><table class="ledger">${sales.map((s) => `
      <tr><td><b>${esc(s.def.name)}</b> <span class="muted">v${esc(s.def.version)}</span></td>
        <td class="muted small">to ${esc(s.team)}, season ${s.season}${s.status === "fielded" && s.newId in career.membership ? ` · racing in ${lg(career.membership[s.newId])}` : s.status === "pending" ? " · joins them next season" : " · retired"}</td>
        <td>${money(s.price)}</td></tr>`).join("")}</table>` : ""}`;
}

/** Wire the tab's buttons to the career screen's actions. */
export function wireMarket(root, actions) {
  const amt = (id) => Number(root.querySelector(`[data-amt="${id}"]`)?.value || 0);
  root.querySelectorAll("[data-borrow]").forEach((b) => b.addEventListener("click", () => actions.borrow(b.dataset.borrow, amt(b.dataset.borrow))));
  root.querySelectorAll("[data-repay]").forEach((b) => b.addEventListener("click", () => actions.repay(b.dataset.repay, amt(b.dataset.repay) || Infinity)));
  root.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => actions.buyListing(b.dataset.buy)));
  root.querySelectorAll("[data-sellteam]").forEach((b) => b.addEventListener("click", () => actions.sellToTeam(b.dataset.sellteam)));
  root.querySelectorAll("[data-sellshop]").forEach((b) => b.addEventListener("click", () => actions.sellToShop(b.dataset.sellshop)));
  root.querySelector("#mk-sellrobot")?.addEventListener("click", () => {
    const name = root.querySelector("#mk-newname")?.value || "";
    if (!confirm("Sell your robot? Its parts go with it, and you start again on a stock kit.")) return;
    actions.sellRobot(name);
  });
}
