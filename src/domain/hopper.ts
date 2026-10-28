/**
 * The hopper: the one component that power SWITCHES OFF.
 *
 * Every other component in this repository does something when power arrives. A
 * hopper does something all the time and STOPS when power arrives — a powered
 * hopper is locked, and vanilla item filters are built out of exactly that
 * inversion. It is the only place in the redstone rules where `powered` reads as
 * "no", and a reader who assumes the usual direction writes a filter that is
 * open when it should be shut.
 *
 * That inversion and the ordered endpoint/slot candidates are what this package
 * owns about a hopper. Redstone supplies the hopper and adjacent container
 * addresses; mc-sim decides item compatibility, moves one item, advances cooldown,
 * and commits the item and block write. The boundary is precise rather than pending
 * — see the bottom of this file.
 *
 * ---------------------------------------------------------------------------
 * HopperService owns transfer timing and cooldown state
 * ---------------------------------------------------------------------------
 *
 * The runtime passes elapsed redstone ticks and the current powered state to
 * HopperService. That service decides whether a hopper is locked, cooling down,
 * or ready to transfer. This module selects ordered endpoint candidates and
 * keeps no transfer-period counter.
 *
 * The reference models neither lock nor cooldown. Its
 * `redstone-hopper-world-effects.ts:11-14` opens with 「Vanilla hoppers keep an
 * internal buffer; this model transfers directly」 and moves everything within
 * reach on every frame — no lock, no period, and no mention of either. A hopper
 * that ignores its lock is not a slow hopper; it is a hopper that cannot be used
 * as a filter, and every sorting machine in the game is a filter.
 */
import {
  type BlockAddress,
  BlockAddressSchema,
} from '@nerima-games/mc-kernel'
import {
  type ContainerKind,
  type HopperEndpoint,
  containerCapacity,
} from '@nerima-games/mc-sim'
import { Result, Schema as schema } from 'effect'

const schemaLiteral = schema.Literal
const schemaLiterals = schema.Literals
const schemaNonEmptyArray = schema.NonEmptyArray
const schemaStruct = schema.Struct
const schemaUnion = schema.Union

export const GAME_TICKS_PER_REDSTONE_TICK = 2
const FIRST_SLOT_INDEX = 0
const SLOT_INDEX_STEP = 1


/**
 * How many items move per transfer. One, in vanilla, and it matters: see below.
 */
export const HOPPER_TRANSFER_ITEMS = 1

/**
 * A powered hopper is LOCKED.
 *
 * A one-line function for a one-line rule, and it earns the line by being the
 * only place the inversion is written down. The alternative is `if (!powered)`
 * scattered across the effects stage, where the missing `!` is invisible to a
 * reader who knows how every other component behaves.
 */
export const isHopperLocked = (powered: boolean): boolean => powered

export type HopperAdjacentContainer = Readonly<{
  address: BlockAddress
  kind: ContainerKind
}>

export type HopperTransferSelectionRequest = Readonly<{
  powered: boolean
  hopperAddress: BlockAddress
  sourceAbove: HopperAdjacentContainer | null
  destinationFacing: HopperAdjacentContainer | null
}>

export type HopperContainerEndpoint = Extract<HopperEndpoint, { readonly _tag: 'Container' }>

const containerEndpoint = (address: BlockAddress, slot: number): HopperContainerEndpoint => ({
  _tag: 'Container',
  address,
  slot,
})

export type HopperTransferDirection = 'push' | 'pull'

export type HopperTransferCandidate = Readonly<{
  direction: HopperTransferDirection
  source: HopperContainerEndpoint
  destination: HopperContainerEndpoint
}>

const ContainerKindSchema: schema.Codec<ContainerKind, unknown> = schemaLiterals([
  'chest',
  'shulker_box',
  'dispenser',
  'dropper',
  'hopper',
])

const HopperAdjacentContainerSchema: schema.Codec<HopperAdjacentContainer, unknown> = schemaStruct({
  address: BlockAddressSchema,
  kind: ContainerKindSchema,
})

export const HopperTransferSelectionRequestSchema: schema.Codec<
  HopperTransferSelectionRequest,
  unknown
> = schemaStruct({
  destinationFacing: schemaUnion([HopperAdjacentContainerSchema, schema.Null]),
  hopperAddress: BlockAddressSchema,
  powered: schema.Boolean,
  sourceAbove: schemaUnion([HopperAdjacentContainerSchema, schema.Null]),
})

const HopperContainerEndpointSchema: schema.Codec<HopperContainerEndpoint, unknown> = schemaStruct({
  _tag: schemaLiteral('Container'),
  address: BlockAddressSchema,
  slot: schema.Number.check(schema.isInt(), schema.isGreaterThanOrEqualTo(FIRST_SLOT_INDEX)),
})

export const HopperTransferCandidateSchema: schema.Codec<HopperTransferCandidate, unknown> =
  schemaStruct({
    destination: HopperContainerEndpointSchema,
    direction: schemaLiterals(['push', 'pull']),
    source: HopperContainerEndpointSchema,
  })

export type HopperTransferSelectionOutcome =
  | Readonly<{ _tag: 'InvalidRequest' }>
  | Readonly<{ _tag: 'Locked' }>
  | Readonly<{ _tag: 'NoCandidates' }>
  | Readonly<{
      _tag: 'Candidates'
      candidates: readonly [HopperTransferCandidate, ...Array<HopperTransferCandidate>]
    }>

export const HopperTransferSelectionOutcomeSchema: schema.Codec<
  HopperTransferSelectionOutcome,
  unknown
> = schemaUnion([
  schemaStruct({
    _tag: schemaLiteral('InvalidRequest'),
  }),
  schemaStruct({
    _tag: schemaLiteral('Locked'),
  }),
  schemaStruct({
    _tag: schemaLiteral('NoCandidates'),
  }),
  schemaStruct({
    _tag: schemaLiteral('Candidates'),
    candidates: schemaNonEmptyArray(HopperTransferCandidateSchema),
  }),
])

type HopperCandidatePairOptions = Readonly<{
  direction: HopperTransferCandidate['direction']
  sourceAddress: BlockAddress
  sourceCapacity: number
  destinationAddress: BlockAddress
  destinationCapacity: number
}>

const appendCandidatePairs = (
  candidates: Array<HopperTransferCandidate>,
  options: HopperCandidatePairOptions,
): void => {
  for (
    let sourceSlot = FIRST_SLOT_INDEX;
    sourceSlot < options.sourceCapacity;
    sourceSlot += SLOT_INDEX_STEP
  ) {
    for (
      let destinationSlot = FIRST_SLOT_INDEX;
      destinationSlot < options.destinationCapacity;
      destinationSlot += SLOT_INDEX_STEP
    ) {
      candidates.push({
        destination: containerEndpoint(options.destinationAddress, destinationSlot),
        direction: options.direction,
        source: containerEndpoint(options.sourceAddress, sourceSlot),
      })
    }
  }
}

const getTransferCandidates = (
  options: HopperTransferSelectionRequest,
): Array<HopperTransferCandidate> => {
  const candidates: Array<HopperTransferCandidate> = []
  const hopperCapacity = containerCapacity('hopper')

  if (options.destinationFacing !== null) {
    appendCandidatePairs(candidates, {
      destinationAddress: options.destinationFacing.address,
      destinationCapacity: containerCapacity(options.destinationFacing.kind),
      direction: 'push',
      sourceAddress: options.hopperAddress,
      sourceCapacity: hopperCapacity,
    })
  }

  if (options.sourceAbove !== null) {
    appendCandidatePairs(candidates, {
      destinationAddress: options.hopperAddress,
      destinationCapacity: hopperCapacity,
      direction: 'pull',
      sourceAddress: options.sourceAbove.address,
      sourceCapacity: containerCapacity(options.sourceAbove.kind),
    })
  }

  return candidates
}

const selectTransferCandidatesForRequest = (
  options: HopperTransferSelectionRequest,
): HopperTransferSelectionOutcome => {
  if (isHopperLocked(options.powered)) {
    return { _tag: 'Locked' }
  }

  const candidates = getTransferCandidates(options)
  const [first, ...remaining] = candidates
  if (!first) {
    return { _tag: 'NoCandidates' }
  }

  return {
    _tag: 'Candidates',
    candidates: [first, ...remaining],
  }
}

/**
 * Select ordered endpoint and slot pairs for one HopperService transfer attempt.
 * Adjacent addresses and facing are resolved by the caller; sim decides whether a
 * pair is compatible and commits the item and block write atomically.
 */
export const selectHopperTransferCandidates = (input: unknown): HopperTransferSelectionOutcome => {
  const decoded = schema.decodeUnknownResult(HopperTransferSelectionRequestSchema, {
    onExcessProperty: 'error',
  })(input)
  if (Result.isFailure(decoded)) {
    return { _tag: 'InvalidRequest' }
  }

  return selectTransferCandidatesForRequest(decoded.success)
}

/*
 * ---------------------------------------------------------------------------
 * BOUNDARY: the transfer itself
 * ---------------------------------------------------------------------------
 *
 * The prior boundary was only about when and whether: `HopperService` and
 * `ContainerStorageService` now own the transfer contracts that were missing
 * when it was written. `HopperTransferRequest` takes the hopper address, source
 * and destination endpoints, and required block-write batch. The endpoints and
 * slots are caller-selected, so this module enumerates them push-before-pull in
 * stable slot order. It does not inspect stored items or reproduce stack
 * compatibility. The host tries each pair with `HopperService.planTransferTick`;
 * HopperService uses ContainerStorageService and returns a fragment containing
 * the item change, cooldown state, and hopper block edit for the shared batch commit.
 *
 * The host passes timing and power to `HopperService.planTransferTick`, which
 * owns cooldown advancement and transfer eligibility.
 *
 * `HOPPER_TRANSFER_ITEMS` is here rather than at the call site for the reason
 * `PISTON_PUSH_LIMIT` is: it is a RULE about how a hopper behaves, not a fact
 * about what an item is. The sim contract moves one item per successful transfer.
 */
