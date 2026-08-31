# @nerima-games/mx-redstone

## 0.3.0

### Minor Changes

- [#14](https://github.com/nerima-games/mx-redstone/pull/14) [`719e88a`](https://github.com/nerima-games/mx-redstone/commit/719e88aca7a34f389043d653cf47344020450cc8) Thanks [@takeokunn](https://github.com/takeokunn)! - Add the redstone host boundary: componentForBlock (the component roster this package always owned), kernelPistonCapabilities, and a host Port (lookup + write) with snapshot-in / events-out helpers, so a host runs redstone without reimplementing the per-tick sync-run-drain loop.

- [#14](https://github.com/nerima-games/mx-redstone/pull/14) [`719e88a`](https://github.com/nerima-games/mx-redstone/commit/719e88aca7a34f389043d653cf47344020450cc8) Thanks [@takeokunn](https://github.com/takeokunn)! - Add the host boundary this repository's stages cross: `src/application/redstone-host-port.ts` exports `RedstoneHostRealm`/`RedstoneHostLookup`/`RedstoneHostWritePort`/`RedstoneHostBlock`, `redstoneSnapshotFromRealm`, `applyRedstoneHostEvents`, `componentForBlock`, and `kernelPistonCapabilities`. A host implements the Port against its own block-world state instead of reimplementing block classification and drain-event dispatch itself.

### Patch Changes

- [#13](https://github.com/nerima-games/mx-redstone/pull/13) [`2af2ea5`](https://github.com/nerima-games/mx-redstone/commit/2af2ea565bb15c641fbe2b80d13c84dcc68100f9) Thanks [@takeokunn](https://github.com/takeokunn)! - Complete the org toolchain devDependency pin set: knip 6.33.0 (its verify gate arrives in Wave 3; the pin belongs to the Wave 0 table) plus @effect/vitest 0.30.0 where it was missing.

## 0.2.8

### Patch Changes

- [#11](https://github.com/nerima-games/mx-redstone/pull/11) [`088378b`](https://github.com/nerima-games/mx-redstone/commit/088378be7aa72ce66d408135dd58ea6d66c74009) Thanks [@takeokunn](https://github.com/takeokunn)! - Toolchain frozen to org pin set (TypeScript 7.0.2, vitest 4.1.11, effect 3.22.1, node 24, pnpm 11.24.0); build switched to tsc emit; release workflow added

## 0.2.1

### Patch Changes

- Remove lint regressions introduced by the torch burnout implementation without changing its behavior or API.

## 0.2.0

### Minor Changes

- Model vanilla redstone torch burnout and cooldown in the deterministic timed circuit API.

- [#1](https://github.com/nerima-games/mx-redstone/pull/1) [`c04345f`](https://github.com/nerima-games/mx-redstone/commit/c04345fd45e3aeccd8b4f6d13e07617995519df0) Thanks [@takeokunn](https://github.com/takeokunn)! - Declare `@nerima-games/mc-kernel`, `@nerima-games/mc-sim` and `@nerima-games/mc-worldgen` as
  `dependencies`, matching the parents this repository's `docs/architecture.md` has always
  declared (Tier3, `redstone -> sim`, `redstone -> worldgen`, plus the universally-importable
  `mc-kernel`). Until now `package.json#dependencies` listed only `effect`, a drift between the
  declared and the packaged dependency graph tracked by `DEPENDENCY_POLICY.md` §4. All three
  packages are now published, so the declaration is also installable.

  This is a packaging correction, not a behavioural change: no source in `src/` imports any of
  these packages yet (`domain/frame-contract.ts` and `domain/position-key.ts` remain provisional
  local stand-ins for `mc-kernel` until this repository actually repoints its imports).

### Patch Changes

- [`a494cfb`](https://github.com/nerima-games/mx-redstone/commit/a494cfb8cf0bd87b68f9f8fc4f3dcda609c1066a) Thanks [@takeokunn](https://github.com/takeokunn)! - Correct the documented wire signal boundary and pin cyclic propagation and piston isolation with regression tests.

- [`4681323`](https://github.com/nerima-games/mx-redstone/commit/46813233c37d2b2136a378b3f149217c7c74c2de) Thanks [@takeokunn](https://github.com/takeokunn)! - Add directional piston extension plans, sticky retraction, atomic application, and powered runtime transitions.
