---
"@nerima-games/mx-redstone": minor
---

Keep a target block powered after a projectile hit, as vanilla does. A host reports a hit with the new `RedstoneWorldRuntimeService.hitTarget(dimension, position, hit)`. `TargetHit` gains an optional `projectile` (`TargetProjectile`: `'arrow'`, `'trident'` or `'other'`) that the host chooses; a hit without it counts as `'other'`, so existing `targetSignal` callers are unaffected. A hit holds the target for 10 redstone ticks (20 game ticks) for an arrow or trident and 4 redstone ticks (8 game ticks) otherwise, at the signal strength of the first hit. A hit while the target is still held changes neither the strength nor the release, as in vanilla's `TargetBlock`. A target that nothing has hit keeps the `active` and `emits` the host declares.

Public type changes: `hitTarget` is a new required member of `RedstoneWorldRuntimeService`, so a hand-written implementation of that service must add it; `targetHoldTicks`, `TargetProjectile` and `TargetTimer` are new exports; `TimedCircuitState.targets`, `TimedCircuitWithBlockPower.targets`, `RedstoneCellTimers.target` and `RedstoneWorldState.pendingTargetHits` are new fields.
