# 公開 API

## 1. 公開 API は stage 登録と意味的 runtime port である

plan.md §3.12 は本リポジトリの公開 API を 1 行で書いている。

> **主要な公開 API**: stage 登録のみ（電力グラフは内部実装）

電力グラフを内部実装とする制約は現在も変わらない。一方、stage が世界を読み書きするためには
ホストとの境界が必要になった。そこで mc-compose が知ってよいものを、stage 登録に加えて
`RedstoneWorldRuntime` の意味的 port に限定している。`CircuitBoard`、`PowerMap`、`planPush` は
引き続き他リポジトリから名前で参照してはならない。

`index.ts` はそれらを再エクスポートしている（`index.ts:30-33`）。矛盾ではない。
理由は `index.ts:17-23` に書いてある:

> `domain/power-graph.ts` and `domain/piston.ts` are re-exported below because this
> repository's tests and its circuit-board preview import them by name, and a package that
> lies about its own entry point is worse than one that exports too much.

つまり**「見える」と「公開」は別の語**であり、その区別を書き留めるのが本書の役目である。
§5 の表がその台帳である。

`test/public-api.test.ts` がバレルの中身を名前で固定している。
他のテストはすべてモジュールを直接 import しているので、
**`index.ts` から再エクスポートが 1 行落ちても、そのテスト以外は誰も気づかない**——
気づかないまま壊れるのは mc-compose だけである（同ファイル `:4-7`）。
同ファイルには「エクスポートに現れてはならないもの」の否定リストも 2 つあり、
[testing.md](./testing.md) §3-0 で扱う。

## 2. なぜ電力グラフは内部でなければならないのか

理由は 1 つだけで、しかも十分に強い。**電力グラフの形は必ず変わるから**である。

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
`index.ts` の「見えるが公開ではない」という気持ち悪さに対して支払われている対価は、これ 1 つである。

## 3. 契約そのもの（plan.md §4.1）

```typescript
interface StageRegistration {
  readonly id: StageId
  readonly after?: ReadonlyArray<StageId>   // 順序制約の宣言のみ。全順序は compose が解決
  readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>
}
```

`domain/frame-contract.ts:98-102` は plan.md からこの `interface` を字面ごと再掲している。
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

骨格は `fluids → redstone → time/weather` と書いている。素直に読めば
`after: [StageId('gameplay:fluids')]` と書きたくなる。**書かない。**

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

`power` と `effects` の分割線は**純粋性の境界**である。

- `redstone:power` — 電力マップを 1 redstone tick 進める。純粋。このモジュール自身の `Ref` 以外に触らない。
- `redstone:effects` — 結果を世界に適用する。ピストンの伸縮、ランプの点灯、ディスペンサ発射、ホッパー移送、
  オブザーバのパルス。すべて mc-sim / mc-worldgen への書き込み。

この境界があるから電力グラフ全体がワールドなしでテストできる。
`the two registered stages split at the purity boundary: power, then effects` が順序と `after` を固定している。

現状 `redstone:effects` はランプの on/off 変化を runtime port に蓄積する。
ホストは stage 実行後に `drainLampTransitions` と `drainPistonTransitions` で変化を取り出し、世界へ適用する。
ボタンは `pressButton(dimension, position)` で次tickのパルスを予約する。`pulseTicks` の既定値は
10で、パルス中の再入力は残り時間を設定値へ戻す。リピーターの `delayTicks` は1–4に丸められ、
入力のONとOFFの双方へ同じtick遅延を適用する。
ピストン、ディスペンサ、ホッパー等の世界更新は、書き込み先サービスの公開後に追加する。

## 5. `index.ts` の全エクスポート

**契約** = 他リポジトリが依存してよい。**内部（可視）** = このリポジトリのテストとプレビューのためだけに見えている。

> **`test/public-api.test.ts` のリストとは粒度が違う。**
> あちらの 1 つ目のリストは「stage 登録まわりのエクスポート」を落とさないための固定であって、
> 各名前が契約であるという主張ではない（`redstoneStages` / `makeRedstoneFrameState` /
> `UPSTREAM_STAGE_IDS` は下表では内部扱いである）。
> どれが契約かの権威は本表であり、`index.ts:22-23` と `test/public-api.test.ts:13-14` の
> 両方がそう書いている。
>
> 同ファイルには**不在**を固定するテストもある。
> `REGRESSION: does not republish mc-kernel’s vocabulary as its own` は
> `StageId` と `DeltaTimeSecs` がバレルに**現れない**ことを assert する。
> 「見えるが契約ではない」の管理はドキュメントでできるが、
> 「所有していないものを公開する」はドキュメントでは止められない——消えるのが約束だからである。

### `domain/frame-contract.ts` — kernel から借用中。**バレルには載せない**

`index.ts` はこのファイルを `export *` **しない**。末尾のコメントが存在と削除予定を記すだけである。

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `StageId`（型 + `Brand.refined`） | **非公開**（所有者は kernel） | kernel 公開時に kernel のものへ差し替え |
| `DeltaTimeSecs`（型 + `Brand.refined`） | **非公開**（所有者は kernel） | 同上 |
| `FrameServices` | **非公開**（所有者は kernel） | 現在 `never`。意図的な乖離（`frame-contract.ts:65-80`） |
| `StageRegistration` | **非公開**（所有者は kernel） | plan.md §4.1 の字面どおり。`makeRedstoneStages` の**戻り値の形**としてだけ観測される |

これらは「mx-redstone の契約」ではなく「mc-kernel の契約を mx-redstone が仮置きしているもの」である。

**だから re-export しない。** バレルに載せると `StageId` / `DeltaTimeSecs` / `StageRegistration` が
**所有していないパッケージの公開 API** になり、ヘッダが約束している
「kernel publish 時にファイルごと削除」がすべての消費者にとっての破壊的変更に化ける。
消費者はこの語彙を kernel から取る。型は構造的に同一なので、
kernel から import した消費者は `makeRedstoneStages` の戻り値に対してそのまま型検査を通る。
mc-sim / mc-render / mc-playground-kit のバレルが同じ判断をしており、mx-gameplay / mx-ui も同じである。

### `stages/registration.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `makeRuntimeRedstoneStages` | **契約** | 同じ Effect context の `RedstoneWorldRuntime` と状態を共有する stage 登録 |
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
| `RedstoneWorldRuntimeService` | **契約** | dimension snapshot の置換、ボタン入力、ランプ変化の drain |
| `RedstoneWorldSnapshot` / `RedstoneComponentSnapshot` / `RedstonePosition` | **契約** | compose/gameplay 型に依存しない意味型 |
| `LampTransition` | **契約** | ホストが世界へ適用するランプの on/off 変化 |

snapshot から `CircuitBoard` を構築する関数、内部 state、node ID はバレルへ公開しない。

### `application/redstone-host-port.ts`

§5.3 W1-L4' の降ろし先。旧 mc-compose `apps/multiplayer-server/redstone-runtime.ts` が
持っていたホスト境界（ブロック文字列 → `RedstoneComponentSnapshot` の分類と、drain した
イベントの適用）がここに来た。ホストは自分の `MultiplayerServerCore` 相当の実装を
`RedstoneHostRealm`（`lookup` + `port`）として渡すだけでよい。

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `redstoneSnapshotFromRealm` | **契約** | ホストの生ブロック列から 1 dimension 分の `RedstoneWorldSnapshot` を組む |
| `applyRedstoneHostEvents` | **契約** | runtime の 5 queue を drain し、`RedstoneHostRealm` ごとに適用する |
| `RedstoneHostBlock` / `RedstoneHostLookup` / `RedstoneHostWritePort` / `RedstoneHostRealm` | **契約** | ホストが実装する Port の形。ブロック名の語彙は含まない（`applyLampTransition` 等は真偽値を取る） |
| `componentForBlock` | 内部（可視） | ブロック文字列 1 つの分類。テストとホストの直接検証のために可視 |
| `kernelPistonCapabilities` | 内部（可視） | mc-kernel の `pistonImmovable` 能力テーブルを読む `BlockCapabilityLookup` |

`applyRedstoneHostEvents` は mc-compose 版から 2 つの穴をそのまま引き継いでいる
（ソース自身に対応する host 操作が無かったため、直す側で発明しない）:
`RedstoneTriggerEvent` の `'note-block'` と `PoweredComponentTransition` の
`'trapdoor'` は drain されるが host には渡らない。`componentForBlock` の `piston`
ケースも `pistonFacing: 'north'` / `pistonKind: 'sticky'` 固定のまま。

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

`propagateTick` の互換契約を変えずに、tickをまたぐ遅延とパルスを値として保持するAPIである。
同じ盤面・状態・押下集合には同じ次状態を返し、壁時計や反復順序を参照しない。
リピーターの `sideInputs` は前tickの電力を読み、いずれかが通電中なら現在出力を保持する。
ロック中の未確定遷移は破棄し、解除後は背面入力を設定遅延の先頭から評価し直す。
トーチは30 tick内の8回目の消灯でburnoutし、80 tick出力を停止してから再評価する。

### `domain/target-block.ts` — すべて内部（可視）

`TargetHit` / `targetSignal`

ターゲット面の正規化座標を入力し、中心からの Chebyshev 距離を 1–15 の信号強度へ写像する純粋規則である。
命中なしは 0、中心は 15、辺と角は 1 とし、範囲外座標は面の境界へ clamp する。

### `domain/piston.ts` — すべて内部（可視）

`BlockRef` / `BlockCapabilityLookup` / `PISTON_PUSH_LIMIT` / `PushPlan` / `PushRefusal` /
`PushOutcome` / `planPush` / `isPistonMovable` に加え、方向・伸縮状態を含む
`PistonMovementPlan` / `planPistonTransition` / `validatePistonPlan` / `applyPistonPlan` を公開する。

`planPistonTransition` は通常／スティッキーピストンの伸縮を計画する。伸長は最大 12 ブロックで、
移動列は遠い側から順に並ぶ。スティッキー収縮は先端から 2 マス先の可動ブロック 1 個だけを
1 マス先へ引き戻す。欠損セル、範囲外、移動不能ブロック、不正な移動列は拒否し、
`applyPistonPlan` は検証済み plan を `PistonApplyPort.commit` の 1 回の atomic commit で適用する。
runtime の powered transition は node ID 順で、観測した給電エッジごとに冪等である。

スライム／ハチミツによる隣接ブロック連結は mc-kernel に対応する語彙・能力が無いため扱わない。
ブロックに押されるエンティティの移動と衝突解決は mc-sim / mc-physics の責務である。

`BlockCapabilityLookup` は kernel 公開時に kernel の能力アクセサへ差し替わる
（[design-notes.md](./design-notes.md) DN-RS-1、[versioning.md](./versioning.md) §6）。

### `domain/position-key.ts` — **バレルには載せない**

`PositionKey`（= `string`）。ブランドを**付けていない**のは意図的で、
ブランドを付けると本リポジトリが座標概念の所有者を騙ることになるためである（`domain/position-key.ts:11-15`）。
kernel 公開時に削除。`frame-contract.ts` と同じ理由で `index.ts` から re-export していない
——座標語彙も所有していないものだからである。

## 6. `GameModule` を実装した（`redstoneModule`）

plan.md §4.1 はもう 1 つ契約型を定義している。縦切りスパイク後の形はこうである。

```typescript
interface GameModule<ROut, E, RIn, RRegister = never> {
  readonly layers: Layer.Layer<ROut, E, RIn>          // 提供するサービス群
  readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>
}
```

ここには長らく「`RIn` を書けないので実装していない」と書いてあった。
**診断は半分間違っていて、間違っていた側が重要だった。**

Layer は runtime port を提供する。電力グラフ自体は公開せず、ホストが同期する snapshot と
ホストが適用する effect だけを意味型として公開する。

本当の障害は **`frameStages` が配列だったこと**である。本リポジトリの stage は Effect の中で確保した
`Ref`（盤面・電力マップ・tick アキュムレータ）から組み立てられるので、`ReadonlyArray` 型のフィールドに
入れる方法が無かった。mc-sim が publish されても解決しない。
配列であることは同時に、**どのモジュールにも stage を組み立てるためにサービスを取得する文脈が無い**
ことを意味しており、それが `FrameServices` を肥大させていた原因でもあった
（mc-kernel `docs/freeze-checklist.md` (b)）。

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
