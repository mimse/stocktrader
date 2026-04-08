import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlpacaAccount {
  id: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  options_approved_level: number;
  options_trading_level: number;
}

export interface AlpacaPosition {
  symbol: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  cost_basis: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  status: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  limit_price: string | null;
  created_at: string;
}

export interface AlpacaOptionContract {
  id: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  expiration_date: string;
  root_symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  style: string;
  strike_price: string;
  size: string;
  open_interest: string | null;
  open_interest_date: string | null;
  close_price: string | null;
  close_price_date: string | null;
}

export interface AlpacaOptionSnapshot {
  latestQuote: {
    ap: number; // ask price
    bp: number; // bid price
    as: number; // ask size
    bs: number; // bid size
  };
  latestTrade: {
    p: number; // price
    s: number; // size
  } | null;
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  } | null;
  impliedVolatility: number | null;
}

export interface AlpacaActivity {
  id: string;
  activity_type: string; // "FILL", "PTC", "OPEXP", "OPASSIGN", etc.
  date: string;
  symbol?: string;
  qty?: string;
  price?: string;
  side?: string;
  description?: string;
  transaction_time?: string;
  net_amount?: string;
}

export interface LatestQuote {
  bid: number;
  ask: number;
  mid: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function makeClient(baseURL: string): AxiosInstance {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) {
    throw new Error("ALPACA_KEY and ALPACA_SECRET must be set in .env");
  }
  return axios.create({
    baseURL,
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
}

const tradingClient = makeClient(
  process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets/v2"
);
// Data API uses different path prefixes per resource type, so we use the root host
const dataClient = makeClient(
  process.env.ALPACA_DATA_URL ?? "https://data.alpaca.markets"
);

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export async function getAccount(): Promise<AlpacaAccount> {
  const res = await tradingClient.get<AlpacaAccount>("/account");
  return res.data;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export async function getPositions(): Promise<AlpacaPosition[]> {
  const res = await tradingClient.get<AlpacaPosition[]>("/positions");
  return res.data;
}

export async function getPosition(symbol: string): Promise<AlpacaPosition | null> {
  try {
    const res = await tradingClient.get<AlpacaPosition>(`/positions/${encodeURIComponent(symbol)}`);
    return res.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

// Close an entire position (buy-to-close or sell-to-close)
export async function closePosition(symbol: string): Promise<AlpacaOrder> {
  const res = await tradingClient.delete<AlpacaOrder>(`/positions/${encodeURIComponent(symbol)}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function getOpenOrders(): Promise<AlpacaOrder[]> {
  const res = await tradingClient.get<AlpacaOrder[]>("/orders", {
    params: { status: "open", limit: 100 },
  });
  return res.data;
}

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  const res = await tradingClient.get<AlpacaOrder>(`/orders/${orderId}`);
  return res.data;
}

export async function cancelOrder(orderId: string): Promise<void> {
  await tradingClient.delete(`/orders/${orderId}`);
}

export interface PlaceOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit";
  time_in_force: "day" | "gtc";
  limit_price?: number;
}

export async function placeOrder(params: PlaceOrderParams): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    qty: String(params.qty),
    side: params.side,
    type: params.type,
    time_in_force: params.time_in_force,
  };
  if (params.limit_price !== undefined) {
    body["limit_price"] = params.limit_price.toFixed(2);
  }
  const res = await tradingClient.post<AlpacaOrder>("/orders", body);
  return res.data;
}

// Buy-to-close an option at 50% of entry premium (limit order)
export async function buyToClose(
  contractSymbol: string,
  entryPremium: number
): Promise<AlpacaOrder> {
  const closePrice = parseFloat((entryPremium * 0.50).toFixed(2));
  return placeOrder({
    symbol: contractSymbol,
    qty: 1,
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: closePrice,
  });
}

// ---------------------------------------------------------------------------
// Option Contracts
// ---------------------------------------------------------------------------

export async function getOptionContracts(params: {
  underlying_symbol: string;
  type?: "put" | "call";
  expiration_date_gte?: string; // YYYY-MM-DD
  expiration_date_lte?: string; // YYYY-MM-DD
  strike_price_gte?: number;
  strike_price_lte?: number;
  limit?: number;
}): Promise<AlpacaOptionContract[]> {
  const query: Record<string, string | number> = {
    underlying_symbols: params.underlying_symbol,
    limit: params.limit ?? 200,
  };
  if (params.type) query["type"] = params.type;
  if (params.expiration_date_gte) query["expiration_date_gte"] = params.expiration_date_gte;
  if (params.expiration_date_lte) query["expiration_date_lte"] = params.expiration_date_lte;
  if (params.strike_price_gte !== undefined) query["strike_price_gte"] = params.strike_price_gte;
  if (params.strike_price_lte !== undefined) query["strike_price_lte"] = params.strike_price_lte;

  const res = await tradingClient.get<{ option_contracts: AlpacaOptionContract[] }>(
    "/options/contracts",
    { params: query }
  );
  return res.data.option_contracts ?? [];
}

// ---------------------------------------------------------------------------
// Market Data — Stock
// ---------------------------------------------------------------------------

export async function getStockLatestPrice(symbol: string): Promise<number> {
  const res = await dataClient.get<{
    quotes: Record<string, { ap: number; bp: number }>;
  }>(`/v2/stocks/quotes/latest`, {
    params: { symbols: symbol, feed: "iex" },
  });
  const quote = res.data.quotes[symbol];
  if (!quote) throw new Error(`No quote found for ${symbol}`);
  // Use midpoint of bid/ask as the "current price"
  return (quote.ap + quote.bp) / 2;
}

// ---------------------------------------------------------------------------
// Market Data — Options
// ---------------------------------------------------------------------------

export async function getOptionSnapshot(
  contractSymbol: string
): Promise<AlpacaOptionSnapshot | null> {
  try {
    const res = await dataClient.get<{
      snapshots: Record<string, AlpacaOptionSnapshot>;
    }>(`/v1beta1/options/snapshots`, {
      params: { symbols: contractSymbol, feed: "indicative" },
    });
    return res.data.snapshots[contractSymbol] ?? null;
  } catch {
    return null;
  }
}

export async function getOptionLatestQuote(contractSymbol: string): Promise<LatestQuote | null> {
  const snapshot = await getOptionSnapshot(contractSymbol);
  if (!snapshot) return null;
  const { ap, bp } = snapshot.latestQuote;
  if (ap <= 0 && bp <= 0) return null;
  const mid = (ap + bp) / 2;
  return { bid: bp, ask: ap, mid };
}

// ---------------------------------------------------------------------------
// Account Activities — detect assignments and expirations
// ---------------------------------------------------------------------------

export async function getRecentActivities(
  activityTypes: string[],
  since?: Date
): Promise<AlpacaActivity[]> {
  // Use category=non_trade_activity for NTA types, or individual type paths
  // to avoid the comma-separated list 422 bug on some types.
  // We fetch each type individually and merge results.
  const results: AlpacaActivity[] = [];
  for (const type of activityTypes) {
    const params: Record<string, string> = {
      direction: "desc",
      page_size: "100",
    };
    if (since) {
      params["after"] = since.toISOString();
    }
    try {
      const res = await tradingClient.get<AlpacaActivity[]>(
        `/account/activities/${type}`,
        { params }
      );
      results.push(...(res.data ?? []));
    } catch {
      // If a type isn't supported or returns an error, skip it silently
    }
  }
  return results;
}
