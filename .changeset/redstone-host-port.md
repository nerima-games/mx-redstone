---
"@nerima-games/mx-redstone": minor
---

Add the redstone host boundary: componentForBlock (the component roster this package always owned), kernelPistonCapabilities, and a host Port (lookup + write) with snapshot-in / events-out helpers, so a host runs redstone without reimplementing the per-tick sync-run-drain loop.
