import { getAccount, getPositions, getOptionLatestQuote } from "./alpaca.js";
import { WheelState } from "./state.js";
import { todayET, timestampET } from "./market.js";

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export async function printDailySummary(
  state: WheelState,
  symbol: string
): Promise<void> {
  const sep = "=".repeat(56);
  console.log(`\n${sep}`);
  console.log(`  WHEEL STRATEGY DAILY SUMMARY — ${todayET()}`);
  console.log(`  ${timestampET()}`);
  console.log(sep);
  console.log(`  Stock  : ${symbol}`);
  console.log(`  Stage  : ${state.stage}`);
  console.log(`  Cycles : ${state.cycles_completed} completed`);

  // Account info
  try {
    const account = await getAccount();
    const cash = parseFloat(account.cash);
    const portfolioValue = parseFloat(account.portfolio_value);
    console.log(`  Cash   : ${usd(cash)}`);
    console.log(`  Portfolio Value: ${usd(portfolioValue)}`);
  } catch (err) {
    console.warn(`  (Could not fetch account info: ${err})`);
  }

  // Active contract details
  if (state.active_contract) {
    console.log(`\n  Active Contract: ${state.active_contract}`);
    const quote = await getOptionLatestQuote(state.active_contract);
    if (quote) {
      const entryTotal = state.entry_premium * 100; // 1 contract = 100 shares
      const currentTotal = quote.mid * 100;
      const profitLoss = entryTotal - currentTotal; // profit = premium received - cost to close
      const profitPct = entryTotal > 0 ? profitLoss / entryTotal : 0;
      console.log(
        `    Entry premium : ${usd(state.entry_premium)}/share (${usd(entryTotal)} total)`
      );
      console.log(
        `    Current mid   : ${usd(quote.mid)}/share (${usd(currentTotal)} to close)`
      );
      console.log(
        `    Unrealized P&L: ${usd(profitLoss)} (${pct(profitPct)})`
      );
      if (profitPct >= 0.5) {
        console.log(`    *** 50% profit threshold reached — consider closing early ***`);
      }
    } else {
      console.log(`    (No live quote available for this contract)`);
      console.log(`    Entry premium: ${usd(state.entry_premium)}/share`);
    }
  } else {
    console.log(`\n  Active Contract: None`);
  }

  // Stock position (Stage 2)
  if (state.stage === "SELL_CALLS" && state.shares_qty > 0) {
    console.log(`\n  Stock Position:`);
    console.log(`    Shares held   : ${state.shares_qty}`);
    console.log(`    Cost basis    : ${usd(state.cost_basis ?? 0)}/share`);
    try {
      const positions = await getPositions();
      const stockPos = positions.find(
        (p) => p.symbol === symbol && p.asset_class === "us_equity"
      );
      if (stockPos) {
        const mktVal = parseFloat(stockPos.market_value);
        const costVal = parseFloat(stockPos.cost_basis);
        const unrealizedPL = parseFloat(stockPos.unrealized_pl);
        console.log(`    Market value  : ${usd(mktVal)}`);
        console.log(`    Unrealized P&L: ${usd(unrealizedPL)}`);
      }
    } catch {
      // non-fatal
    }
  }

  // Premium summary
  const totalPremiumDollars = state.total_premium_collected * 100;
  console.log(`\n  --- Premium Summary ---`);
  console.log(`  This contract entry: ${usd(state.entry_premium * 100)}`);
  console.log(`  Total collected    : ${usd(totalPremiumDollars)}`);

  // Return estimate (vs starting $100k)
  const startingCapital = 100_000;
  const returnPct = totalPremiumDollars / startingCapital;
  console.log(`  Est. total return  : ${pct(returnPct)} on ${usd(startingCapital)} capital`);

  console.log(sep);
  console.log();
}
