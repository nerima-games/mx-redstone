import {
  BlockPositionSchema,
  DimensionIdSchema,
  type BlockPosition,
} from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import {
  circuitBoardFromSnapshots,
  redstoneNodeId,
  type RedstoneComponentSnapshot,
} from '../../src/application/world-runtime'
import type { CircuitBoard } from '../../src/domain/power-graph'

type DimensionId = Schema.Schema.Type<typeof DimensionIdSchema>
type RedstoneNodeId = ReturnType<typeof redstoneNodeId>
type RedstoneBoard3dComponent = Omit<RedstoneComponentSnapshot, 'position'>

export type RedstoneBoard3dCell = {
  readonly component: RedstoneBoard3dComponent
  readonly dimension: string
  readonly position: BlockPosition
}

export const redstonePosition3d = (x: number, y: number, z: number): BlockPosition =>
  Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

export const redstoneNodeId3d = (dimension: string, position: BlockPosition): RedstoneNodeId =>
  redstoneNodeId(Schema.decodeUnknownSync(DimensionIdSchema)(dimension), position)

/** Builds adjacency from dimension-tagged coordinates using the runtime's six-face topology. */
export const redstoneBoard3d = (cells: ReadonlyArray<RedstoneBoard3dCell>): CircuitBoard => {
  const dimensions = new Map<DimensionId, Map<RedstoneNodeId, RedstoneComponentSnapshot>>()

  for (const { component, dimension: rawDimension, position } of cells) {
    const dimension = Schema.decodeUnknownSync(DimensionIdSchema)(rawDimension)
    const components = new Map(dimensions.get(dimension) ?? [])
    components.set(redstoneNodeId(dimension, position), { ...component, position })
    dimensions.set(dimension, components)
  }

  return circuitBoardFromSnapshots(dimensions)
}
