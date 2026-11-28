---
"@nerima-games/mx-redstone": minor
---

Time a pressure plate the way vanilla does when the host reports who stands on it. A host sets the new optional snapshot fields `plate` (`'wooden'`, `'stone'`, `'light-weighted'` or `'heavy-weighted'`) and `occupants` (`living` and `other` entity counts, non-negative integers). An idle plate powers on the tick an occupant arrives. A powered plate then ignores arrivals and departures until its re-check, which comes every 10 redstone ticks (20 game ticks) for a wooden or stone plate and every 5 (10 game ticks) for a weighted plate. The re-check counts again: someone still there keeps the plate powered and a weighted plate takes the new strength, and nobody there releases it. A stone plate counts living entities only; the other kinds count every entity. A plate without `plate` keeps the `active` and `emits` the host declares, so existing snapshots are unaffected.

Public type changes: no required member is added. `PressurePlateKind`, `PlateOccupants`, `OccupantCount`, `plateOccupantSignal`, `plateCheckTicks` and `PlateTimer` are new exports; `RedstoneComponentSnapshot` and `Component` gain the optional `plate` and `occupants`; `TimedCircuitState.plates`, `TimedCircuitWithBlockPower.plates` and `RedstoneCellTimers.plate` are new fields.
