import {
  getOptionContracts,
  getOptionLatestQuote,
  AlpacaOptionContract,
  LatestQuote,
} from "./alpaca.js";
import { nowET } from "./market.js";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns a list of upcoming Friday expiration dates (YYYY-MM-DD) in the
 * window [minDays, maxDays] from today, in ET.
 */
function getTargetExpirations(minDays: number, maxDays: number): string[] {
  const now = nowET();
  const dates: string[] = [];

  for (let offset = minDays; offset <= maxDays; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    if (d.getDay() === 5) {
      // Friday
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${day}`);
    }
  }
  return dates;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Strike rounding
// ---------------------------------------------------------------------------

/**
 * Rounds a price to the nearest $5 increment (standard for high-priced stocks).
 */
function roundToNearest5(price: number): number {
  return Math.round(price / 5) * 5;
}

// ---------------------------------------------------------------------------
// Contract scoring/selection
// ---------------------------------------------------------------------------

/**
 * Given a list of contracts, try to find live quotes for each and return
 * the best candidate: most liquid (open interest), with a tradeable quote.
 */
async function selectBestContract(
  contracts: AlpacaOptionContract[]
): Promise<{ contract: AlpacaOptionContract; quote: LatestQuote } | null> {
  // Sort by open_interest descending (most liquid first)
  const sorted = [...contracts].sort((a, b) => {
    const oi_a = parseInt(a.open_interest ?? "0", 10);
    const oi_b = parseInt(b.open_interest ?? "0", 10);
    return oi_b - oi_a;
  });

  // Try the top 10 most liquid contracts and pick the first with a live quote
  for (const contract of sorted.slice(0, 10)) {
    if (!contract.tradable) continue;
    const quote = await getOptionLatestQuote(contract.symbol);
    if (quote && quote.mid > 0.05) {
      // Require at least $0.05 mid to avoid illiquid junk
      return { contract, quote };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SelectedOption {
  contract: AlpacaOptionContract;
  quote: LatestQuote;
  /** Limit price to use when placing the sell order (midpoint, rounded) */
  limitPrice: number;
}

/**
 * Find the best cash-secured put to sell for `symbol`.
 * Target: strike ~10% below currentPrice, expiry 14–28 days out (a Friday).
 */
export async function findPutToSell(
  symbol: string,
  currentPrice: number
): Promise<SelectedOption | null> {
  const targetStrike = roundToNearest5(currentPrice * 0.90);
  const now = nowET();
  const minExp = formatDate(addDays(now, 14));
  const maxExp = formatDate(addDays(now, 28));

  console.log(
    `[options] Searching for ${symbol} put | current=$${currentPrice.toFixed(2)} | ` +
      `target strike=$${targetStrike} | expiry ${minExp} → ${maxExp}`
  );

  // Fetch puts within ±$30 of target strike, within expiry window
  // Using a flat dollar window is more robust than a % range for high-priced stocks
  const contracts = await getOptionContracts({
    underlying_symbol: symbol,
    type: "put",
    expiration_date_gte: minExp,
    expiration_date_lte: maxExp,
    strike_price_gte: targetStrike - 30,
    strike_price_lte: targetStrike + 30,
    limit: 100,
  });

  if (contracts.length === 0) {
    console.warn(`[options] No put contracts found for ${symbol} in the target range.`);
    return null;
  }

  // Filter: only keep contracts whose strike is <= target (OTM puts)
  const otmPuts = contracts.filter(
    (c) => parseFloat(c.strike_price) <= targetStrike
  );

  // If no OTM contracts, fall back to all fetched contracts
  const pool = otmPuts.length > 0 ? otmPuts : contracts;
  const result = await selectBestContract(pool);
  if (!result) return null;

  const limitPrice = parseFloat(result.quote.mid.toFixed(2));
  console.log(
    `[options] Selected put: ${result.contract.symbol} | strike=$${result.contract.strike_price} | ` +
      `exp=${result.contract.expiration_date} | mid=$${limitPrice} | ` +
      `OI=${result.contract.open_interest ?? "N/A"}`
  );
  return { ...result, limitPrice };
}

/**
 * Find the best covered call to sell for `symbol`.
 * Target: strike ~10% above costBasis, expiry 14–28 days out (a Friday).
 * Safety: strike MUST be >= costBasis.
 */
export async function findCallToSell(
  symbol: string,
  costBasis: number
): Promise<SelectedOption | null> {
  const targetStrike = roundToNearest5(costBasis * 1.10);
  // Safety: never go below cost basis
  const minStrike = Math.max(targetStrike, Math.ceil(costBasis));
  const now = nowET();
  const minExp = formatDate(addDays(now, 14));
  const maxExp = formatDate(addDays(now, 28));

  console.log(
    `[options] Searching for ${symbol} call | cost_basis=$${costBasis.toFixed(2)} | ` +
      `target strike=$${targetStrike} | expiry ${minExp} → ${maxExp}`
  );

  const contracts = await getOptionContracts({
    underlying_symbol: symbol,
    type: "call",
    expiration_date_gte: minExp,
    expiration_date_lte: maxExp,
    strike_price_gte: minStrike,
    strike_price_lte: targetStrike + 30,
    limit: 100,
  });

  if (contracts.length === 0) {
    console.warn(`[options] No call contracts found for ${symbol} in the target range.`);
    return null;
  }

  // For covered calls we want OTM calls: strike >= target
  const otmCalls = contracts.filter(
    (c) => parseFloat(c.strike_price) >= targetStrike
  );
  const pool = otmCalls.length > 0 ? otmCalls : contracts;

  const result = await selectBestContract(pool);
  if (!result) return null;

  // Strict safety: refuse to sell below cost basis
  if (parseFloat(result.contract.strike_price) < costBasis) {
    console.error(
      `[options] SAFETY: selected call strike $${result.contract.strike_price} < cost basis $${costBasis}. Aborting.`
    );
    return null;
  }

  const limitPrice = parseFloat(result.quote.mid.toFixed(2));
  console.log(
    `[options] Selected call: ${result.contract.symbol} | strike=$${result.contract.strike_price} | ` +
      `exp=${result.contract.expiration_date} | mid=$${limitPrice} | ` +
      `OI=${result.contract.open_interest ?? "N/A"}`
  );
  return { ...result, limitPrice };
}

/**
 * Gets the target expiration dates for reference/logging (exported for use in summary).
 */
export { getTargetExpirations };
