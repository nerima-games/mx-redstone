---
"@nerima-games/mx-redstone": minor
---

Delay a dispenser's and a dropper's `RedstoneTriggerEvent` by two redstone ticks (four game ticks) after the rising edge that powers it, as vanilla does. The event is emitted even if power is lost before it is due, and its `facing` is read from the snapshot of the tick it fires in. Note-block triggers are still emitted in the tick power arrives. Hosts therefore see `dispenser` and `dropper` trigger events two redstone ticks later than before, and a host that syncs a snapshot without the block in between sees none.
