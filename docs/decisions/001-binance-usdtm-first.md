# ADR 001 — Binance USDT-M first

- Status: Accepted
- Date: 2026-08-16

v1 of PerpMesh Bot supports **Binance USDⓈ-M (USDT-M) Futures only**.

## Context

The behavioral specification is taken from an origin bot that spans Spot, several derivative venues, native signers, and extra strategies (Grid, Maker Points, Basis). This repository has no origin `LICENSE`, so implementation must be new.

The product owner wants a small, testable automated perp bot: six strategies, One-way Isolated, testnet-first, one strategy per account/symbol.

## Decision

v1 implements a single venue adapter: **Binance USDT-M Futures**.

- REST base (production): `https://fapi.binance.com`
- Public/user WS (production): `wss://fstream.binance.com`
- Position mode: One-way (`positionSide=BOTH`)
- Margin: Isolated
- Swing signals: USDT-M klines by default (`SWING_SIGNAL_MARKET=usdm`). Spot is not auto-enabled.

Other venues, Spot trading, Hedge Mode, and origin adapters are out of scope until a later ADR.

## Consequences

- Strategy policy and domain types stay venue-agnostic, but only one adapter is built.
- Precision, order types (`GTX`, `STOP_MARKET`, `TRAILING_STOP_MARKET`), listenKey, and rate limits follow Binance USDT-M docs.
- No multi-exchange router, no Spot RSI unless a future ADR adds an explicit signal-market implementation.
- Testnet vs production hosts are allowlisted; custom URLs are testnet-only.
- A second venue later is a new adapter plus contract tests, not a fork of strategy policy.

## Alternatives considered

| Alternative | Why not for v1 |
|---|---|
| Multi-exchange from day one | Multiplies adapter, precision, and failure surface before ownership/risk are proven |
| Binance Spot + USDT-M | Spec forbids automatic Spot in a futures-only product; basis and Spot Swing are non-goals |
| Hedge Mode | Spec forbids simultaneous LONG/SHORT; One-way signed quantity is the v1 position model |
| Port origin Binance adapter | Origin has no root LICENSE; adapters must be written from spec + official docs |
