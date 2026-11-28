---
"@nerima-games/mx-redstone": minor
---

Delay a lit redstone lamp's switch-off by two redstone ticks (four game ticks) after it loses power, as vanilla does. The `lit: true` transition is still emitted in the tick power arrives, and a lamp that is removed from the snapshot is still reported unlit at once. Hosts see the `lit: false` `LampTransition` two redstone ticks later than before, and see none if the lamp is powered again when the delay expires.
