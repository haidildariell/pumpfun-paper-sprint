// Pump.fun Paper Sprint — early-momentum paper trader.
//
// Idea: pump.fun coins mostly die fast, but the ones that catch a bid early
// tend to run hard for a short while. So this bot buys a coin only while it
// is still young, only after it has already shown real buying (price up from
// its first print plus genuine buy volume), in a small fixed stake, and it
// gets out fast: take profit, trailing stop once it has run, hard stop loss,
// and a time stop so no dead coin is held to the end of the window.
//
// Every decision is a pure function of the event stream the harness sends
// per batch: no clock, no randomness, no network. Two runs on the same data
// therefore produce the same orders, slot for slot.
import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

const SOL = 1_000_000_000n;
const STAKE = 100_000_000n; // 0.10 SOL per entry: small stakes, the winners pay for the losers
const MIN_STAKE = 20_000_000n; // 0.02 SOL: below this the size cap makes the trade pointless
const CASH_BUFFER = 50_000_000n; // keep 0.05 SOL spare so exits can always pay tx fees
const MAX_POSITIONS = 5;
const MAX_BUYS_PER_BATCH = 3;

// Entry filter: BREAKOUT, not early momentum. The first three versions proved
// buying the early rise loses: the +5-25% tick is mostly noise and the coin
// dumps after. So now only a coin that has already doubled on real money
// counts: price 2x+ off its first print, still at its high, buy volume
// dominating, and at least 5 SOL of real reserves actually in the curve.
const MIN_TRADES = 10;
const MIN_BUY_VOL = 4_000_000_000n; // 4 SOL of buys seen
const MIN_REAL_SOL = 4_000_000_000n; // 4 SOL of real reserves: genuine money in
const BUY_DOMINANCE = 1.5; // buy volume at least 1.5x sell volume: real demand, not churn
const MOMENTUM_MIN = 1.8; // up 80%: a proven runner, entered a touch earlier
const MOMENTUM_MAX = 6.0; // never chase more than 6x off the first print
const NEAR_PEAK = 0.9; // price within 10% of its peak: still making highs
const MAX_AGE_SLOTS = 9000; // roughly the first hour of a coin's life

// Exits: cut losers very fast, trail only after doubling from entry so a
// whipsaw does not shake out the run to completion.
const TAKE_PROFIT = 10.0; // +900%: a moonbag cap only, the trail usually sells first
const TRAIL_TRIGGER = 2.0; // once doubled from entry, trail the peak
const TRAIL_DROP = 0.8; // sell when price falls 20% off its peak: ride runners longer
const STOP_LOSS = 0.92; // -8%: out very fast, no hoping
const MAX_HOLD_SLOTS = 12000; // about 80 minutes: runners get time to run

interface Coin {
  mint: string;
  createdSlot: number;
  firstPrice: number;
  peakPrice: number;
  buyVol: bigint;
  sellVol: bigint;
  complete: boolean;
  entrySlot: number; // -1 while not held
  entryPrice: number;
  peakSinceEntry: number;
}

const coins = new Map<string, Coin>();
const done = new Set<string>(); // mints already round-tripped: one trade each, spread wide

function priceOf(vq: bigint, vt: bigint): number {
  if (vq <= 0n || vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

function trackCoin(state: BotState, mint: string): Coin | null {
  const curve = state.curves.get(mint);
  if (!curve) return null;
  let coin = coins.get(mint);
  const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  if (!coin) {
    if (price <= 0) return null;
    coin = {
      mint,
      createdSlot: curve.created_slot ?? state.slot,
      firstPrice: price,
      peakPrice: price,
      buyVol: 0n,
      sellVol: 0n,
      complete: curve.complete,
      entrySlot: -1,
      entryPrice: 0,
      peakSinceEntry: 0,
    };
    coins.set(mint, coin);
  }
  coin.complete = curve.complete;
  if (price > 0) {
    if (price > coin.peakPrice) coin.peakPrice = price;
    if (coin.entrySlot >= 0 && price > coin.peakSinceEntry) coin.peakSinceEntry = price;
  }
  return coin;
}

function onBatch(state: BotState, batch: Batch) {
  const orders: { side: "buy" | "sell"; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];

  // 1. Fold this batch's fills in: record entries, retire exits.
  for (const fill of batch.fills) {
    if (fill.status !== "filled") continue;
    const coin = trackCoin(state, fill.mint);
    if (!coin) continue;
    if (fill.side === "buy") {
      const curve = state.curves.get(fill.mint);
      const price = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
      coin.entrySlot = state.slot;
      coin.entryPrice = price > 0 ? price : coin.firstPrice;
      coin.peakSinceEntry = coin.entryPrice;
    } else {
      coin.entrySlot = -1;
      coin.entryPrice = 0;
      coin.peakSinceEntry = 0;
      done.add(fill.mint);
    }
  }

  // 2. Fold this batch's events in: buy volume and fresh curves.
  for (const event of batch.events) {
    if (event.event === "TradeEvent") {
      const coin = trackCoin(state, event.mint);
      if (coin) {
        if (event.is_buy) coin.buyVol += BigInt(event.sol_amount);
        else coin.sellVol += BigInt(event.sol_amount);
      }
    } else {
      trackCoin(state, event.mint);
    }
  }
  // Refresh every curve we know, so exits use the latest mark even on a
  // batch with no trade on that mint.
  for (const mint of state.curves.keys()) trackCoin(state, mint);

  // 3. Exits first: a slot spent exiting is worth more than a new entry.
  for (const [mint, holding] of state.positions) {
    const coin = coins.get(mint);
    const curve = state.curves.get(mint);
    if (!coin || !curve || coin.entrySlot < 0 || coin.entryPrice <= 0) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0) continue;
    const multiple = price / coin.entryPrice;
    const agedOut = state.slot - coin.entrySlot >= MAX_HOLD_SLOTS;
    const tookProfit = multiple >= TAKE_PROFIT;
    const trailedOff =
      coin.peakSinceEntry >= coin.entryPrice * TRAIL_TRIGGER && price <= coin.peakSinceEntry * TRAIL_DROP;
    const stoppedOut = multiple <= STOP_LOSS;
    if (tookProfit || trailedOff || stoppedOut || agedOut) {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: 500,
      });
    }
  }

  // 4. Entries: young, bought-up, rising coins, one small stake each.
  if (state.committedPositionCount() < MAX_POSITIONS) {
    let buys = 0;
    for (const coin of coins.values()) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (state.committedPositionCount() + buys >= MAX_POSITIONS) break;
      if (coin.complete || done.has(coin.mint)) continue;
      if (state.positions.has(coin.mint)) continue;
      if (coin.entrySlot >= 0) continue;
      if (state.slot - coin.createdSlot > MAX_AGE_SLOTS) continue;
      const curve = state.curves.get(coin.mint);
      if (!curve || curve.trades < MIN_TRADES) continue;
      if (coin.buyVol < MIN_BUY_VOL) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      if (coin.buyVol < BigInt(Math.floor(BUY_DOMINANCE * Number(coin.sellVol)))) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price < coin.peakPrice * NEAR_PEAK) continue; // already dumped off its high
      const momentum = price / coin.firstPrice;
      if (momentum < MOMENTUM_MIN || momentum > MOMENTUM_MAX) continue;
      const cap = state.maxBuyLamports(coin.mint);
      if (cap < MIN_STAKE) continue;
      let stake = STAKE < cap ? STAKE : cap;
      const free = state.freeCashLamports() - CASH_BUFFER;
      if (free < MIN_STAKE) break;
      if (stake > free) stake = free;
      if (stake < MIN_STAKE) continue;
      // Skip a mint that already has a buy in flight: one stake per coin.
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === "buy" && p.order.mint === coin.mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      orders.push({ side: "buy", mint: coin.mint, quote_lamports: stake, max_slippage_bps: 500 });
      buys++;
    }
  }

  return orders;
}

await runBot({ onBatch });
