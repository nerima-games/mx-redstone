# API lock — @nerima-games/mx-redstone

<!-- ------------------------------------------------------------------------- -->
<!-- GENERATED FILE. Do not edit by hand.                                      -->
<!--                                                                           -->
<!-- Regenerate with `pnpm api:update`. `pnpm api:check`, which `pnpm verify`  -->
<!-- runs, fails when this file is stale.                                      -->
<!--                                                                           -->
<!-- Every line below is part of the published surface of this package. A diff -->
<!-- here is a diff in what consumers can see, and is the thing plan.md §6     -->
<!-- Step 0-3 asks to be reviewed as a diff. See scripts/api-lock.ts for how   -->
<!-- it is produced and why it is produced this way.                           -->
<!-- ------------------------------------------------------------------------- -->

format: 1
exported declarations: 35
supporting declarations: 8

## Exported

### BlockCapabilityLookup  `type`

```ts
type BlockCapabilityLookup = {
    readonly pistonImmovable: (block: BlockRef) => boolean;
};
```

### BlockRef  `type`

```ts
type BlockRef = string;
```

### CircuitBoard  `type`

```ts
type CircuitBoard = {
    readonly components: ReadonlyMap<PositionKey, Component>;
    readonly adjacency: ReadonlyMap<PositionKey, ReadonlyArray<PositionKey>>;
};
```

### Component  `type`

```ts
type Component = {
    readonly kind: ComponentKind;
    readonly active?: boolean;
    readonly invertedBy?: PositionKey;
    readonly inputFrom?: PositionKey;
    readonly delayTicks?: number;
};
```

### ComponentKind  `type`

```ts
type ComponentKind = 'wire' | 'torch' | 'lever' | 'button' | 'repeater' | 'lamp';
```

### EXPERIENCE_MODULE_STAGE_PREFIXES  `const`

```ts
const EXPERIENCE_MODULE_STAGE_PREFIXES: readonly ["gameplay:", "redstone:", "ui:", "multiplayer:"];
```

### MAX_POWER_LEVEL  `const`

```ts
const MAX_POWER_LEVEL = 15;
```

### MAX_TICKS_PER_FRAME  `const`

```ts
const MAX_TICKS_PER_FRAME = 4;
```

### OWN_STAGE_PREFIX  `const`

```ts
const OWN_STAGE_PREFIX = "redstone:";
```

### PISTON_PUSH_LIMIT  `const`

```ts
const PISTON_PUSH_LIMIT = 12;
```

### PowerLevel  `type`

```ts
type PowerLevel = number;
```

### PowerMap  `type`

```ts
type PowerMap = ReadonlyMap<PositionKey, PowerLevel>;
```

### PushOutcome  `type`

```ts
type PushOutcome = {
    readonly kind: 'push';
    readonly plan: PushPlan;
} | {
    readonly kind: 'refused';
    readonly refusal: PushRefusal;
};
```

### PushPlan  `type`

```ts
type PushPlan = {
    readonly moved: ReadonlyArray<BlockRef>;
    readonly length: number;
};
```

### PushRefusal  `type`

```ts
type PushRefusal = {
    readonly reason: 'immovable' | 'too-long';
    readonly at: number;
};
```

### REDSTONE_STAGE_IDS  `const`

```ts
const REDSTONE_STAGE_IDS: {
    readonly power: StageId;
    readonly effects: StageId;
};
```

### REDSTONE_TICK_SECS  `const`

```ts
const REDSTONE_TICK_SECS = 0.1;
```

### RedstoneFrameState  `type`

```ts
type RedstoneFrameState = {
    readonly board: Ref.Ref<CircuitBoard>;
    readonly power: Ref.Ref<PowerMap>;
    readonly tickAccumulatorSecs: Ref.Ref<number>;
    readonly tickCount: Ref.Ref<number>;
};
```

### SETTLE_TICK_LIMIT  `const`

```ts
const SETTLE_TICK_LIMIT: number;
```

### SettleResult  `type`

```ts
type SettleResult = {
    readonly power: PowerMap;
    readonly ticks: number;
    readonly oscillating: boolean;
};
```

### UPSTREAM_STAGE_IDS  `const`

```ts
const UPSTREAM_STAGE_IDS: {
    readonly simPhysics: StageId;
};
```

### emptyCircuitBoard  `const`

```ts
const emptyCircuitBoard: CircuitBoard;
```

### emptyPowerMap  `const`

```ts
const emptyPowerMap: PowerMap;
```

### isLit  `const`

```ts
const isLit: (board: CircuitBoard, power: PowerMap, key: PositionKey) => boolean;
```

### isPistonMovable  `const`

```ts
const isPistonMovable: (capabilities: BlockCapabilityLookup, block: BlockRef) => boolean;
```

### makeRedstoneFrameState  `const`

```ts
const makeRedstoneFrameState: Effect.Effect<RedstoneFrameState>;
```

### makeRedstoneStages  `const`

```ts
const makeRedstoneStages: Effect.Effect<ReadonlyArray<StageRegistration>>;
```

### planPush  `const`

```ts
const planPush: (column: ReadonlyArray<BlockRef>, capabilities: BlockCapabilityLookup) => PushOutcome;
```

### powerAt  `const`

```ts
const powerAt: (map: PowerMap, key: PositionKey) => PowerLevel;
```

### propagateTick  `const`

```ts
const propagateTick: (board: CircuitBoard, previous: PowerMap) => PowerMap;
```

### redstoneModule  `const`

```ts
const redstoneModule: GameModule<never, never, never>;
```

### redstoneStages  `const`

```ts
const redstoneStages: (state: RedstoneFrameState) => ReadonlyArray<StageRegistration>;
```

### settle  `const`

```ts
const settle: (board: CircuitBoard, options?: {
    readonly from?: PowerMap;
    readonly limit?: number;
}) => SettleResult;
```

### sourcesOf  `const`

```ts
const sourcesOf: (board: CircuitBoard, previous: PowerMap) => PowerMap;
```

### ticksForFrame  `const`

```ts
const ticksForFrame: (accumulatedSecs: number, dt: number, options?: {
    readonly tickSecs?: number;
    readonly maxTicks?: number;
}) => {
    readonly ticks: number;
    readonly remainderSecs: number;
};
```

## Supporting declarations

Not exported from the barrel, but named by the signatures above, so a
consumer is exposed to them. `Context.Tag` service classes emit their real
type onto one of these.

### DeltaTimeSecs  `const`

```ts
const DeltaTimeSecs: Brand.Brand.Constructor<DeltaTimeSecs>;
```

### DeltaTimeSecs  `type`

```ts
type DeltaTimeSecs = number & Brand.Brand<'DeltaTimeSecs'>;
```

### FrameServices  `type`

```ts
type FrameServices = never;
```

### GameModule  `interface`

```ts
interface GameModule<ROut, E, RIn, RRegister = never> {
    readonly layers: Layer.Layer<ROut, E, RIn>;
    readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>;
}
```

### PositionKey  `type`

```ts
type PositionKey = string;
```

### StageId  `const`

```ts
const StageId: Brand.Brand.Constructor<StageId>;
```

### StageId  `type`

```ts
type StageId = string & Brand.Brand<'StageId'>;
```

### StageRegistration  `interface`

```ts
interface StageRegistration {
    readonly id: StageId;
    readonly after?: ReadonlyArray<StageId>;
    readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>;
}
```
