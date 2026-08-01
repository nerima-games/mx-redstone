# @nerima-games/mx-redstone

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
