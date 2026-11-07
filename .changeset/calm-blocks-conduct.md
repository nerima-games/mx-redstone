---
"@nerima-games/mx-redstone": patch
---

Add optional solid-block redstone conduction support. `RedstoneHostBlock.strongPowerTo` carries lever and button attachment positions into component snapshots. The optional `RedstoneHostLookup.isButtonActive` callback defaults to inactive when omitted. Hosts must provide `strongPowerTo` on applicable host blocks and pass the `isRedstoneConductiveAt` callback to `syncSnapshot` to enable conduction; omitting either keeps the existing behavior for that path.
