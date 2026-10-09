// ledger.js - money in and out of a career, with a line for every amount.
// Shared by career.js (purses, repairs, sponsors) and garage.js (the parts
// shop), so both write the same ledger the Money tab shows.

/** Add `amount` (negative to spend) to the career's cash, with a ledger line. */
export function pay(career, amount, label) {
  if (!amount) return;
  career.cash += amount;
  // Everything ever earned, for the Hall of Fame (the ledger keeps only the latest lines).
  if (amount > 0) career.earned = (career.earned || 0) + amount;
  career.ledger.push({ season: career.seasonIndex, round: career.season?.round ?? 0, label, amount });
  if (career.ledger.length > 400) career.ledger.splice(0, career.ledger.length - 400);
}
