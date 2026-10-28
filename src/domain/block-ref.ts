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
 * (`mc-worldgen/application/chunk-store.ts:142`). This alias is a string. Domain
 * planners treat it as an opaque token: pistons ask a capability lookup and
 * observers compare references for equality. The host adapter is the boundary
 * that recognizes registered block types and resolves them to a numeric id.
 *
 * mx-redstone now depends on mc-kernel. This seam remains intentional: domain
 * rules use named block references, while the host adapter checks whether a
 * string is a registered block type and resolves it to `BlockId` for the kernel
 * capability lookup. The planners treat `BlockRef` as opaque; changing that
 * domain input to the registry's numeric id would be a separate API change.
 * Equality is the only operation the domain rules perform on it.
 */
export type BlockRef = string
