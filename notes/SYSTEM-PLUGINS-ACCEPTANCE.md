# System plugin extraction — implementation and acceptance

> 状态：记录。测量于 2026-09-15，对象 Iris `main` `2eccf30`（PR #88）；本文是交付归属记录，逐项证据在两份验收记录里。记录不随代码更新；Iris 侧的现状以 `docs/` 为准（索引见 `notes/README.md`）。

Architecture: `docs/SYSTEM-PLUGINS.md`.

Status (2026-09-15): landed on `main` as `2eccf30` (PR #88, "Add the system
plugin platform and ST extension pilot"). This file is the *delivery ownership*
record for the extraction workstreams; the results are not kept here. The
acceptance records are
[插件平台联合验收](PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md) — host runtime,
dynamic RPC, `/plugins` assets, member merge, stale-revision isolation — and
[ST 试点验收报告](st-compat/PILOT-REPORT.md) — the ST extension pilot's
UC-1/2/3, revision isolation, fault isolation, uninstall, and the ST 1.18.0
comparison. The interface surface as it stands on main, and what is still
missing, are in
[docs/INFRASTRUCTURE-INTERFACES.md](../docs/INFRASTRUCTURE-INTERFACES.md) §8.

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

Integrated, verified and merged. Both acceptance rounds passed; see the two
records linked above for the per-check evidence. The live list of what is
implemented and what is not is maintained in
[docs/INFRASTRUCTURE-INTERFACES.md](../docs/INFRASTRUCTURE-INTERFACES.md) §8,
not here — this file is not updated per release.
