---
"@nerima-games/mx-redstone": minor
---

Open and close both halves of a door when either half is powered, as vanilla does. When a host passes a door's packed state, `componentForBlock` now sets the new optional snapshot field `otherHalf` (the cell above a lower half or below an upper half), and the runtime emits the same `powered` transition for both halves when power reaches either one. A door without packed state, or whose `otherHalf` cell is not in the snapshot, follows its own power as before.

Public type changes: `RedstoneComponentSnapshot` gains the optional `otherHalf`. No required member is added.
