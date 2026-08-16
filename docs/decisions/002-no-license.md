# ADR 002 — No license file

- Status: Accepted
- Date: 2026-08-16

This repository has **no `LICENSE` file** and will not add one unless a later ADR supersedes this decision.

## Context

The behavioral spec recommended adding a license at repository setup because the origin bot has no root `LICENSE`. The product owner decided otherwise: **no license**.

Implementation must still be written from this repo's spec and official Binance docs. Origin source, adapters, and native binaries must not be copied.

This is not legal advice.

## Decision

- Do not add `LICENSE` at the repo root.
- Do not add a `license` field to `package.json` in v1.
- Do not treat “license chosen and present” as a definition-of-done item.

## Consequences

- Phase 1 repository setup does not include a license file.
- Agents and developers must not create a `LICENSE` to “complete” the spec’s original recommendation.
- The copy-from-spec constraint is unchanged: new code only; origin implementation stays out.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Follow the spec and add a license in Phase 1 | Owner decided no license |
| Pick MIT/Apache/proprietary later in Phase 1 | Same decision: none for now |
