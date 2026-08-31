---
"@nerima-games/mx-redstone": patch
---

Align pinned `@nerima-games/*` dependency versions with the current org release set: `mc-kernel` 0.5.1 -> 0.7.0, `mc-sim` 0.1.39 -> 0.4.1, `mc-worldgen` 0.1.14 -> 0.3.1. No source change: `mc-sim` and `mc-worldgen` are declared dependencies this package does not yet import from, and the one `mc-kernel` surface this package consumes (`blockIdOf`, `capabilityOfBlockId`, `isBlockType`, the `pistonImmovable` capability flag) is unchanged in shape and behavior across the jump.
