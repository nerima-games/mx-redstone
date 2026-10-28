# 公開 API

## 1. 公開 API は stage 登録、runtime、host port、W5 の piston planning である

公開 API は Effect stage registration、world runtime、host adapter、W5 が使う piston planning で構成する。各 export の契約区分は §5 の台帳に記録する。

mc-compose の W5 host は root から `pistonPositionAt`、`planPistonTransition`、`validatePistonPlan`、`applyPistonPlan` を import する。これらの関数と計画に必要な型も package の contract である。

`src/index.ts` は `domain/power-graph.ts` と `domain/piston.ts` を root から再 export する。power graph と piston module の残りの名前は、テストやプレビューのために見える内部 exports であり、外部 contract ではない。`CircuitBoard`、`PowerMap`、`planPush` は引き続き内部である。可視と公開の区別を §5 に記録する。

`test/public-api.test.ts` は選択した runtime export を名前で確認し、利用する型 export を compile-time import で検査する。root export 全件を検査するものではない。公開 contract と内部 export の一覧は §5 に記録する。

## 2. なぜ電力グラフは内部でなければならないのか

現在の `CircuitBoard` は `ReadonlyMap<PositionKey, Component>` と隣接リストの素朴な組であり、
`propagateTick` は毎 tick 全部品を走査する（`domain/power-graph.ts:106-148`）。
回路が大きくなればこれは持たない。想定される変更:

- チャンク単位のインデックス（回路は局所的なので、全走査は無駄）
- dirty set（参照実装は既にこれを持っている: `computeNeedsPropagation`, `redstone-simulation.ts:411`）
- 電力レベル 0–15 のビットパック（`PowerMap` を `Uint8Array` に置き換える）
- `Component` の optional フィールド群を discriminated union へ（`domain/power-graph.ts:56-63` が
  「部品集合の増加が止まったら再検討」と保留している）

**他リポジトリが `CircuitBoard` を名指しできる状態でこれをやると、全部が破壊的変更になる。**
kernel ほどではないにせよ、`mc-compose` はこのリポジトリをピン留めして消費するので、
その 1 つ 1 つが協調リリースを要求する。内部に閉じておけば、同じ変更が PATCH で済む。

これは [versioning.md](./versioning.md) §5 で「このリポジトリで破壊的変更とは何か」として再度扱う。

## 3. 契約そのもの（plan.md §4.1）

```typescript
interface StageRegistration {
  readonly id: StageId
  readonly after?: ReadonlyArray<StageId>   // 順序制約の宣言のみ。全順序は compose が解決
  readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>
}
```

`@nerima-games/mc-kernel` が plan.md の contract の正本であり、mx-redstone はそれを import する。
oxlint は `@typescript-eslint/consistent-type-definitions: ["warn", "type"]` を設定しているが、
この 1 箇所だけ `interface` のままなのは意図的で、`.oxlintrc.json` のコメントに免除理由が書いてある
——**仕様とコードが同じ字面であることのほうが、ローカルなスタイル統一より価値が高い**。

### 3-1. `after` は制約であって位置ではない

`after` が意味するのは「この stage の後に走らせてほしい」という**辺 1 本**だけである。3 つのことを意味しない。

1. 名指しした stage が存在することへの依存ではない（存在しなければ辺が無いものとして扱われる）。
2. 名指しした stage の実装への依存ではない（`StageId` は文字列であり import を作らない）。
3. 順序中の絶対位置の要求ではない。

**全順序は mc-compose だけが解決する**（plan.md §2.3-3）。
モジュールが自分の絶対位置を宣言しようとすれば、それは「他のモジュールを見ずに正しく決められない判断」を
下そうとしていることになる。

`test/stage-registration.test.ts` の
`REGRESSION: a registration carries constraints and nothing else — no priority, no index`
が、登録オブジェクトのキーが `['after', 'id', 'run']` の 3 つだけであることを固定している。
`priority: 10` のようなフィールドが後から生えてくるのを止めるためのテストである。

## 4. 標準 stage 骨格の中でのこのリポジトリ

plan.md §4.2 が定める骨格:

```
input
  → simulation (physics → interactions → entities → fluids → redstone → time/weather)
  → camera-mirror
  → chunk-sync
  → render
  → post-fx
  → hud-sync
```

| スロット | 埋める人 |
| --- | --- |
| `input` | `mc-render`（実行時入力サービスの所有者、plan.md §2.3-2） |
| `physics` | `mc-sim`（`mc-physics` を内部で使う） |
| `interactions` / `entities` / `fluids` / `time/weather` | `mx-gameplay` |
| **`redstone`** | **`mx-redstone`**（`redstone:power` と `redstone:effects` の 2 stage） |
| `camera-mirror` / `chunk-sync` / `render` / `post-fx` | `mc-render` |
| `hud-sync` | `mx-ui` |

**そして、この骨格自体を宣言する者は誰もいない。** 骨格は mc-compose の資産であり、
各モジュールは辺を出すだけである。

### 4-1. `after: [gameplay:fluids]` を宣言しない理由

骨格は `fluids → redstone → time/weather` と書いている。
`fluids` も `time/weather` も mx-gameplay の stage である。
名指しすれば import は増えないが、**mx-redstone のフレーム位置が別の体験モジュールの存在に依存する**。
mx-gameplay を外した構成（回路盤プレビュー、あるいは将来のミニマル合成）で
mx-redstone の順序制約が意味を失う、あるいは黙って無視される。
骨格を述べるのは mc-compose の仕事であり、mx-redstone が述べてよいのは
**自分の正しさが要求する制約だけ**である（`stages/stage-ids.ts:22-27`）。

したがって実際に宣言されている `after` は次の 2 本だけである。

| stage | `after` | なぜそれが必要か |
| --- | --- | --- |
| `redstone:power` | `sim:physics` | 感圧板はエンティティ位置を読む。今フレームの位置を見ないと、プレイヤーが動くたびに 1 フレームのちらつきが出る（`stages/stage-ids.ts:47-55`） |
| `redstone:effects` | `redstone:power` | 電力が確定してからでないと世界を書き換えられない。自リポジトリ内の辺 |

`sim:physics` は基盤リポジトリの stage であり、体験モジュールの stage ではない。
この区別を `test/stage-registration.test.ts` の
`REGRESSION: every declared upstream stage belongs to a foundation repository` が固定している。

### 4-2. stage が 2 つある理由

`power` と `effects` は電力計算と host event の生成を分ける。

- `redstone:power` は純粋な関数で電力マップを計算し、結果をこのモジュールの `Ref` に保存する。world state は変更しない。
- `redstone:effects` は結果を runtime event queue に積む。ピストンの伸縮、ランプの点灯、ディスペンサ発射、ホッパー移送、
  オブザーバのパルスを host が適用する。

電力グラフの計算は world なしでテストできる。2 つの stage は「電力計算、その後に event 生成」の順序を固定する。

host は stage 実行後に `applyRedstoneHostEvents` を呼び、5 つの queue をまとめて drain する。対象は lamp transition、piston transition、trigger、hopper transfer、powered-component transition である。
adapter は同じ world revision と dimension revision から plan を作り、lamp・piston・hopper の fragment を統合して coordinator の `commit` を 1 回だけ呼ぶ。成功した移送の fragment には item owner、hopper cooldown、hopper block edit が含まれる。

hopper event は経過 redstone tick と powered を持つ。host は経過 tick を game tick に換算して `HopperService` に渡す。候補 endpoint と slot は `selectHopperTransferCandidates` が選び、cooldown と移送可否は HopperService が判定する。候補がない hopper の cooldown は `planAdvanceCooldown` で進める。Java Edition の通常の container 移送後 cooldown は 8 game ticks である。

plan、merge、commit が失敗または中断した場合、古い fragment を再利用せず、drain した batch 全体を runtime queue に戻す。成功した batch の event は commit 完了後に公開する。runtime は経過 redstone tick と powered を渡し、cooldown の独自カウンタを持たない。
ボタンは `pressButton(dimension, position)` で次tickのパルスを予約する。`pulseTicks` の既定値は
10で、パルス中の再入力は残り時間を設定値へ戻す。リピーターの `delayTicks` は1–4に丸められ、
入力のONとOFFの双方へ同じtick遅延を適用する。

## 5. `index.ts` の全エクスポート

**契約** = 他リポジトリが依存してよい。**内部（可視）** = root から見えるが、他リポジトリが依存する約束ではない。

> **`test/public-api.test.ts` は選択した root export を検査する。全 export の台帳は本節に記載する。**
> そのうち stage internals と domain internals は export が見えていても契約ではない。
> W5 が使う piston planning names は下表で契約として明示する。どの名前が契約かは本表が定める。
>
> `REGRESSION: does not republish mc-kernel’s vocabulary as its own` は
> `StageId` と `DeltaTimeSecs` がバレルに現れないことも検査する。

### mc-kernel stage contract — **バレルには載せない**

`StageId`、`DeltaTimeSecs`、`FrameServices`、`StageRegistration` は `@nerima-games/mc-kernel` から利用し、
`index.ts` から再エクスポートしない。

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `StageId`（型 + `Brand.refined`） | **非公開**（所有者は kernel） | kernel から直接 import し、再 export しない |
| `DeltaTimeSecs`（型 + `Brand.refined`） | **非公開**（所有者は kernel） | 同上 |
| `FrameServices` | **非公開**（所有者は kernel） | runtime service context は kernel が所有 |
| `StageRegistration` | **非公開**（所有者は kernel） | plan.md §4.1 の字面どおり。`makeRedstoneStages` の**戻り値の形**としてだけ観測される |

これらは「mx-redstone の契約」ではなく mc-kernel が所有する契約である。

**だから re-export しない。** バレルに載せると `StageId` / `DeltaTimeSecs` / `StageRegistration` が
**所有していないパッケージの公開 API** になる。
消費者はこの語彙を kernel から取る。型は構造的に同一なので、
kernel から import した消費者は `makeRedstoneStages` の戻り値に対してそのまま型検査を通る。
mc-sim / mc-render / mc-playground-kit のバレルが同じ判断をしており、mx-gameplay / mx-ui も同じである。

### `stages/registration.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `makeRuntimeRedstoneStages` | **契約** | 同じ Effect context の `RedstoneWorldRuntime` と状態を共有する stage 登録 |
| `redstoneModule` | **契約** | `RedstoneWorldRuntimeLayer` と `makeRuntimeRedstoneStages` をまとめる `GameModule` |
| `makeRedstoneStages` | 内部（可視） | runtime port を持たない単体利用・互換経路 |
| `redstoneStages` | 内部（可視） | 状態を外から渡す版。テストとプレビュー用 |
| `makeRedstoneFrameState` | 内部（可視） | 再入可能な初期化（[design-notes.md](./design-notes.md) DN-RS-8） |
| `RedstoneFrameState` | 内部（可視） | `Ref` 4 本の束。形は変わる |
| `ticksForFrame` | 内部（可視） | 固定レート換算。純粋なのでテスト可能 |
| `REDSTONE_TICK_SECS` / `MAX_TICKS_PER_FRAME` | 内部（可視） | チューニング値 |
| `emptyCircuitBoard` | 内部（可視） | プレビューの初期盤面 |

### `application/world-runtime.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `RedstoneWorldRuntime` | **契約** | Effect service tag |
| `RedstoneWorldRuntimeLayer` | **契約** | runtime port の Layer |
| `RedstoneWorldRuntimeService` | **契約** | dimension snapshot の置換、ボタン入力、5 event queue の drain と、失敗時の batch 復元 |
| `RedstoneWorldSnapshot` / `RedstoneComponentSnapshot` / `RedstonePosition` | **契約** | compose/gameplay 型に依存しない意味型 |
| `LampTransition` / `PoweredComponentKind` / `PoweredComponentTransition` / `PoweredPistonTransition` / `TriggeredComponentKind` / `HopperTransferEvent` / `RedstoneTriggerEvent` | **契約** | host が world write や action に変換する runtime event。`HopperTransferEvent`は`elapsedRedstoneTicks`と`powered`を持つ |

snapshot から `CircuitBoard` を構築する関数、内部 state、node ID はバレルへ公開しない。

### `application/redstone-host-port.ts`

host port は host block を `RedstoneComponentSnapshot` に分類し、runtime event を世界へ適用する。host は dimension と lookup を持つ `RedstoneHostRealm` の配列を渡し、書き込み側は別の `RedstoneHostWritePort` で request を組み立てて coordinator に commit する。

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `redstoneSnapshotFromRealm` | **契約** | ホストの生ブロック列から 1 dimension 分の `RedstoneWorldSnapshot` を組む |
| `applyRedstoneHostEvents` | **契約** | 5つのqueueをdrainし、lamp、piston、hopperのplan fragmentを1つにmergeしてcoordinatorのcommitを1回呼ぶ。commit成功後にだけ`postCommitEvents`を`eventBus.publish`へ渡す。event busが無い場合はcommit前に失敗してbatch全体をruntimeへ戻し、publish失敗後はcommit済みbatchを再queueしない |
| `RedstoneHostBlock` / `RedstoneHostLookup` / `RedstoneHostWritePort` / `RedstoneHostRealm` | **契約** | host block は `BlockAddress` と typed block を持つ。lookup は hopper block と transfer context も読む。write port はevent requestとhopper block writeを組み立て、coordinatorと`HopperService`を使う |
| `componentForBlock` | 内部（可視） | ブロック文字列 1 つの分類。テストとホストの直接検証のために可視 |
| `kernelPistonCapabilities` | 内部（可視） | mc-kernel の `pistonImmovable` 能力テーブルを読む `BlockCapabilityLookup` |

`RedstoneHostLookup`からpiston facingとkindを読み取る。
event batchにはnote-block triggerとtrapdoor transitionも含めてrequestへ渡す。

### `stages/stage-ids.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `REDSTONE_STAGE_IDS` | **契約** | `redstone:power` / `redstone:effects` の文字列は観測可能な界面。改名は破壊的変更 |
| `UPSTREAM_STAGE_IDS` | 内部（可視） | 宣言した上流。テストの検査対象 |
| `EXPERIENCE_MODULE_STAGE_PREFIXES` / `OWN_STAGE_PREFIX` | 内部（可視） | §2.3-1 検査のための定数 |

### `domain/power-graph.ts` — すべて内部（可視）

`MAX_POWER_LEVEL` / `PowerLevel` / `ComponentKind` / `Component` / `CircuitBoard` / `PowerMap` /
`emptyPowerMap` / `powerAt` / `sourcesOf` / `propagateTick` / `settleTickLimitFor` / `SettleResult` /
`settle` / `isLit`

1 つも契約ではない（§2）。

### `domain/power-timing.ts` — すべて内部（可視）

`DEFAULT_BUTTON_PULSE_TICKS` / `TORCH_BURNOUT_TOGGLE_LIMIT` / `TORCH_BURNOUT_WINDOW_TICKS` /
`TORCH_BURNOUT_COOLDOWN_TICKS` / `RepeaterTimer` / `ButtonTimer` / `TorchTimer` / `TimedCircuitState` /
`emptyTimedCircuitState` / `advanceTimedCircuit`

### `domain/target-block.ts` — すべて内部（可視）

`TargetHit` / `targetSignal`

### `domain/piston.ts`

mc-compose の W5 browser host は `pistonPositionAt`、`planPistonTransition`、`applyPistonPlan`、`PistonMovementPlan` を使う。server host は `pistonPositionAt`、`planPistonTransition`、`validatePistonPlan`、`PistonCellRead`、`PistonMovementPlan` を使う。これらと関数の入出力に必要な `BlockRef`、`BlockCapabilityLookup`、`PistonFacing`、`PistonKind`、`PistonState`、`PistonPosition`、`PistonCell`、`PistonWorldView`、`PistonMove`、`PistonPlanRefusal`、`PistonMovementOutcome`、`PistonTransitionRequest`、`PistonApplyPort` を契約とする。

`PistonPosition`はmc-kernelの`BlockPosition`のaliasであり、`PistonPositionSchema`はkernelの`BlockPositionSchema`を使う。
planner、world read、world writeは同じbrand付き座標を使う。

`PISTON_PUSH_LIMIT`、`PushPlan`、`PushRefusal`、`PushOutcome`、`planPush`、`isPistonMovable` は root から見える内部 exports である。`planPush` と `planPistonTransition` は異なる planner contract を持つ。

`isPistonMovable` は `Result<boolean, BlockRegistryResolutionFailure>` を返す。
`PushOutcome` と `PistonMovementOutcome` は capability lookup failure を `failed` として返し、
ゲーム規則による `refused` と区別する。位置を扱う planner は失敗位置を含める。
`planPistonTransition` は通常／スティッキーピストンの伸縮を計画する。伸長は最大 12 ブロックで、
移動列は遠い側から順に並ぶ。スティッキー収縮は先端から 2 マス先の可動ブロック 1 個だけを
1 マス先へ引き戻す。欠損セル、範囲外、移動不能ブロック、不正な移動列は拒否し、
`applyPistonPlan` は検証済み plan を `PistonApplyPort.commit` の 1 回の atomic commit で適用する。
runtime の powered transition は node ID 順で、観測した給電エッジごとに冪等である。

スライム／ハチミツによる隣接ブロック連結は mc-kernel に対応する語彙・能力が無いため扱わない。
ブロックに押されるエンティティの移動と衝突解決は mc-sim / mc-physics の責務である。

`BlockCapabilityLookup` は domain planner の純粋性を保つ port である。
host adapter は登録済み block 名を kernel の `BlockId` に解決して `capabilityOfBlockId` を呼び、
その `Result` を planner まで伝える（[design-notes.md](./design-notes.md) DN-RS-1、[versioning.md](./versioning.md) §6）。

### `domain/position-key.ts` — **バレルには載せない**

`PositionKey`（= `string`）。ブランドを**付けていない**のは意図的で、
ブランドを付けると本リポジトリが座標概念の所有者を騙ることになるためである（`domain/position-key.ts:11-15`）。
kernel 所有の座標語彙であり、`index.ts` から re-export していない
——座標語彙も所有していないものだからである。

### 5-1. 機械的な root export 台帳

以下は `src/index.ts` の明示 export と barrel export を、生成済み declaration の名前に展開した全件台帳である。
各行は root export を1件だけ記載する。契約区分は本書の境界定義に従う。W5 が使う piston planning surface は契約とし、ほかの domain rules は内部（可視）とする。

| export | source | 区分 |
| --- | --- | --- |
| `RedstoneWorldRuntime` | `application/world-runtime.ts` | 契約 |
| `RedstoneWorldRuntimeLayer` | `application/world-runtime.ts` | 契約 |
| `LampTransition` | `application/world-runtime.ts` | 契約 |
| `HopperTransferEvent` | `application/world-runtime.ts` | 契約 |
| `PoweredComponentKind` | `application/world-runtime.ts` | 契約 |
| `PoweredComponentTransition` | `application/world-runtime.ts` | 契約 |
| `PoweredPistonTransition` | `application/world-runtime.ts` | 契約 |
| `RedstoneComponentSnapshot` | `application/world-runtime.ts` | 契約 |
| `RedstonePosition` | `application/world-runtime.ts` | 契約 |
| `RedstoneTriggerEvent` | `application/world-runtime.ts` | 契約 |
| `RedstoneWorldRuntimeService` | `application/world-runtime.ts` | 契約 |
| `RedstoneWorldSnapshot` | `application/world-runtime.ts` | 契約 |
| `TriggeredComponentKind` | `application/world-runtime.ts` | 契約 |
| `applyRedstoneHostEvents` | `application/redstone-host-port.ts` | 契約 |
| `componentForBlock` | `application/redstone-host-port.ts` | 内部（可視） |
| `kernelPistonCapabilities` | `application/redstone-host-port.ts` | 内部（可視） |
| `redstoneSnapshotFromRealm` | `application/redstone-host-port.ts` | 契約 |
| `RedstoneHostBlock` | `application/redstone-host-port.ts` | 契約 |
| `RedstoneHostLookup` | `application/redstone-host-port.ts` | 契約 |
| `RedstoneHostRealm` | `application/redstone-host-port.ts` | 契約 |
| `RedstoneHostWritePort` | `application/redstone-host-port.ts` | 契約 |
| `ComparatorMode` | `domain/comparator.ts` | 内部（可視） |
| `comparatorOutput` | `domain/comparator.ts` | 内部（可視） |
| `ContainerItemCount` | `domain/comparator.ts` | 内部（可視） |
| `ContainerItemCountSchema` | `domain/comparator.ts` | 内部（可視） |
| `ContainerSlot` | `domain/comparator.ts` | 内部（可視） |
| `MaxStackSizeSchema` | `domain/comparator.ts` | 内部（可視） |
| `CONTAINER_SIGNAL_FLOOR` | `domain/comparator.ts` | 内部（可視） |
| `CONTAINER_SIGNAL_SPAN` | `domain/comparator.ts` | 内部（可視） |
| `containerSignalStrength` | `domain/comparator.ts` | 内部（可視） |
| `PowerEdgeMemory` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserSweep` | `domain/dispenser.ts` | 内部（可視） |
| `dispenserEdges` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserSlotIndex` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserSlotIndexSchema` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserActionPlan` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserActionPlanSchema` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserPlanFailure` | `domain/dispenser.ts` | 内部（可視） |
| `DispenserPlanFailureSchema` | `domain/dispenser.ts` | 内部（可視） |
| `planDispenserAction` | `domain/dispenser.ts` | 内部（可視） |
| `GAME_TICKS_PER_REDSTONE_TICK` | `domain/hopper.ts` | 内部（可視） |
| `HopperAdjacentContainer` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferSelectionRequest` | `domain/hopper.ts` | 内部（可視） |
| `HopperContainerEndpoint` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferDirection` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferCandidate` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferSelectionRequestSchema` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferCandidateSchema` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferSelectionOutcome` | `domain/hopper.ts` | 内部（可視） |
| `HopperTransferSelectionOutcomeSchema` | `domain/hopper.ts` | 内部（可視） |
| `selectHopperTransferCandidates` | `domain/hopper.ts` | 内部（可視） |
| `HOPPER_TRANSFER_ITEMS` | `domain/hopper.ts` | 内部（可視） |
| `isHopperLocked` | `domain/hopper.ts` | 内部（可視） |
| `OBSERVER_PULSE_TICKS` | `domain/observer.ts` | 内部（可視） |
| `Sightings` | `domain/observer.ts` | 内部（可視） |
| `ObserverSweep` | `domain/observer.ts` | 内部（可視） |
| `observeChanges` | `domain/observer.ts` | 内部（可視） |
| `BlockRef` | `domain/piston.ts` | 契約 |
| `BlockCapabilityLookup` | `domain/piston.ts` | 契約 |
| `PISTON_PUSH_LIMIT` | `domain/piston.ts` | 内部（可視） |
| `PushPlan` | `domain/piston.ts` | 内部（可視） |
| `PushRefusal` | `domain/piston.ts` | 内部（可視） |
| `PushOutcome` | `domain/piston.ts` | 内部（可視） |
| `planPush` | `domain/piston.ts` | 内部（可視） |
| `isPistonMovable` | `domain/piston.ts` | 内部（可視） |
| `PistonFacing` | `domain/piston.ts` | 契約 |
| `PistonKind` | `domain/piston.ts` | 契約 |
| `PistonState` | `domain/piston.ts` | 契約 |
| `PistonPosition` | `domain/piston.ts` | 契約 |
| `PistonPositionSchema` | `domain/piston.ts` | 契約 |
| `PistonPushLength` / `PistonColumnIndex` / `PistonBlockOffset` | `domain/piston.ts` | 内部（可視） |
| `PistonPushLengthSchema` / `PistonColumnIndexSchema` / `PistonBlockOffsetSchema` | `domain/piston.ts` | 内部（可視） |
| `PistonCell` | `domain/piston.ts` | 契約 |
| `PistonCellRead` | `domain/piston.ts` | 契約 |
| `PistonWorldView` | `domain/piston.ts` | 契約 |
| `PistonMove` | `domain/piston.ts` | 契約 |
| `PistonMovementPlan` | `domain/piston.ts` | 契約 |
| `PistonPlanRefusal` | `domain/piston.ts` | 契約 |
| `PistonMovementOutcome` | `domain/piston.ts` | 契約 |
| `PistonTransitionRequest` | `domain/piston.ts` | 契約 |
| `pistonPositionAt` | `domain/piston.ts` | 契約 |
| `planPistonTransition` | `domain/piston.ts` | 契約 |
| `PistonApplyPort` | `domain/piston.ts` | 契約 |
| `validatePistonPlan` | `domain/piston.ts` | 契約 |
| `applyPistonPlan` | `domain/piston.ts` | 契約 |
| `MAX_POWER_LEVEL` | `domain/power-graph.ts` | 内部（可視） |
| `PowerLevel` | `domain/power-graph.ts` | 内部（可視） |
| `ComponentKind` | `domain/power-graph.ts` | 内部（可視） |
| `Component` | `domain/power-graph.ts` | 内部（可視） |
| `CircuitBoard` | `domain/power-graph.ts` | 内部（可視） |
| `PowerMap` | `domain/power-graph.ts` | 内部（可視） |
| `emptyPowerMap` | `domain/power-graph.ts` | 内部（可視） |
| `powerAt` | `domain/power-graph.ts` | 内部（可視） |
| `componentEntriesForKinds` | `domain/power-graph.ts` | 内部（可視） |
| `sourcesOf` | `domain/power-graph.ts` | 内部（可視） |
| `propagateTick` | `domain/power-graph.ts` | 内部（可視） |
| `settleTickLimitFor` | `domain/power-graph.ts` | 内部（可視） |
| `SettleResult` | `domain/power-graph.ts` | 内部（可視） |
| `settle` | `domain/power-graph.ts` | 内部（可視） |
| `drivenPowerAt` | `domain/power-graph.ts` | 内部（可視） |
| `isLit` | `domain/power-graph.ts` | 内部（可視） |
| `isPowered` | `domain/power-graph.ts` | 内部（可視） |
| `DEFAULT_BUTTON_PULSE_TICKS` | `domain/power-timing.ts` | 内部（可視） |
| `TORCH_BURNOUT_TOGGLE_LIMIT` | `domain/power-timing.ts` | 内部（可視） |
| `TORCH_BURNOUT_WINDOW_TICKS` | `domain/power-timing.ts` | 内部（可視） |
| `TORCH_BURNOUT_COOLDOWN_TICKS` | `domain/power-timing.ts` | 内部（可視） |
| `RepeaterTimer` | `domain/power-timing.ts` | 内部（可視） |
| `ButtonTimer` | `domain/power-timing.ts` | 内部（可視） |
| `TorchTimer` | `domain/power-timing.ts` | 内部（可視） |
| `TimedCircuitState` | `domain/power-timing.ts` | 内部（可視） |
| `emptyTimedCircuitState` | `domain/power-timing.ts` | 内部（可視） |
| `advanceTimedCircuit` | `domain/power-timing.ts` | 内部（可視） |
| `PlateWeighing` | `domain/pressure-plate.ts` | 内部（可視） |
| `LIGHT_PLATE_CAPACITY` | `domain/pressure-plate.ts` | 内部（可視） |
| `HEAVY_PLATE_CAPACITY` | `domain/pressure-plate.ts` | 内部（可視） |
| `plateSignal` | `domain/pressure-plate.ts` | 内部（可視） |
| `TargetHit` | `domain/target-block.ts` | 内部（可視） |
| `targetSignal` | `domain/target-block.ts` | 内部（可視） |
| `REDSTONE_TICK_SECS` | `stages/registration.ts` | 内部（可視） |
| `MAX_TICKS_PER_FRAME` | `stages/registration.ts` | 内部（可視） |
| `emptyCircuitBoard` | `stages/registration.ts` | 内部（可視） |
| `RedstoneFrameState` | `stages/registration.ts` | 内部（可視） |
| `makeRedstoneFrameState` | `stages/registration.ts` | 内部（可視） |
| `ticksForFrame` | `stages/registration.ts` | 内部（可視） |
| `redstoneStages` | `stages/registration.ts` | 内部（可視） |
| `makeRedstoneStages` | `stages/registration.ts` | 内部（可視） |
| `makeRuntimeRedstoneStages` | `stages/registration.ts` | 契約 |
| `redstoneModule` | `stages/registration.ts` | 契約 |
| `REDSTONE_STAGE_IDS` | `stages/stage-ids.ts` | 契約 |
| `UPSTREAM_STAGE_IDS` | `stages/stage-ids.ts` | 内部（可視） |
| `EXPERIENCE_MODULE_STAGE_PREFIXES` | `stages/stage-ids.ts` | 内部（可視） |
| `OWN_STAGE_PREFIX` | `stages/stage-ids.ts` | 内部（可視） |

この表の source は `src/index.ts` の export 元、名前は `dist/**/*.d.ts` の宣言から更新する。

## 6. `GameModule` を実装した（`redstoneModule`）

plan.md §4.1 の `GameModule` 契約は次の形である。

```typescript
interface GameModule<ROut, E, RIn, RRegister = never> {
  readonly layers: Layer.Layer<ROut, E, RIn>          // 提供するサービス群
  readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>
}
```

`frameStages` は配列ではなく Effect として公開する。stage state はその Effect の実行時に `Ref` として確保する。
Layer は runtime port を提供し、電力グラフは公開せず、ホストが同期する snapshot と適用する effect を意味型で公開する。

```typescript
export const makeRuntimeRedstoneStages:
  Effect.Effect<ReadonlyArray<StageRegistration>>

export const redstoneModule: GameModule<RedstoneWorldRuntime, never, never, never> = {
  layers: RedstoneWorldRuntimeLayer,
  frameStages: makeRuntimeRedstoneStages,
}
```

`RIn` と `RRegister` は `never` のままである。ホストが module Layer と stage 登録を同じ Effect context で
実行すれば runtime port を共有する。サービスを登録 context に提供しない旧ホストでは独立 state に
フォールバックして起動互換性を保つが、snapshot 同期を利用するには同じ Layer を提供する必要がある。

## 7. package subpath

### `./qa/redstone-placement-items`

この QA 専用 subpath は、redstone placement fixture が使う read-only set `REDSTONE_PLACEMENT_ITEMS` を export する。root entry point からは再 export しない。
