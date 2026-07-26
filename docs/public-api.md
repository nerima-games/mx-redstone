# 公開 API

## 1. 公開 API は stage 登録だけである

plan.md §3.12 は本リポジトリの公開 API を 1 行で書いている。

> **主要な公開 API**: stage 登録のみ（電力グラフは内部実装）

これは要約ではなく仕様である。**mc-compose が mx-redstone について知ってよいのは
「`ReadonlyArray<StageRegistration>` を返す Effect が 1 つある」ことだけ**であり、
`CircuitBoard` も `PowerMap` も `planPush` も、他リポジトリから名前で参照してはならない。

`index.ts` はそれらを再エクスポートしている（`index.ts:30-35`）。矛盾ではない。
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
この 1 箇所だけ `interface` のままなのは意図的で、`oxlint.json` のコメントに免除理由が書いてある
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

現状 `redstone:effects` の `run` は `Effect.void` である（`stages/registration.ts:162`）。
親リポジトリが未公開で書き込み先が存在しないため。

## 5. `index.ts` の全エクスポート

**契約** = 他リポジトリが依存してよい。**内部（可視）** = このリポジトリのテストとプレビューのためだけに見えている。

> **`test/public-api.test.ts` の 2 つのリストとは粒度が違う。**
> あちらの 1 つ目のリストは「stage 登録まわりのエクスポート」を落とさないための固定であって、
> 各名前が契約であるという主張ではない（`redstoneStages` / `makeRedstoneFrameState` /
> `UPSTREAM_STAGE_IDS` は下表では内部扱いである）。
> どれが契約かの権威は本表であり、`index.ts:22-23` と `test/public-api.test.ts:13-14` の
> 両方がそう書いている。

### `domain/frame-contract.ts` — kernel から借用中

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `StageId`（型 + `Brand.refined`） | 契約 | kernel 公開時に kernel のものへ差し替え |
| `DeltaTimeSecs`（型 + `Brand.refined`） | 契約 | 同上 |
| `FrameServices` | 契約 | 現在 `never`。意図的な乖離（`frame-contract.ts:65-80`） |
| `StageRegistration` | 契約 | plan.md §4.1 の字面どおり |

これらは「mx-redstone の契約」ではなく「mc-kernel の契約を mx-redstone が仮置きしているもの」である。
ファイルごと削除される予定であり、削除時に他リポジトリが困らないのは
誰もここから import していないから（未公開なので構造的に不可能）。

### `stages/registration.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `makeRedstoneStages` | **契約** | mc-compose が呼ぶ唯一のもの |
| `redstoneStages` | 内部（可視） | 状態を外から渡す版。テストとプレビュー用 |
| `makeRedstoneFrameState` | 内部（可視） | 再入可能な初期化（[design-notes.md](./design-notes.md) DN-RS-8） |
| `RedstoneFrameState` | 内部（可視） | `Ref` 4 本の束。形は変わる |
| `ticksForFrame` | 内部（可視） | 固定レート換算。純粋なのでテスト可能 |
| `REDSTONE_TICK_SECS` / `MAX_TICKS_PER_FRAME` | 内部（可視） | チューニング値 |
| `emptyCircuitBoard` | 内部（可視） | プレビューの初期盤面 |

### `stages/stage-ids.ts`

| エクスポート | 区分 | 備考 |
| --- | --- | --- |
| `REDSTONE_STAGE_IDS` | **契約** | `redstone:power` / `redstone:effects` の文字列は観測可能な界面。改名は破壊的変更 |
| `UPSTREAM_STAGE_IDS` | 内部（可視） | 宣言した上流。テストの検査対象 |
| `EXPERIENCE_MODULE_STAGE_PREFIXES` / `OWN_STAGE_PREFIX` | 内部（可視） | §2.3-1 検査のための定数 |

### `domain/power-graph.ts` — すべて内部（可視）

`MAX_POWER_LEVEL` / `PowerLevel` / `ComponentKind` / `Component` / `CircuitBoard` / `PowerMap` /
`emptyPowerMap` / `powerAt` / `sourcesOf` / `propagateTick` / `SETTLE_TICK_LIMIT` / `SettleResult` /
`settle` / `isLit`

1 つも契約ではない（§2）。

### `domain/piston.ts` — すべて内部（可視）

`BlockRef` / `BlockCapabilityLookup` / `PISTON_PUSH_LIMIT` / `PushPlan` / `PushRefusal` /
`PushOutcome` / `planPush` / `isPistonMovable`

`BlockCapabilityLookup` は kernel 公開時に kernel の能力アクセサへ差し替わる
（[design-notes.md](./design-notes.md) DN-RS-1、[versioning.md](./versioning.md) §6）。

### `domain/position-key.ts` — 内部（可視）

`PositionKey`（= `string`）。ブランドを**付けていない**のは意図的で、
ブランドを付けると本リポジトリが座標概念の所有者を騙ることになるためである（`domain/position-key.ts:11-15`）。
kernel 公開時に削除。

## 6. `GameModule` はまだ実装していない

plan.md §4.1 はもう 1 つ契約型を定義している。

```typescript
interface GameModule<ROut, E, RIn> {
  readonly layers: Layer.Layer<ROut, E, RIn>          // 提供するサービス群
  readonly frameStages: ReadonlyArray<StageRegistration>
}
```

**`RIn` を書けないので実装していない。** `RIn` は「この Layer が構築のために要求するサービス群」であり、
mx-redstone の場合それは mc-sim と mc-worldgen のサービス Tag である。
それらの公開 API はまだ存在しない（未公開かつ未実装）。
存在しない型引数を仮の名前で埋めた `GameModule` は、後で必ず書き直す嘘になる。

`makeRedstoneStages: Effect.Effect<ReadonlyArray<StageRegistration>>` は
**正直な部分集合**である（`stages/registration.ts:166-176`）。
`layers` が空である間、`GameModule` は `frameStages` しか持たないので、
配列を直接返すことと情報量が変わらない。
