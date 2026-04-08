import { toZonedTime } from "date-fns-tz";

const ET_TIMEZONE = "America/New_York";

// NYSE holidays for 2025 and 2026 (YYYY-MM-DD in ET)
// Update this list annually or replace with a proper holiday API
const NYSE_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Day
  "2025-02-17", // Presidents' Day
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

/**
 * Returns the current time in Eastern Time as a Date object.
 */
export function nowET(): Date {
  return toZonedTime(new Date(), ET_TIMEZONE);
}

/**
 * Returns true if the US stock market (NYSE) is currently open.
 * Market hours: Monday–Friday, 09:30–16:00 ET, excluding holidays.
 */
export function isMarketOpen(): boolean {
  const now = nowET();
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const dateStr = formatDateET(now);
  if (NYSE_HOLIDAYS.has(dateStr)) return false;

  const hour = now.getHours();
  const minute = now.getMinutes();
  const minutesSinceMidnight = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30;   // 09:30
  const marketClose = 16 * 60;       // 16:00

  return minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose;
}

/**
 * Returns true if it's the daily summary window: 15:45–16:00 ET on a trading day.
 * This is checked once per cron run to print the EOD summary.
 */
export function isSummaryWindow(): boolean {
  const now = nowET();
  const dayOfWeek = now.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const dateStr = formatDateET(now);
  if (NYSE_HOLIDAYS.has(dateStr)) return false;

  const hour = now.getHours();
  const minute = now.getMinutes();
  const minutesSinceMidnight = hour * 60 + minute;

  const summaryStart = 15 * 60 + 45; // 15:45
  const summaryEnd = 16 * 60;         // 16:00

  return minutesSinceMidnight >= summaryStart && minutesSinceMidnight < summaryEnd;
}

/**
 * Returns today's date as "YYYY-MM-DD" in Eastern Time.
 */
export function todayET(): string {
  return formatDateET(nowET());
}

function formatDateET(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns a human-readable timestamp string in ET.
 */
export function timestampET(): string {
  const d = nowET();
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
