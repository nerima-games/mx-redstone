---
"@nerima-games/mx-redstone": minor
---

Add the host boundary this repository's stages cross: `src/application/redstone-host-port.ts` exports `RedstoneHostRealm`/`RedstoneHostLookup`/`RedstoneHostWritePort`/`RedstoneHostBlock`, `redstoneSnapshotFromRealm`, `applyRedstoneHostEvents`, `componentForBlock`, and `kernelPistonCapabilities`. A host implements the Port against its own block-world state instead of reimplementing block classification and drain-event dispatch itself.
