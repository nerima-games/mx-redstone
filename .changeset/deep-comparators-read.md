---
"@nerima-games/mx-redstone": minor
---

Let a comparator read a container through a block that conducts redstone, as vanilla does. When the block directly behind a comparator is not a container and the host's `RedstoneHostLookup.isRedstoneConductiveAt` says it conducts, `componentForBlock` and `redstoneSnapshotFromRealm` now read the container one block further back through `readContainerSlots`; `inputFrom` stays on the block directly behind. A host that does not supply `isRedstoneConductiveAt` sees no change. Vanilla reads through only when that block carries less than 15 power, and this snapshot step cannot know that, so a block carrying 15 is also read through.

No public type changes.
