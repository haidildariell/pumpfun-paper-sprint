# Pump.fun Paper Sprint — Breakout Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/haidildariell/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/haidildariell/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint bounty](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. One program, `main.ts` (Node 22), trading pump.fun bonding curves on a replayed window.

## Strategy

Breakout, not early momentum. Buying the first small rise loses — the early tick is mostly noise and the coin dumps after. So this bot only buys a coin that has already proven itself:

- price up 80%+ off its first print, still within 10% of its own peak (still making highs),
- buy volume dominating sell volume (1.5x) with at least 4 SOL of buys seen,
- at least 4 SOL of real reserves actually in the curve,
- still in roughly its first hour of life.

Entries are small fixed stakes of 0.10 SOL, at most 5 open positions. Exits do the work: a tight -10% stop-loss, a trailing stop once the position has doubled (sell 25% off the peak), a moonbag cap at +900%, and an ~80-minute time stop so dead money gets recycled. One round trip per coin, spread wide to clear the 20-coin guardrail.

Every decision is a pure function of the event stream per batch — no clock, no randomness, no network — so two runs on the same data produce identical orders.

## Files

- `main.ts` — the strategy.
- `vendor/makefun-bot.ts` — the kit's official SDK shim (vendored as instructed by the kit).

## Local grade (dev window)

- Net PnL: -1.185 SOL, 217 fills over 109 coins, win rate 12.8%, max drawdown 0.128 — guardrails met.
- Stress (20 rebuilt copies of the dev window): median -0.87 SOL, p10 -1.16, p90 -0.11; dev score sits near the median, not above it, so the score is not leaning on this window's particular coins — but 19 of 20 copies lost money, so this is a mildly negative-expectation strategy on dev data whose final-window outcome rides on catching a runner.
- Earlier variants: early-momentum buys lost -4.7 to -6.6 SOL with drawdown over 0.5; the breakout filter cut the loss to about a quarter of that and the drawdown to 0.13.
