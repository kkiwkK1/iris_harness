# System plugin extraction — implementation and acceptance

Architecture: `docs/SYSTEM-PLUGINS.md`.

Status: implementation in progress. No completion claims yet.

## Delivery ownership

| Workstream | Implementation owner | Scope |
| --- | --- | --- |
| A | GPT-5.6-Sol / Nash | Host runtime, protocol and control plane |
| B | GPT-5.6-Sol / Meitner | Tavern Helper and MVU capability extraction, frame lifetimes |
| C | GPT-5.6-Sol / Ohm | Plugin center, browser state and fake transport |
| Architecture and acceptance | Parent task | Contracts, dependency decisions, integration review, gates and preview |

All implementation workers edit disjoint paths on `dev/system-plugins` in the
isolated `iris-system-plugins` worktree. The coordinator owns commits and PRs.

## Results

Pending integrated implementation and verification.
