/**
 * A block, named but never inspected.
 *
 * PLACEHOLDER for mc-kernel's block identity, and flagged as one so it does not
 * quietly become an institution — the same call, and the same reasoning, as
 * `domain/position-key.ts`.
 *
 * ---------------------------------------------------------------------------
 * Why this moved out of `domain/piston.ts`
 * ---------------------------------------------------------------------------
 *
 * It was declared there because pistons were the only rule that had to name a
 * block. The observer is the second (`domain/observer.ts` compares the block in
 * the cell it watches), and the alternative to moving it was a second alias with
 * a different name for the same missing type. That precise failure is recorded
 * upstream: mc-sim's `domain/inventory.ts` opens with the story of `ItemId`
 * being invented three times, in mc-sim, mc-playground-kit and mx-ui, for one
 * type kernel had not yet published. One placeholder, one file.
 *
 * `domain/piston.ts` re-exports the name, so nothing downstream moved.
 *
 * ---------------------------------------------------------------------------
 * It is a STRING here and a NUMBER in kernel
 * ---------------------------------------------------------------------------
 *
 * mc-kernel publishes `BlockId = number & Brand.Brand<'BlockId'>`
 * (`domain/block-registry.ts:220`) — a dense index, because that is what a chunk
 * stores and what `ChunkStoreApi.getBlock` returns
 * (`mc-worldgen/application/chunk-store.ts:142`). This alias is a string, which
 * costs nothing today because NOTHING in this repository inspects the value: a
 * piston asks a capability lookup, an observer asks whether two of them are
 * equal, and both work over an opaque token.
 *
 * The seam is recorded rather than closed because closing it means depending on
 * kernel, and this repository declares no `@nerima-games/*` dependency yet
 * (docs/responsibility.md §3, 現状). When it does, this file is deleted and the
 * two call sites take `BlockId`. Equality is the only operation either performs,
 * and it survives the change of representation.
 */
export type BlockRef = string
