// market.js - money and trading in the career: bank loans, the paddock market
// (AI teams selling spare parts and buying yours) and selling your robot to
// an AI team.
//
// Pure logic over the career save; the numbers are data/economy.json `loans`
// and `market`. The Market tab (js/menu/market_ui.js) only calls in here.
//
//   career.loans       = [{ lender, owed, borrowed, seasonsLeft, since }]
//   career.market      = { key, listings: [...], taken: [partId...] } - one
//                        "market day", regenerated after every fight
//   career.robotSales  = [{ def, buyerId, team, season, price, status, newId }]
//
// Everything that needs chance draws from a seed made of the career seed and
// the market day, so a save reloads to the same listings.

import { makeRng, hashSeed } from "../core/rng.js";
import { pay } from "./ledger.js";
import { garageOf, playerDef, spares, priceOf, resaleOf, fittedCounts, countParts, shopTier, newGarage } from "./garage.js";
import { assembleRobot, assemblePartner } from "./build.js";
import { conditionReport } from "./condition.js";
import { evolvedDef } from "./evolution.js";

const LEAGUE_TIER = { rookie: 1, pro: 2, elite: 3, world: 3 };
const FITTINGS = ["drive", "wheel", "motor", "battery", "electronics", "weaponMotor", "weapon", "srimech"];

const money = (n) => `$${Math.round(n).toLocaleString()}`;
const leagueOf = (career) => career.membership[career.playerId];

// ---------------------------------------------------------------- loans

/** The lenders, from economy.json. */
export function lenders(reg) {
  return reg.economy.loans?.lenders || [];
}
const lender = (reg, id) => lenders(reg).find((l) => l.id === id);

/** Everything owed, across all lenders. */
export function debt(career) {
  return (career.loans || []).reduce((t, l) => t + l.owed, 0);
}

/** What each lender will do for the player now: { ...lender, limit, owed, available }. */
export function loanOffers(reg, career) {
  const lg = leagueOf(career);
  return lenders(reg).map((l) => {
    const loan = (career.loans || []).find((x) => x.lender === l.id);
    const limit = l.limit?.[lg] ?? 0;
    const owed = loan?.owed ?? 0;
    return { ...l, limit, owed, available: Math.max(0, limit - owed), seasonsLeft: loan?.seasonsLeft ?? null };
  });
}

/** Borrow `amount` from a lender. @returns { ok, reason } */
export function borrow(reg, career, lenderId, amount) {
  const l = lender(reg, lenderId);
  if (!l) return { ok: false, reason: "No such lender." };
  amount = Math.round(Number(amount) || 0);
  if (amount <= 0) return { ok: false, reason: "Borrow something." };
  const offer = loanOffers(reg, career).find((x) => x.id === lenderId);
  if (amount > offer.available) {
    return { ok: false, reason: offer.available ? `${l.name} will lend you up to ${money(offer.available)} more in the ${leagueOf(career)} league.` : `${l.name} will not lend you any more until you pay some back or move up a league.` };
  }
  career.loans ||= [];
  let loan = career.loans.find((x) => x.lender === lenderId);
  if (!loan) { loan = { lender: lenderId, owed: 0, borrowed: 0, seasonsLeft: l.seasons, since: career.seasonIndex }; career.loans.push(loan); }
  loan.owed += amount;
  loan.borrowed += amount;
  loan.seasonsLeft = l.seasons;          // a top-up starts the term again
  pay(career, amount, `Loan from ${l.name}`);
  return { ok: true, reason: "", loan };
}

/** Pay `amount` off a loan early (no penalty). @returns { ok, paid, reason } */
export function repay(reg, career, lenderId, amount) {
  const loan = (career.loans || []).find((x) => x.lender === lenderId);
  if (!loan) return { ok: false, paid: 0, reason: "You owe them nothing." };
  amount = Math.min(Math.round(Number(amount) || 0), loan.owed);
  if (amount <= 0) return { ok: false, paid: 0, reason: "Pay something." };
  if (amount > career.cash) return { ok: false, paid: 0, reason: `You have ${money(Math.max(0, career.cash))}.` };
  loan.owed -= amount;
  pay(career, -amount, `Paid off ${lender(reg, lenderId)?.name ?? lenderId}`);
  if (loan.owed <= 0) career.loans = career.loans.filter((x) => x !== loan);
  return { ok: true, paid: amount, reason: "" };
}

/**
 * The start of a season: every loan's interest is added, then a payment is
 * taken - what is owed over the seasons left, so it is clear at the end of
 * its term. Taken even if it puts the bank in the red.
 * @returns [{ lender, interest, payment, owed }]
 */
export function serviceLoans(reg, career) {
  const out = [];
  for (const loan of career.loans || []) {
    const l = lender(reg, loan.lender);
    if (!l) continue;
    const interest = Math.round(loan.owed * l.rate);
    loan.owed += interest;
    const payment = Math.min(loan.owed, Math.ceil(loan.owed / Math.max(1, loan.seasonsLeft)));
    loan.owed -= payment;
    loan.seasonsLeft = Math.max(1, loan.seasonsLeft - 1);
    pay(career, -payment, `${l.name}: loan payment (${money(interest)} interest)`);
    out.push({ lender: l.id, name: l.name, interest, payment, owed: loan.owed });
  }
  career.loans = (career.loans || []).filter((x) => x.owed > 0);
  return out;
}

// ---------------------------------------------------------------- the paddock market

/** Market tunables, with defaults. */
export function marketConfig(reg) {
  return {
    listings: 6, sellPrice: [0.6, 0.95], tierAbove: 1, offerChance: 0.6, buyPrice: [0.55, 0.85], robotPrice: 0.55,
    ...(reg.economy.market || {}),
    reputation: { win: 250, ko: 100, title: 4000, max: 40000, ...(reg.economy.market?.reputation || {}) },
  };
}

/** One market day: a new one after every fight the player fights, and every season. */
const marketKey = (career) => `${career.seasonIndex}:${career.stats?.fights ?? 0}`;
const between = (rng, [lo, hi]) => lo + rng.next() * (hi - lo);
const round10 = (n) => Math.max(10, Math.round(n / 10) * 10);

/** The AI robots in the field, nearest the player's league first (the teams the player meets). */
function sellers(reg, career) {
  const order = reg.league.leagues;
  const mine = order.indexOf(leagueOf(career));
  return Object.keys(career.membership)
    .filter((id) => id !== career.playerId && reg.hasRobot(id))
    .map((id) => ({ id, gap: Math.abs(order.indexOf(career.membership[id]) - mine) }))
    .sort((a, b) => a.gap - b.gap || (a.id < b.id ? -1 : 1));
}

/** A team's robot as it races now (its off-season upgrades included). */
const teamDef = (reg, career, id) => ({ ...evolvedDef(reg, career, id), league: career.membership[id] });

/**
 * Today's market, generated on first look each market day (and kept, so a
 * part bought is gone).
 */
export function marketOf(reg, career) {
  const key = marketKey(career);
  if (career.market?.key === key) return career.market;
  const cfg = marketConfig(reg);
  const rng = makeRng(hashSeed(`${career.seed}:market:${key}`));
  const maxTier = shopTier(reg, career) + cfg.tierAbove;
  const pool = sellers(reg, career);
  // Mostly teams from the player's own league and the one either side.
  const near = pool.filter((s) => s.gap <= 1);
  const listings = [];
  const seen = new Set();
  for (let tries = 0; listings.length < cfg.listings && tries < 80; tries++) {
    const src = near.length && rng.next() < 0.85 ? near : pool;
    const from = src[Math.floor(rng.next() * src.length)];
    if (!from) break;
    const def = teamDef(reg, career, from.id);
    const fitted = [...FITTINGS.map((k) => def.build[k]).filter(Boolean), ...(def.build.armor || [])];
    const partId = fitted[Math.floor(rng.next() * fitted.length)];
    if (!partId || seen.has(partId) || !reg.hasPart(partId)) continue;
    const part = reg.part(partId);
    if ((part.tier ?? 1) > maxTier) continue;
    seen.add(partId);
    // A team with money in the bank holds out for its price; a broke one sells cheap.
    const bank = career.evolution?.[from.id]?.bank ?? 0;
    const f = Math.min(cfg.sellPrice[1], between(rng, cfg.sellPrice) + (bank > 4000 ? 0.08 : 0));
    listings.push({
      id: `l${listings.length}`, partId, sellerId: from.id, team: def.team || reg.robot(from.id).team, robot: def.name,
      league: career.membership[from.id], price: round10(part.cost * f), list: part.cost,
      locked: (part.tier ?? 1) > shopTier(reg, career),
    });
  }
  career.market = { key, listings, taken: [] };
  return career.market;
}

/** Buy a part an AI team is selling: it goes into the garage as a spare. */
export function buyListing(reg, career, listingId) {
  const m = marketOf(reg, career);
  const l = m.listings.find((x) => x.id === listingId);
  if (!l) return { ok: false, reason: "That part has gone." };
  if (l.price > career.cash) return { ok: false, reason: `It costs ${money(l.price)}; you have ${money(Math.max(0, career.cash))}.` };
  const g = garageOf(reg, career);
  g.owned[l.partId] = (g.owned[l.partId] || 0) + 1;
  pay(career, -l.price, `Bought a ${reg.part(l.partId).name} from ${l.team}`);
  m.listings = m.listings.filter((x) => x !== l);
  return { ok: true, reason: "", listing: l };
}

/**
 * What AI teams will pay for the player's spares today: at most one offer a
 * part, better than the shop's resale. [{ partId, count, price, team, robotId, resale }]
 */
export function sparesOffers(reg, career) {
  const cfg = marketConfig(reg);
  const m = marketOf(reg, career);
  const pool = sellers(reg, career);
  const out = [];
  for (const [partId, count] of Object.entries(spares(reg, career)).sort()) {
    if (!reg.hasPart(partId)) continue;
    const rng = makeRng(hashSeed(`${career.seed}:offer:${m.key}:${partId}`));
    const resale = resaleOf(reg, partId);
    const offered = rng.next() < cfg.offerChance && !m.taken.includes(partId) && pool.length;
    if (!offered) { out.push({ partId, count, price: null, team: null, robotId: null, resale }); continue; }
    // A team that could use one: the same kind of part on its robot if any does.
    const kind = reg.part(partId).category;
    const users = pool.filter((s) => s.gap <= 1 && Object.values(teamDef(reg, career, s.id).build).flat().some((p) => reg.hasPart(p) && reg.part(p).category === kind));
    const buyer = (users.length ? users : pool)[Math.floor(rng.next() * (users.length || pool.length))];
    const price = Math.max(resale + 10, round10(reg.part(partId).cost * between(rng, cfg.buyPrice)));
    out.push({ partId, count, price, team: teamDef(reg, career, buyer.id).team || reg.robot(buyer.id).team, robotId: buyer.id, resale });
  }
  return out;
}

/** Take a team's offer for one spare. */
export function sellToTeam(reg, career, partId) {
  const o = sparesOffers(reg, career).find((x) => x.partId === partId);
  if (!o || !o.price) return { ok: false, reason: "Nobody is offering for that today." };
  const g = garageOf(reg, career);
  g.owned[partId]--;
  if (g.owned[partId] <= 0) delete g.owned[partId];
  pay(career, o.price, `Sold a ${reg.part(partId).name} to ${o.team}`);
  marketOf(reg, career).taken.push(partId);
  return { ok: true, reason: "", price: o.price, team: o.team };
}

// ---------------------------------------------------------------- selling the robot

/** The stock kit the player fights with after selling their robot: the starting robot's parts. */
function stockKit(reg) {
  return JSON.parse(JSON.stringify(reg.robot(reg.playerId).build));
}

/** What a full repair of the player's robot would cost (list, before any discount). */
function damageValue(reg, career) {
  const g = garageOf(reg, career);
  const def = playerDef(reg, career);
  let total = 0;
  const units = [[assembleRobot(reg, def), g.condition]];
  if (def.partner) units.push([assemblePartner(reg, def), g.partnerCondition]);
  for (const [a, c] of units) {
    Object.assign(a.condition, c || {});
    for (const r of conditionReport(a, reg.rules)) total += r.repairCost || 0;
  }
  return Math.round(total * (reg.economy.repairs?.labourMultiplier ?? 1));
}

/**
 * The best offer for the player's robot as it stands, and what selling it
 * means: { buyerId, team, robot, price, parts, reputation, damage, kit: { buy, cost }, net, ok, reason }.
 * The buyer is the team in the player's league (or below) with the weakest
 * driver-and-robot - it wants a better robot - and it will race it from next
 * season in that robot's place.
 */
export function robotOffer(reg, career) {
  const cfg = marketConfig(reg);
  const g = garageOf(reg, career);
  const order = reg.league.leagues;
  const mine = order.indexOf(leagueOf(career));
  const cands = Object.keys(career.membership)
    .filter((id) => id !== career.playerId && reg.hasRobot(id) && order.indexOf(career.membership[id]) <= mine && order.indexOf(career.membership[id]) >= mine - 1)
    .filter((id) => !(career.robotSales || []).some((s) => s.status === "pending" && s.buyerId === id))
    .map((id) => ({ id, r: career.evolution?.[id]?.rating ?? reg.robot(id).rating }))
    .sort((a, b) => a.r - b.r || (a.id < b.id ? -1 : 1));
  const rng = makeRng(hashSeed(`${career.seed}:robotbuyer:${marketKey(career)}`));
  const buyer = cands[Math.floor(rng.next() * Math.min(3, cands.length))];
  if (!buyer) return { ok: false, reason: "No team is buying right now." };
  const fitted = fittedCounts(g.build, g.partner?.build);
  const parts = Object.entries(fitted).reduce((t, [id, n]) => t + (reg.hasPart(id) ? reg.part(id).cost * n : 0), 0);
  const rec = g.record || { wins: 0, kos: 0, titles: 0 };
  const reputation = Math.min(cfg.reputation.max, rec.wins * cfg.reputation.win + rec.kos * cfg.reputation.ko + rec.titles * cfg.reputation.title);
  const damage = damageValue(reg, career);
  const price = Math.max(500, Math.round((parts * cfg.robotPrice + reputation - damage) / 100) * 100);
  // The kit to fight with afterwards: spares first, the rest from the shop.
  const left = { ...g.owned };
  for (const [id, n] of Object.entries(fitted)) left[id] = (left[id] || 0) - n;
  const buy = [];
  let cost = 0;
  for (const [id, n] of Object.entries(countParts(stockKit(reg)))) {
    const short = n - Math.max(0, left[id] || 0);
    if (short > 0) { buy.push({ id, n: short, name: reg.part(id).name }); cost += priceOf(reg, career, id) * short; }
  }
  const net = price - cost;
  const def = teamDef(reg, career, buyer.id);
  const reason = career.pit ? "Close the pit first - nobody buys a robot with the crew still working on it."
    : career.cash + net < 0 ? `The stock kit costs ${money(cost)} more than they pay, and you cannot cover it.` : "";
  return { ok: !reason, reason, buyerId: buyer.id, team: def.team || reg.robot(buyer.id).team, robot: def.name, league: career.membership[buyer.id],
    price, parts: Math.round(parts * cfg.robotPrice), reputation, damage, kit: { buy, cost }, net };
}

/**
 * Sell the robot to the team that made the offer. It goes into the museum
 * (sold, not retired), its parts go with it, and the player starts again on
 * a stock kit named `newName`. The buying team races it from next season, in
 * place of its own robot (deliverSales, at the off-season).
 */
export function sellRobot(reg, career, newName) {
  const o = robotOffer(reg, career);
  if (!o.ok) return { ok: false, reason: o.reason };
  const g = garageOf(reg, career);
  const def = playerDef(reg, career);
  const rec = g.record || { fights: 0, wins: 0, kos: 0, titles: 0, since: career.seasonIndex };
  (g.museum ||= []).push({ name: g.name, version: g.version, from: rec.since, to: career.seasonIndex, ...rec,
    weapon: g.build.weapon ? reg.part(g.build.weapon).name : "None", livery: g.livery, sold: { team: o.team, price: o.price, season: career.seasonIndex } });
  (career.robotSales ||= []).push({
    def: { name: def.name, body: def.body, build: def.build, livery: def.livery, personality: def.personality, archetype: def.archetype, version: def.version, partner: def.partner || null },
    buyerId: o.buyerId, team: o.team, season: career.seasonIndex, price: o.price, status: "pending", newId: null,
  });
  // The parts go with the robot; the kit comes from spares and the shop.
  for (const [id, n] of Object.entries(fittedCounts(g.build, g.partner?.build))) {
    g.owned[id] = (g.owned[id] || 0) - n;
    if (g.owned[id] <= 0) delete g.owned[id];
  }
  pay(career, o.price, `Sold ${g.name} to ${o.team}`);
  for (const b of o.kit.buy) {
    g.owned[b.id] = (g.owned[b.id] || 0) + b.n;
    pay(career, -priceOf(reg, career, b.id) * b.n, `Stock kit: ${b.n > 1 ? `${b.n}x ` : ""}${b.name}`);
  }
  const fresh = newGarage(reg);
  Object.assign(g, {
    name: String(newName || "").trim().slice(0, 28) || `${g.name} II`,
    body: fresh.body, build: stockKit(reg), partner: null, condition: {}, partnerCondition: {},
    version: "1.0", log: [], record: { fights: 0, wins: 0, kos: 0, titles: 0, since: career.seasonIndex },
  });
  career.prep = null;
  career.market = null;
  career.notices.push({ kind: "sponsor", text: `${o.team} bought ${def.name} for ${money(o.price)}. It races for them from next season.` });
  return { ok: true, reason: "", offer: o };
}
