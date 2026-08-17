# Production runbook

Operator procedures for production gates. Product rules: [product-requirements.md](../product-requirements.md). Venue: [binance-usdtm.md](../binance-usdtm.md). Risk: [risk-policy.md](../risk-policy.md). Soak: [testing.md](../testing.md#soak-test-24-72-hours).

Defaults stay **testnet** and **dry-run**. This software can place real futures orders and can lose money.

## API key and IP allowlist

Confirm in the Binance UI before any live-capital start. The USDT-M adapter does not query these permissions.

- Futures trading **on**
- Withdrawal **off**
- IP allowlist **on** (only the hosts this process uses)
- Production key **≠** testnet key
- `.env` is gitignored; do not commit or log the key, secret, signature, or auth headers

Record the attestation when running the production checklist (`evaluateProductionChecklist`).

## Production confirmation

Production REST/WS hosts are `https://fapi.binance.com` and `wss://fstream.binance.com`. Custom URLs are testnet-only.

`APP_ENV=production` is **not** a venue switch. `BINANCE_TESTNET=false` is **not** confirmation.

Live production requires all of:

1. `BINANCE_TESTNET=false` in the environment
2. CLI `--confirm-production` (not an environment variable; `.env.example` cannot set it)
3. Not `--dry-run` and not `--read-only` if the process should place orders

```bash
bun run start --strategy guardian --symbol BTCUSDT --dry-run --testnet
bun run start --strategy guardian --symbol BTCUSDT --read-only --testnet
```

`bun run start` fail-fasts if production hosts would be used without `--confirm-production`, then logs the resolved mode (`venue`, `dryRun`, `readOnly`, `placeOrders`). `--read-only` and default dry-run place no orders.

## Backup kill switch

In-process kill switch modes (`KILL_SWITCH_MODE`): `CANCEL_ONLY` or `CANCEL_AND_FLATTEN`. See [risk-policy.md](../risk-policy.md#kill-switch).

Backup path: **SIGINT** or **SIGTERM** engages that same kill switch (owned entry cancels; flatten only when the mode is `CANCEL_AND_FLATTEN` and slippage allows). Neither mode may cancel orders the bot does not own. Do not use symbol-wide `cancelAllOrders`.

CLI shutdown relatives:

- `--cancel-only` — cancel bot-owned orders; do not flatten
- `--flatten-on-exit` — flatten using the kill-switch flatten path

Do not set both.

## Metrics alerts

Structured logs emit the metrics list in [product-requirements.md](../product-requirements.md#metrics-to-emit). Alert events include `feed_stale`, `rate_limit`, `ws_disconnected`, `reconciliation_mismatch`, `kill_switch`, and `unprotected_position`. Forbidden in logs: API key, secret, signature, authorization header, full raw private responses.

## Before live capital

Every item in [definition of done](../product-requirements.md#definition-of-done) must be true, including testnet soak 24–72 hours with no orphan orders. Until then the bot is not production-ready.
