---
"@nerima-games/mx-redstone": patch
---

Renamed `domain/timed-power-graph.ts` and `test/timed-power-graph.test.ts` to `domain/power-timing.ts` and `test/power-timing.test.ts` — no behaviour change, just the evidence path the cross-repo feature catalog's `redstone/repeater-and-sticky-piston` row has always declared for repeater delay and button pulse timing.

Fixed a latent mislabel found while renaming: the per-tick override `advanceTimedCircuit` builds for a resolved repeater was tagged `kind: 'observer'`. It produced the correct result today only because `power-graph.ts` happened to route an `active`-bearing observer and an `active`-bearing repeater through code that agreed on the number — a coincidence a future change to either path could have silently broken. The override is now tagged `'repeater'`, and `power-graph.ts` recognises an `active`-bearing repeater as pre-resolved rather than re-deriving its output from a rear input the override never carried.

Added coverage for two angles the existing suite did not reach: a non-clock timed circuit reaching a true fixed point (state stops changing under further ticks rather than drifting), and a repeater's delay holding at the exact redstone-tick count across several frame rates that do not divide the fixed tick length evenly — so a delay boundary landing mid-frame is exercised, not just one that lands on a tick.
