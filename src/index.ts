import dotenv from "dotenv";
dotenv.config();

import { loadState, saveState } from "./state.js";
import { isMarketOpen, isSummaryWindow, todayET, timestampET } from "./market.js";
import { runSellPuts, runSellCalls } from "./wheel.js";
import { printDailySummary } from "./summary.js";

const SYMBOL = process.env.WHEEL_SYMBOL ?? "TSLA";

async function main(): Promise<void> {
  console.log(`\n[bot] ====== Wheel Bot run at ${timestampET()} ======`);
  console.log(`[bot] Symbol: ${SYMBOL}`);

  // ------------------------------------------------------------------
  // Gate: only act during market hours
  // ------------------------------------------------------------------
  if (!isMarketOpen()) {
    console.log(`[bot] Market is closed. Nothing to do.`);
    process.exit(0);
  }

  const state = loadState();
  state.last_run = new Date().toISOString();

  // ------------------------------------------------------------------
  // Daily summary window: 15:45–16:00 ET
  // ------------------------------------------------------------------
  if (isSummaryWindow()) {
    const today = todayET();
    if (state.daily_summary_sent !== today) {
      await printDailySummary(state, SYMBOL);
      state.daily_summary_sent = today;
      saveState(state);
    } else {
      console.log(`[bot] Daily summary already sent for ${today}.`);
    }
    // Still run the strategy logic during the summary window —
    // we might need to close a position before market close.
  }

  // ------------------------------------------------------------------
  // Run the wheel strategy
  // ------------------------------------------------------------------
  try {
    if (state.stage === "SELL_PUTS") {
      await runSellPuts(state, SYMBOL);
    } else if (state.stage === "SELL_CALLS") {
      await runSellCalls(state, SYMBOL);
    } else {
      console.error(`[bot] Unknown stage: ${(state as { stage: string }).stage}. Resetting.`);
      state.stage = "SELL_PUTS";
      saveState(state);
    }
  } catch (err: unknown) {
    console.error(`[bot] Unhandled error in wheel strategy:`, err);
    // Save last_run even on error so we can track timing
    saveState(state);
    process.exit(1);
  }

  console.log(`[bot] ====== Run complete ======\n`);
  process.exit(0);
}

main();
