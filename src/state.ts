import fs from "fs";
import path from "path";

export type Stage = "SELL_PUTS" | "SELL_CALLS";

export interface WheelState {
  stage: Stage;
  // The OCC symbol of the currently open option contract (e.g. "TSLA260417P00245000")
  active_contract: string | null;
  // The Alpaca order ID that opened the current position
  active_order_id: string | null;
  // Premium per share received when we opened the current contract
  entry_premium: number;
  // Cost basis per share of the underlying stock (after being assigned)
  cost_basis: number | null;
  // Number of shares held (0 when in SELL_PUTS stage)
  shares_qty: number;
  // Cumulative net premium collected across all cycles (per share)
  total_premium_collected: number;
  // Number of full wheel cycles completed (put assigned → call called away)
  cycles_completed: number;
  // ISO timestamp of the last cron run
  last_run: string;
  // Prevents the daily summary from printing more than once per day
  daily_summary_sent: string | null; // ISO date string "YYYY-MM-DD" or null
}

// STATE_DIR can be overridden via env var — used on Railway where a persistent
// volume is mounted at /data so state survives between cron invocations.
const STATE_DIR = process.env.STATE_DIR ?? process.cwd();
const STATE_FILE = path.join(STATE_DIR, "state.json");

const DEFAULT_STATE: WheelState = {
  stage: "SELL_PUTS",
  active_contract: null,
  active_order_id: null,
  entry_premium: 0,
  cost_basis: null,
  shares_qty: 0,
  total_premium_collected: 0,
  cycles_completed: 0,
  last_run: new Date().toISOString(),
  daily_summary_sent: null,
};

export function loadState(): WheelState {
  // Ensure the state directory exists (first run on a fresh Railway volume)
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  if (!fs.existsSync(STATE_FILE)) {
    console.log("[state] No state.json found — initializing fresh state.");
    saveState(DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
  const raw = fs.readFileSync(STATE_FILE, "utf-8");
  const parsed = JSON.parse(raw) as Partial<WheelState>;
  // Merge with defaults to handle any missing keys from old versions
  return { ...DEFAULT_STATE, ...parsed };
}

export function saveState(state: WheelState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}
