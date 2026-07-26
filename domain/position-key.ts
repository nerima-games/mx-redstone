/**
 * A world position rendered as a map/set key.
 *
 * PLACEHOLDER, and flagged as one so it does not quietly become an institution.
 * Kernel owns `Position` and will own its key encoding (plan.md §3.1); this
 * repository must not invent a second coordinate vocabulary. Until kernel is
 * published, the work queues here are generic over opaque strings — which is
 * honest, because nothing in `falling-block.ts` or `fluid-frontier.ts` actually
 * inspects the geometry. They schedule; they do not navigate.
 *
 * Deliberately NOT branded. A brand would let this module masquerade as the
 * owner of the concept, and a downstream repository would end up converting
 * between `mx-gameplay`'s key and kernel's. An unbranded alias reads as what it
 * is: a stand-in with a deletion date.
 */
export type PositionKey = string
