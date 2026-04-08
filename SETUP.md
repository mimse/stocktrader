## Wheel Bot — Cron Setup

### 1. Install the cron job

Open a terminal and run:

```bash
crontab -e
```

Add this line (runs every 15 minutes, Mon–Fri, all hours — the bot itself gates on market hours in ET):

```
*/15 * * * 1-5 cd /Users/movh/Projects/stocktrader && /Users/movh/.nvm/versions/node/v24.14.0/bin/npx tsx src/index.ts >> /Users/movh/Projects/stocktrader/logs/wheel.log 2>&1
```

> **Important:** cron on macOS runs in your system's local timezone. The bot uses `America/New_York` internally to decide if the market is open — so it works correctly regardless of your system timezone.

### 2. Verify the cron is installed

```bash
crontab -l
```

### 3. Watch the logs

```bash
tail -f /Users/movh/Projects/stocktrader/logs/wheel.log
```

### 4. Run manually (any time, for testing)

```bash
cd /Users/movh/Projects/stocktrader
npm start
```

If the market is closed, it will exit immediately and log "Market is closed."

### 5. State file

The bot's state is stored in `state.json` at the project root. You can inspect it at any time:

```bash
cat /Users/movh/Projects/stocktrader/state.json
```

### 6. Reset the bot

To start a fresh wheel cycle (e.g. after manual intervention), delete `state.json`:

```bash
rm /Users/movh/Projects/stocktrader/state.json
```

The bot will recreate it on the next run.

---

## How the bot works

| Cron run | What happens |
|---|---|
| Market closed | Exit immediately |
| Stage: SELL_PUTS, no position | Find TSLA put ~10% OTM, 2–4 weeks out → sell 1 contract (limit at mid) |
| Stage: SELL_PUTS, position exists | Check if 50% profit hit → close early + sell new; else hold |
| Stage: SELL_PUTS, assigned | Detect via account activities → transition to SELL_CALLS |
| Stage: SELL_CALLS, no position | Find TSLA call ~10% above cost basis → sell 1 contract |
| Stage: SELL_CALLS, position exists | Check 50% profit → close early + sell new; else hold |
| Stage: SELL_CALLS, shares called away | Transition back to SELL_PUTS, increment cycle counter |
| 15:45–16:00 ET | Print daily summary to log |

## Safety rules enforced

- Never sells a put without cash >= strike × 100
- Never sells a call with strike below cost basis
- Cancels any open orders before placing a new one
- Does nothing outside NYSE market hours
