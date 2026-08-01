---
"@nerima-games/mx-redstone": minor
---

Declare `@nerima-games/mc-kernel`, `@nerima-games/mc-sim` and `@nerima-games/mc-worldgen` as
`dependencies`, matching the parents this repository's `docs/architecture.md` has always
declared (Tier3, `redstone -> sim`, `redstone -> worldgen`, plus the universally-importable
`mc-kernel`). Until now `package.json#dependencies` listed only `effect`, a drift between the
declared and the packaged dependency graph tracked by `DEPENDENCY_POLICY.md` §4. All three
packages are now published, so the declaration is also installable.

This is a packaging correction, not a behavioural change: no source in `src/` imports any of
these packages yet (`domain/frame-contract.ts` and `domain/position-key.ts` remain provisional
local stand-ins for `mc-kernel` until this repository actually repoints its imports).
