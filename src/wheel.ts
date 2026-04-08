import {
  getAccount,
  getPositions,
  getPosition,
  getOpenOrders,
  cancelOrder,
  placeOrder,
  buyToClose,
  getRecentActivities,
  getOptionLatestQuote,
} from "./alpaca.js";
import { findPutToSell, findCallToSell } from "./options.js";
import { getStockLatestPrice } from "./alpaca.js";
import { WheelState, saveState } from "./state.js";

const PROFIT_CLOSE_THRESHOLD = 0.50; // close early at 50% profit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks if an active option contract has hit the 50% profit threshold.
 * Returns the current mid price if threshold is hit, null otherwise.
 */
async function check50PctProfit(
  contractSymbol: string,
  entryPremium: number
): Promise<number | null> {
  const quote = await getOptionLatestQuote(contractSymbol);
  if (!quote) return null;

  const profitPct = (entryPremium - quote.mid) / entryPremium;
  console.log(
    `[wheel] Profit check: entry=$${entryPremium.toFixed(2)} | current=$${quote.mid.toFixed(2)} | ` +
      `profit=${(profitPct * 100).toFixed(1)}%`
  );

  if (profitPct >= PROFIT_CLOSE_THRESHOLD) {
    console.log(`[wheel] 50% profit threshold reached. Will close early.`);
    return quote.mid;
  }
  return null;
}

/**
 * Checks account activities for option assignments since the given date.
 * Returns true if a put assignment (receiving shares) is found.
 */
async function detectAssignment(symbol: string, since: Date): Promise<boolean> {
  // OPASN = option assignment NTA (correct Alpaca code)
  // OPTRD = the corresponding underlying share trade (buy of shares on put assignment)
  const activities = await getRecentActivities(["OPASN", "OPTRD"], since);
  for (const act of activities) {
    const desc = (act.description ?? "").toLowerCase();
    const actSymbol = act.symbol ?? "";
    if (
      actSymbol === symbol ||
      actSymbol.startsWith(symbol) ||
      desc.includes(symbol.toLowerCase())
    ) {
      console.log(`[wheel] Assignment detected: ${JSON.stringify(act)}`);
      return true;
    }
  }
  return false;
}

/**
 * Checks if shares of the underlying were called away (sold due to call assignment).
 */
async function detectCallAway(symbol: string, since: Date): Promise<boolean> {
  // OPASN on a call + OPTRD with negative qty = shares sold (called away)
  const activities = await getRecentActivities(["OPASN", "OPTRD"], since);
  for (const act of activities) {
    const desc = (act.description ?? "").toLowerCase();
    const actSymbol = act.symbol ?? "";
    if (
      (actSymbol === symbol || actSymbol.startsWith(symbol) || desc.includes(symbol.toLowerCase())) &&
      (act.side === "sell" || desc.includes("call") || desc.includes("assigned"))
    ) {
      console.log(`[wheel] Call-away detected: ${JSON.stringify(act)}`);
      return true;
    }
  }
  return false;
}

/**
 * Cancels any open orders for the given symbol to avoid double-selling.
 */
async function cancelOpenOrdersForSymbol(symbol: string): Promise<void> {
  const orders = await getOpenOrders();
  for (const order of orders) {
    if (order.symbol === symbol || order.symbol.startsWith(symbol)) {
      console.log(`[wheel] Cancelling open order ${order.id} for ${order.symbol}`);
      await cancelOrder(order.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 1: SELL_PUTS
// ---------------------------------------------------------------------------

export async function runSellPuts(state: WheelState, symbol: string): Promise<void> {
  console.log(`[wheel] Running SELL_PUTS stage for ${symbol}`);

  // -------------------------------------------------------------------------
  // Check if we already have an open put position
  // -------------------------------------------------------------------------
  if (state.active_contract) {
    const position = await getPosition(state.active_contract);

    if (position) {
      // We have an active position — check for 50% profit
      const currentMid = await check50PctProfit(state.active_contract, state.entry_premium);

      if (currentMid !== null) {
        // Close early (buy-to-close)
        console.log(`[wheel] Closing put early: ${state.active_contract}`);
        try {
          await cancelOpenOrdersForSymbol(state.active_contract);
          const closeOrder = await buyToClose(state.active_contract, state.entry_premium);
          console.log(`[wheel] Buy-to-close order placed: ${closeOrder.id}`);

          // Credit the premium profit to total
          const premiumProfit = state.entry_premium - currentMid;
          state.total_premium_collected += premiumProfit;
          state.active_contract = null;
          state.active_order_id = null;
          state.entry_premium = 0;
          saveState(state);
          console.log(`[wheel] Put closed early. Premium profit: $${(premiumProfit * 100).toFixed(2)}`);

          // Sell a new put immediately
          await sellNewPut(state, symbol);
        } catch (err) {
          console.error(`[wheel] Error closing put early: ${err}`);
        }
      } else {
        console.log(`[wheel] Holding put position. No action needed.`);
      }
      return;
    } else {
      // Position no longer exists — could be: order pending fill, expired worthless, or assigned

      // First check: is there still an open/pending order for this contract?
      // If so, the sell hasn't filled yet — just wait.
      const openOrders = await getOpenOrders();
      const pendingOrder = openOrders.find((o) => o.symbol === state.active_contract);
      if (pendingOrder) {
        console.log(
          `[wheel] Sell order for ${state.active_contract} is still pending (status: ${pendingOrder.status}). Waiting for fill.`
        );
        return;
      }

      // No position AND no open order — either expired worthless or was assigned
      console.log(`[wheel] Active contract position gone: ${state.active_contract}`);

      // Check if we were assigned
      const lastRunDate = new Date(state.last_run);
      const assigned = await detectAssignment(symbol, lastRunDate);

      if (assigned) {
        await handlePutAssignment(state, symbol);
      } else {
        // Expired worthless — pocket the full premium
        console.log(`[wheel] Put expired worthless. Full premium collected.`);
        state.total_premium_collected += state.entry_premium;
        state.active_contract = null;
        state.active_order_id = null;
        state.entry_premium = 0;
        saveState(state);

        // Sell a new put
        await sellNewPut(state, symbol);
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Check for a recent assignment even if state lost track of the contract
  // -------------------------------------------------------------------------
  const positions = await getPositions();
  const stockPosition = positions.find(
    (p) => p.symbol === symbol && p.asset_class === "us_equity"
  );
  if (stockPosition && parseInt(stockPosition.qty) >= 100) {
    console.log(`[wheel] Found stock position without active_contract. Transitioning to SELL_CALLS.`);
    const avgEntry = parseFloat(stockPosition.avg_entry_price);
    state.stage = "SELL_CALLS";
    state.cost_basis = avgEntry;
    state.shares_qty = parseInt(stockPosition.qty);
    state.active_contract = null;
    state.entry_premium = 0;
    saveState(state);
    await runSellCalls(state, symbol);
    return;
  }

  // No active position — sell a new put
  await sellNewPut(state, symbol);
}

async function sellNewPut(state: WheelState, symbol: string): Promise<void> {
  // Safety check: ensure we have enough cash
  const account = await getAccount();
  const cash = parseFloat(account.cash);

  const currentPrice = await getStockLatestPrice(symbol);
  const requiredCash = currentPrice * 0.90 * 100; // strike * 100 shares

  if (cash < requiredCash) {
    console.warn(
      `[wheel] Insufficient cash: have ${cash.toFixed(2)}, need ~${requiredCash.toFixed(2)}. Skipping.`
    );
    return;
  }

  const selected = await findPutToSell(symbol, currentPrice);
  if (!selected) {
    console.warn(`[wheel] No suitable put contract found. Will retry next cycle.`);
    return;
  }

  // Cancel any existing open orders before placing a new one
  await cancelOpenOrdersForSymbol(symbol);

  const order = await placeOrder({
    symbol: selected.contract.symbol,
    qty: 1,
    side: "sell",
    type: "limit",
    time_in_force: "day",
    limit_price: selected.limitPrice,
  });

  console.log(
    `[wheel] SELL PUT order placed: ${selected.contract.symbol} | ` +
      `limit=$${selected.limitPrice} | order_id=${order.id}`
  );

  state.active_contract = selected.contract.symbol;
  state.active_order_id = order.id;
  state.entry_premium = selected.limitPrice;
  saveState(state);
}

async function handlePutAssignment(state: WheelState, symbol: string): Promise<void> {
  console.log(`[wheel] Put assigned on ${state.active_contract}. Transitioning to SELL_CALLS.`);

  // The cost basis is the put strike price, reduced by the premium we collected
  const contractSymbol = state.active_contract!;
  // Parse strike from OCC symbol: e.g. TSLA260417P00245000 → 245.00
  const strikeStr = contractSymbol.match(/[PC](\d{8})$/)?.[1];
  const strike = strikeStr ? parseInt(strikeStr, 10) / 1000 : 0;

  // Cost basis = strike - total premium collected this cycle (net debit)
  const costBasis = strike - state.entry_premium;

  state.stage = "SELL_CALLS";
  state.cost_basis = costBasis;
  state.shares_qty = 100;
  state.total_premium_collected += state.entry_premium; // premium was already earned
  state.active_contract = null;
  state.active_order_id = null;
  state.entry_premium = 0;
  saveState(state);

  console.log(
    `[wheel] Assigned. Strike=$${strike} | Premium earned=$${state.entry_premium.toFixed(2)} | ` +
      `Cost basis=$${costBasis.toFixed(2)}`
  );

  await runSellCalls(state, symbol);
}

// ---------------------------------------------------------------------------
// Stage 2: SELL_CALLS
// ---------------------------------------------------------------------------

export async function runSellCalls(state: WheelState, symbol: string): Promise<void> {
  console.log(`[wheel] Running SELL_CALLS stage for ${symbol}`);

  if (state.cost_basis === null) {
    console.error(`[wheel] SELL_CALLS stage but cost_basis is null. Resetting to SELL_PUTS.`);
    state.stage = "SELL_PUTS";
    saveState(state);
    return;
  }

  // -------------------------------------------------------------------------
  // Verify we still hold the shares
  // -------------------------------------------------------------------------
  const positions = await getPositions();
  const stockPos = positions.find(
    (p) => p.symbol === symbol && p.asset_class === "us_equity"
  );
  const sharesHeld = stockPos ? parseInt(stockPos.qty) : 0;

  if (sharesHeld < 100) {
    // Shares were called away (or something unexpected happened)
    console.log(
      `[wheel] Shares no longer held (found ${sharesHeld}). ` +
        `Assuming call assignment. Transitioning to SELL_PUTS.`
    );

    // Credit any remaining open contract premium if we had one
    if (state.active_contract && state.entry_premium > 0) {
      state.total_premium_collected += state.entry_premium;
    }

    state.stage = "SELL_PUTS";
    state.cost_basis = null;
    state.shares_qty = 0;
    state.active_contract = null;
    state.active_order_id = null;
    state.entry_premium = 0;
    state.cycles_completed += 1;
    saveState(state);

    console.log(`[wheel] Cycle ${state.cycles_completed} complete! Back to SELL_PUTS.`);
    await runSellPuts(state, symbol);
    return;
  }

  // -------------------------------------------------------------------------
  // Check active call position
  // -------------------------------------------------------------------------
  if (state.active_contract) {
    const position = await getPosition(state.active_contract);

    if (position) {
      // Check for 50% profit
      const currentMid = await check50PctProfit(state.active_contract, state.entry_premium);

      if (currentMid !== null) {
        console.log(`[wheel] Closing call early: ${state.active_contract}`);
        try {
          await cancelOpenOrdersForSymbol(state.active_contract);
          const closeOrder = await buyToClose(state.active_contract, state.entry_premium);
          console.log(`[wheel] Buy-to-close order placed: ${closeOrder.id}`);

          const premiumProfit = state.entry_premium - currentMid;
          state.total_premium_collected += premiumProfit;
          state.active_contract = null;
          state.active_order_id = null;
          state.entry_premium = 0;
          saveState(state);
          console.log(`[wheel] Call closed early. Premium profit: $${(premiumProfit * 100).toFixed(2)}`);

          // Sell a new call
          await sellNewCall(state, symbol);
        } catch (err) {
          console.error(`[wheel] Error closing call early: ${err}`);
        }
      } else {
        console.log(`[wheel] Holding call position. No action needed.`);
      }
      return;
    } else {
      // Call position gone — check for pending order first
      const openOrders = await getOpenOrders();
      const pendingOrder = openOrders.find((o) => o.symbol === state.active_contract);
      if (pendingOrder) {
        console.log(
          `[wheel] Sell order for ${state.active_contract} is still pending (status: ${pendingOrder.status}). Waiting for fill.`
        );
        return;
      }

      // No position AND no open order — expired worthless or shares called away
      console.log(`[wheel] Active call position gone: ${state.active_contract}`);

      const lastRunDate = new Date(state.last_run);
      const calledAway = await detectCallAway(symbol, lastRunDate);

      if (calledAway || sharesHeld < 100) {
        // Shares were called away
        console.log(`[wheel] Shares called away. Completing cycle.`);
        state.total_premium_collected += state.entry_premium;
        state.stage = "SELL_PUTS";
        state.cost_basis = null;
        state.shares_qty = 0;
        state.active_contract = null;
        state.active_order_id = null;
        state.entry_premium = 0;
        state.cycles_completed += 1;
        saveState(state);
        console.log(`[wheel] Cycle ${state.cycles_completed} complete! Back to SELL_PUTS.`);
        await runSellPuts(state, symbol);
      } else {
        // Call expired worthless — sell a new one
        console.log(`[wheel] Call expired worthless. Full premium collected.`);
        state.total_premium_collected += state.entry_premium;
        state.active_contract = null;
        state.active_order_id = null;
        state.entry_premium = 0;
        saveState(state);
        await sellNewCall(state, symbol);
      }
      return;
    }
  }

  // No active call — sell one
  await sellNewCall(state, symbol);
}

async function sellNewCall(state: WheelState, symbol: string): Promise<void> {
  if (state.cost_basis === null) {
    console.error(`[wheel] Cannot sell call: cost_basis is null.`);
    return;
  }

  const selected = await findCallToSell(symbol, state.cost_basis);
  if (!selected) {
    console.warn(`[wheel] No suitable call contract found. Will retry next cycle.`);
    return;
  }

  await cancelOpenOrdersForSymbol(symbol);

  const order = await placeOrder({
    symbol: selected.contract.symbol,
    qty: 1,
    side: "sell",
    type: "limit",
    time_in_force: "day",
    limit_price: selected.limitPrice,
  });

  console.log(
    `[wheel] SELL CALL order placed: ${selected.contract.symbol} | ` +
      `limit=$${selected.limitPrice} | order_id=${order.id}`
  );

  state.active_contract = selected.contract.symbol;
  state.active_order_id = order.id;
  state.entry_premium = selected.limitPrice;
  saveState(state);
}
