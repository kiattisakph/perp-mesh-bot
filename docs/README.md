# Documentation index

This folder is the working documentation for PerpMesh Bot. Each topic has **one** authoritative file. Other files link here instead of restating the same rules.

The original behavioral specification is [reference/binance-usdtm-strategy-reimplementation.md](reference/binance-usdtm-strategy-reimplementation.md). **Do not edit or delete it.** Use it when a split doc is silent. If the spec is also silent, write `TBD` and ask the owner — do not invent a requirement.

## Reading order

1. [../AGENTS.md](../AGENTS.md) (agents) or [../README.md](../README.md) (humans)
2. [product-requirements.md](product-requirements.md)
3. [architecture.md](architecture.md) and [domain-model.md](domain-model.md)
4. [binance-usdtm.md](binance-usdtm.md) and [risk-policy.md](risk-policy.md)
5. The strategy you are changing under [strategies/](strategies/)
6. [testing.md](testing.md) and [implementation-roadmap.md](implementation-roadmap.md)
7. [../.env.example](../.env.example) for names and units
8. The [reference spec](reference/binance-usdtm-strategy-reimplementation.md) for unresolved wording

## Authoritative sources

| Topic | Authoritative file |
|---|---|
| Product identity, goals, non-goals, definition of done | [product-requirements.md](product-requirements.md) |
| Layers, dependency direction, lifecycles, order ownership, directories | [architecture.md](architecture.md) |
| Types, canonical units, state transitions, domain invariants | [domain-model.md](domain-model.md) |
| Binance REST/WS, precision, modes, endpoints, clock, testnet | [binance-usdtm.md](binance-usdtm.md) |
| Position/notional limits, stops, slippage, stale feeds, 429, kill switch | [risk-policy.md](risk-policy.md) |
| Test kinds, soak, production readiness gates | [testing.md](testing.md) |
| Build phases and completion criteria | [implementation-roadmap.md](implementation-roadmap.md) |
| Guardian | [strategies/guardian.md](strategies/guardian.md) |
| Trend | [strategies/trend.md](strategies/trend.md) |
| Swing | [strategies/swing.md](strategies/swing.md) |
| Maker, Offset Maker, Liquidity Maker | [strategies/maker-family.md](strategies/maker-family.md) |
| v1 venue decision | [decisions/001-binance-usdtm-first.md](decisions/001-binance-usdtm-first.md) |
| No license file | [decisions/002-no-license.md](decisions/002-no-license.md) |
| Environment variable names and units | [../.env.example](../.env.example) |
| Session rules for AI agents | [../AGENTS.md](../AGENTS.md) |
| Human onboarding | [../README.md](../README.md) |
| Production start, API key, kill switch | [runbooks/production.md](runbooks/production.md) |
| Behavioral specification (Thai) | [reference/binance-usdtm-strategy-reimplementation.md](reference/binance-usdtm-strategy-reimplementation.md) |

Official Binance API behavior is defined by [Binance USDT-M docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info). [binance-usdtm.md](binance-usdtm.md) records how this bot uses those APIs.

## Other trees in this repo

| Path | Role |
|---|---|
| [binance/](binance/) | Snapshots of official Binance developer docs. Not product scope. Re-check the live docs at implementation time. |
| [swingtrading/](swingtrading/) | Legacy Swing notes. They describe Spot `ETHBTC` signal sources. **v1 does not follow that automatically.** Authoritative Swing behavior is [strategies/swing.md](strategies/swing.md). |
| [exchanges/](exchanges/) | Legacy multi-market Binance notes (Spot, sandbox URLs, basis symbols). **Not v1 scope.** Authoritative venue rules are [binance-usdtm.md](binance-usdtm.md) and [decisions/001-binance-usdtm-first.md](decisions/001-binance-usdtm-first.md). |

## Terminology

Canonical names live in [domain-model.md](domain-model.md). Use those names in code and docs: *order intent*, *bot-owned order*, *reduce-only*, *strategy snapshot*, *degraded*, *paused*, *kill switch*.
