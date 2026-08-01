# 移植元

参照実装は `takeokunn/ts-minecraft`（凍結済み、plan.md 冒頭）。
本書のパスはすべてそのリポジトリルート相対である。

## 1. 計測条件

**下表の LOC は 2026-07-26 に `wc -l` で実測した値である。** plan.md §3 の LOC は「目安」と明記された概算であり、
本書はそれを引き写さない。

除外: テストファイル（`*.test.ts`）、`dist/`、`coverage/`。
含む: 空行・コメント行（`wc -l` はそれらを数える）。

```console
$ cd <ts-minecraft>
$ wc -l packages/app/application/frame/stages/redstone-*-world-effects.ts
```

## 2. 実測

| 移植元 | ファイル数 | LOC |
| --- | ---: | ---: |
| `packages/app/application/frame/stages/redstone-*-world-effects.ts` | **5** | **618** |
| &emsp;├ `redstone-dispenser-world-effects.ts` | 1 | 137 |
| &emsp;├ `redstone-hopper-world-effects.ts` | 1 | 53 |
| &emsp;├ `redstone-lamp-world-effects.ts` | 1 | 92 |
| &emsp;├ `redstone-observer-world-effects.ts` | 1 | 73 |
| &emsp;└ `redstone-piston-world-effects.ts` | 1 | 263 |
| `packages/entity/domain/redstone/` | 4 | 548 |
| &emsp;├ `redstone-model.ts` | 1 | 74 |
| &emsp;├ `redstone-position-utils.ts` | 1 | 39 |
| &emsp;├ `redstone-simulation.ts` | 1 | 419 |
| &emsp;└ `redstone.config.ts` | 1 | 16 |
| `packages/entity/application/redstone/redstone-service.ts` | 1 | 329 |
| `packages/app/application/frame/stages/interaction-redstone-handler.ts` | 1 | 114 |
| `packages/app/application/main/qa-api-redstone.ts` | 1 | 49 |
| `packages/app/application/frame/frame-interaction-service-types/redstone.ts` | 1 | 3 |
| `packages/app/application/main/layers/game-logic-redstone-bundles.ts` | 1 | 3 |
| **合計** | **15** | **1,664** |

### 2-1. plan.md との差異（訂正せずに記録する）

plan.md §3.12 の移植元欄:

> **移植元**: redstone-*-effects 6 ファイル（618 LOC）+ phase-16 のブロック群（WIRE/TORCH/LEVER/BUTTON/REPEATER/ピストン）

**LOC は正確に一致する。ファイル数が合わない。** 実測は **5** ファイルであって 6 ではない。
`redstone-*-world-effects.ts` に一致する非テストファイルは dispenser / hopper / lamp / observer / piston の 5 つで、
6 つ目は存在しない（`ls` の結果に現れるもう 5 つは対応する `.test.ts`）。

**黙って直さない。** LOC が一致している以上、plan.md の 618 は同じ 5 ファイルを数えたものであり、
ファイル数だけが誤っていると考えるのが自然である。しかし断定はできないので、
実測値と差異の両方をここに残す。同じ「6」は `stages/registration.ts:160` のコメントにも入り込んでいる
（plan.md をそのまま引いたため）。次にそのコメントを触る人が直せばよい。

### 2-2. 「phase-16 のブロック群」の実体

plan.md の言う `phase-16` は `phase/16-redstone.md`（**161 行**）である。
これは**仕様書であってソースではない**。フロントマターに `phase: 16` / `difficulty: 'advanced'` を持ち、
受け入れ条件をチェックボックスで並べた計画文書である。

```markdown
### 信号伝播
- [x] レッドストーンが信号を伝える
- [x] 信号の強度（0-15）が正しい
- [x] 信号の距離制限がある
```

したがって「移植」する対象ではない。**移植元というより受け入れ条件の一覧として読むべきもの**であり、
[testing.md](./testing.md) の完成条件と突き合わせる価値がある。

そして WIRE / TORCH / LEVER / BUTTON / REPEATER / ピストンという**ブロック群そのものは `BlockType` リテラルであり、
mc-kernel の資産である**（plan.md §3.1）。参照実装では
`packages/core/domain/block-type.ts:3-132` の 120 リテラルの一部として定義されている。

**つまり plan.md §3.12 の移植作業の半分は mc-kernel への変更であって、mx-redstone への変更ではない。**
mx-redstone 側で必要なのは「その名前のブロックがどう振る舞うか」だけで、
名前そのものはここに 1 つも書かない（[design-notes.md](./design-notes.md) DN-RS-1）。

### 2-3. `packages/entity/{domain,application}/redstone` は移動であって複製ではない

参照実装では、レッドストーンのシミュレーション本体（877 LOC）が `packages/entity` の中にある。

```
packages/entity/domain/redstone/       548 LOC
packages/entity/application/redstone/  329 LOC
```

`packages/entity` は新構成では **mc-sim** に対応する（plan.md §3.8 の移植元欄）。
したがってこれを mx-redstone に持ってくることは、コピーではなく**リポジトリの再割り当て**である。

正しい形は plan.md §7 のとおり「レッドストーン → redstone」で、
参照実装が entity パッケージに置いていたのは**分割の失敗**——電力グラフという状態っぽいものを
状態リポジトリに寄せた結果である。本構成では [architecture.md](./architecture.md) §3-1 の判断
（永続化されない導出値は動詞の私物）により mx-redstone に来る。

移植時に mc-sim 側へ残すのは、`redstone-service.ts` が触っているエンティティ・インベントリ状態への
アクセスだけである。

## 3. 移植の順序 — テストを先に持ってくる

plan.md §6 Step 2:

> 各 Step で参照実装の対応テスト・fixture・E2E シナリオを**オラクルとして移植し**、既知バグの再発を防ぐ

plan.md §8 のリスク表も同じことを別角度から言っている。

> 参照実装を仕様書として使い、テスト資産を各 Step で**先に**移植。ゼロから仕様を再発明しない

**参照実装のテストは、すべてのソースファイルの隣にある。** 実測値（2026-07-27 に `wc -l`）:

| テスト | LOC |
| --- | ---: |
| `packages/entity/test/redstone/redstone-simulation.test.ts` | 561 |
| `packages/entity/test/redstone/redstone-service.test.ts` | 297 |
| `packages/entity/test/redstone/redstone-service-snapshot.test.ts` | 207 |
| `packages/entity/test/redstone/redstone-position-utils.test.ts` | 63 |
| `packages/entity/test/redstone/` 小計 | **1,128** |
| `redstone-piston-world-effects.test.ts` | 440 |
| `redstone-dispenser-world-effects.test.ts` | 164 |
| `redstone-lamp-world-effects.test.ts` | 139 |
| `redstone-observer-world-effects.test.ts` | 116 |
| `redstone-hopper-world-effects.test.ts` | 106 |
| `redstone-*-world-effects.test.ts` 小計 | **965** |
| 上 2 小計（本書が以前「テスト資産」と呼んでいた数） | **2,093** |
| `packages/app/application/frame/stages/interaction-stage-redstone.test.ts` | 253 |
| `packages/entity/test/redstone/test-utils.ts`（共有ヘルパ） | 26 |
| `packages/entity/test/redstone-simulation.test.ts` | 171 |
| `packages/entity/test/redstone-position-utils.test.ts` | 115 |
| **合計** | **2,658** |

### 3-0. 2,093 は算数としては正しく、名前としては誤りである

**本書は以前この表の上 2 小計だけを合計し、それを「参照実装のテスト資産」と呼んでいた。**
2,093 という数の**足し算は合っている**（1,128 + 965）。誤っているのは**何を数えたか**である。

- `interaction-stage-redstone.test.ts`（253）と `test-utils.ts`（26）は、
  **本書の同じ節が表の直下の散文で名指ししていながら、表には足していなかった。**
- `packages/entity/test/redstone-simulation.test.ts`（171）と
  `packages/entity/test/redstone-position-utils.test.ts`（115）は**本書がどこにも書いていなかった**。
  `redstone/` サブディレクトリの外に平置きされている 2 ファイルで、
  参照実装の `vitest.config.ts:17` の `packages/*/test/**/*.test.ts` に**一致するので実際に実行されている**。
  同名の入れ子版の複製ではない——平置き版だけが `makeDefaultState`（「トーチは既定で点灯」）と
  `BIAS` / `Y_STRIDE` / `XZ_STRIDE` の境界を持ち、入れ子版だけが `updateRepeaters` /
  `updateComparators` を持つ。どちらも他方の部分集合ではない。

**これは §2-1 が plan.md について指摘したのと同じ失敗である**——数そのものではなく、
数が答えている質問のほうがずれている。2-1 と同じ扱いにする: 黙って直さず、
古い数と新しい数の両方をこの表に残す。[testing.md](./testing.md) §4 の完成条件 #4 の数字は
**2,658 に訂正した**。うち 565 行は本節 3-1 の理由で移植しない。

**テスト 2,658 行に対してソース 1,664 行。**
つまりこのリポジトリの移植において、参照実装の主たる資産はソースではなくテストである。

推奨手順:

1. **fixture 回路テストを先に移す。** 期待状態を先に固定してから実装を書く。
   参照実装のテストがそのまま「仕様書」として機能する。
2. 移した各テストに、参照実装の `path:line` と plan.md の節番号を書き添える
   （由来のないテストは、将来「たぶん間違いだろう」と直される）。
3. ソースは移植せず書き直す。参照実装の `HashMap` / `MutableHashMap` の使い方や
   `RedstoneComponentType` の 12 値 Schema は、本構成の分割線と一致しない。
4. `redstone-*-world-effects.test.ts` の 965 行は mc-sim / mc-worldgen のモックを大量に含む。
   親リポジトリの公開 API が確定するまで、これらは最後に回す。

### 3-1. ファイル別の移植台帳

**移植したのは 4 本である。** 少ないのは怠慢ではなく測定結果であり、理由は 2 つに分かれる。

- 参照実装の主張の大半は、**すでに別の語彙でこのリポジトリに書かれている**。
  トーチの 1 tick 反転、ランプが導通しないこと、リピーターがダイオードであること、
  コンパレータの `>=`、オブザーバの初回武装、ディスペンサの立ち上がりエッジ——
  どれも `test/power-graph.test.ts` か部品ごとのファイルに既にある。
- 残りは**幾何・インベントリ・エンティティ**についての主張で、
  このリポジトリはそのどれも持っていない（[design-notes.md](./design-notes.md) DN-RS-17）。

移植した 4 本はいずれも「**参照実装が主張しており、かつここが主張していなかった**」ものである。
全部 `test/power-graph.test.ts` の `ported oracles` 節にある。

| 参照実装 | 主張 | 扱い |
| --- | --- | --- |
| `redstone-lamp-world-effects.test.ts:75-87` | ランプは**自セル**の電力では点かない | **移植**（`isLit` に `\|\| powerAt(power, key) > 0` を足すと落ちる。他のどのテストも落ちない） |
| `redstone-simulation.test.ts:423-433` | リピーターは**前面（出力セル）**の電力で ON にならない | **移植**（`sourcesOf` のリピーター分岐が `outputTo` も読むと落ちる） |
| `redstone-simulation.test.ts:99-107` | `neighborsOf` は対称である | **移植**（主張の翻訳。ここでは隣接はデータなので対称性は呼び出し側の不変条件であり、破れたときに何が起きるかを固定した） |
| `redstone-simulation.test.ts:171-188` | セルは**最強**の値を取る。BFS が先に届いた値ではない | **移植**（ただし fixture は書き直した。下記） |

**`171-188` は fixture をそのまま写すと主張を運ばない。** 参照実装の fixture は
両端の**レバー 2 個**で、強さが等しい。強さが等しいと sweep はレベル同期するので
「先に書いた者勝ち」と「最大を取る」は全セルで一致し、max-guard は一度も質問されない。
既存の `two sources feeding one wire give it the stronger of the two` がまさにその fixture で、
**max-guard を削除しても通る**。falsifiable にするには強さも距離も異なる 2 ソースが要り、
それは `emits`（重量感圧板、DN-RS-17）を持つこのリポジトリにしか組めない——
参照実装に重量板は無い。**主張を移植するとは、fixture ではなく主張を移植することである。**

移植しなかったもの、ファイル別:

| 参照実装 | 何を主張しているか | 移植しない理由 |
| --- | --- | --- |
| `redstone-simulation.test.ts` `neighborsOf` / `normalizeComponentPosition` | ボクセル 6 面の隣接、座標の floor | **幾何。** ここに幾何は無い（`domain/power-graph.ts:23-27`）。座標型は mc-kernel の資産 |
| 同 `decayButtonTimers`（3 例） | ボタンの残 tick が 1→0 で `active` が false になる | **移植済み。** `advanceTimedCircuit` が残り時間を持ち、runtime stage が dimension ごとの状態を進める。`test/timed-power-graph.test.ts` と `test/world-runtime.test.ts` が停止を固定する |
| 同 `updatePistons`（4 例） | 通電でピストンが `pistonExtended` になる | **実装済み。** `piston` component の通電変化を `drainPistonTransitions` から取得する |
| 同 `computeNeedsPropagation`（5 例） | dirty フラグと「期限切れボタンの残留電力」で再伝播が要る | **最適化の主張。** ここは固定レートで無条件に tick する（DN-RS-3）ので、対応する概念が無い |
| 同 `sortedPowerSnapshot` / `RedstonePowerLevel.toNumber` | 読み出しの決定性、ブランドの往復 | 決定性は上の 4 本目に**畳み込んで移植した**。ブランドの往復変換は主張を運ばない |
| 同 `canConduct` の表 | Piston と PressurePlate は導通、Lamp は不導通 | **既にある**（`CONDUCTS_POWER`、DN-RS-5）。Dispenser を導通させる 1 行だけは**意図的に違える**（DN-RS-16） |
| 同 `isPowerSource` の表 | active なレバー / トーチ / 感圧板は電源 | **既にある**（`sourcesOf` 節）。「ticks > 0 のボタン」だけは上の countdown と同じ話 |
| 同 `updateRepeaters` / `updateComparators` / subtract mode | 背面 `>=` 側面、subtract は最強側面を引く、コンパレータは実測強度で seed する | **既にある**（`test/comparator.test.ts` 13 本 + `comparators` 節）。「実測強度」は §1164 のラダーが 4 段で固定している |
| `redstone-service.test.ts`（17 例） | サービス API の Option 返し、`removeComponent`、stale key | **境界。** このリポジトリに部品ストアは無い。盤面は世界の所有者が組む |
| 同 `button emits temporary power and decays` | press(2) → 14, 14, 0 | **移植済み。** `pressButton` と `pulseTicks` により押下、再押下、期限切れを検査する |
| `redstone-service-snapshot.test.ts`（11 例） | tick カウンタ、キャッシュ、`setComponent` の再配置 | **境界**（同上）。`torch inversion (NOT gate)` の往復は下記 |
| 同 `torch inversion (NOT gate)`:127-158 | 入力が消えるとトーチは**点き直す** | **主張を運ばない。** `propagateTick` は (board, previous) の純関数なので、点き直した後の状態は**一度も通電されなかったトーチと同一**である。両半分は既に別々に固定されている（`:277` と `:308`）。この往復を落とす production の変異は存在しない |
| 同 `repeater delay: 2-tick` | リピーターの遅延段数 | **移植済み。** `delayTicks` は 1–4 に clamp され、ON/OFF の両遷移を同じ遅延で確定する。境界とキャンセルは `test/timed-power-graph.test.ts` が固定する |
| 同 `stacked wires never conduct vertically` | 上下のワイヤは導通しない | **幾何** |
| `redstone-piston-world-effects.test.ts`（19 例） | 押し出し、facing、腕の描画、エンティティの押し退け | **境界。** facing 付き移動は純粋に計画し、世界更新はホストの atomic commit。腕の描画とエンティティ押し退けはホスト責務 |
| 同 `refuses trains longer than the 12-block limit` | 13 個で拒否 | **既にある**（`test/piston.test.ts:98`、`PISTON_PUSH_LIMIT`） |
| 同 `does not push again while extended` | ピストンはエッジ駆動である | **移植先が無い。§4 の finding** |
| 同 sticky retraction（4 例） | 引き戻し | **実装済み。** 2 セル先の可動ブロックを空いた head セルへ引く。slime/honey の隣接連結は能力モデル待ち |
| `redstone-lamp-world-effects.test.ts` の残り（5 例） | 冗長な書き込みをしない、ランプでないセルに触らない | **境界。** ここは `isLit` という述語しか持たず、ブロックを書き換えるのは `redstone:effects` |
| `redstone-observer-world-effects.test.ts`（5 例） | 初回武装、変化で発火、静止は発火しない、facing、非オブザーバ無視 | **既にある**（`test/observer.test.ts` 9 本）。facing は幾何。「非オブザーバ無視」は `observeChanges` が sighting しか受け取らないので主張を運ばない |
| `redstone-dispenser-world-effects.test.ts`（7 例） | 立ち上がりエッジ、再武装、TNT、矢、空のチェスト | エッジ 3 例は**既にある**（`test/dispenser.test.ts` 7 本）。TNT / 矢 / チェストは**境界**（DN-RS-17: `inventoryAt`、`SpawnRequest<S>`、ダメージ数値） |
| `redstone-hopper-world-effects.test.ts`（4 例） | ドロップをチェストへ移す、溢れを再 spawn | **境界**（同上）。そもそも参照実装はロックも搬送周期も持たない（`:11-14`）ので、`test/hopper.test.ts` の期待値はバニラ由来であって参照由来ではない |
| `interaction-stage-redstone.test.ts`（12 例） | キー入力 → サービス呼び出しの配線、`pistonFacingFromDirection` | **境界。** 入力はこのリポジトリの資産ではない（plan.md §4.2） |
| `packages/entity/test/redstone-position-utils.test.ts`（18 例） | `BIAS` / `Y_STRIDE` / `XZ_STRIDE`、±32767 の往復 | **座標キーの符号化は kernel の資産。** `domain/position-key.ts` は仮置きで、kernel 公開時に削除される（§4） |
| `packages/entity/test/redstone-simulation.test.ts`（18 例） | 平置き版。`makeDefaultState`（トーチは既定で点灯）ほか | 「トーチは既定で点灯」は**既にある**（`a torch with no attachment is a permanent source`）。残りは入れ子版と重複 |
| `packages/entity/test/redstone/test-utils.ts` | 共有ヘルパ | テストではない。26 行の fixture 工場 |

## 4. 移植時に持ち込んではいけないもの

| 参照実装のもの | 理由 |
| --- | --- |
| `PISTON_IMMOVABLE_BLOCKS`（`redstone-piston-world-effects.ts:12-33`） | 能力フラグへ。[design-notes.md](./design-notes.md) DN-RS-1 |
| `redstoneService.tick()` を毎フレーム呼ぶ構造（`interaction-redstone-handler.ts:113`） | 固定レートへ。DN-RS-3 |
| `redstonePositionKey`（`redstone-piston-world-effects.ts:50-51`） | 座標キーの符号化は kernel の資産。`domain/position-key.ts` は仮置きで、kernel 公開時に削除 |
| `RedstoneComponentType` の 12 値 Schema（`redstone-model.ts:15`） | 部品集合はここで再設計する。参照実装は Hopper を導通させない一方 Dispenser を導通させており、その根拠が記録されていない |
| ブロック名リテラル一般 | mc-kernel の語彙。ここに 2 つ目の語彙を作らない |

逆に**そのまま持ち込むべき**もの:

| 参照実装のもの | 理由 |
| --- | --- |
| `canConduct` が Lamp を除外していること（`redstone-simulation.ts:24-34`） | DN-RS-5。既に `CONDUCTS_POWER` に反映済み |
| 「ランプは隣接セルの電力で点く」（`redstone-lamp-world-effects.ts:77-78`） | 同上。`isLit` に反映済み（**給電しているセル**に限定、DN-RS-5 §5-1） |
| 「トーチは支持セルを電源にしない」「リピーターはダイオード」 | DN-RS-12。`conductsInto` に反映済み。どちらも移植し忘れていて、プレビューが見つけた |
| 「トーチは自分の支持セルを電源にしない」（`redstone-simulation.ts:57-60`） | 孤立トーチの自己発振を防ぐ。本リポジトリはまだ幾何を持たないので未反映 |
| リピーターが前 tick を読むこと（`redstone-service.ts:56-58`） | DN-RS-2 |
| `MAX_REDSTONE_POWER = 15`（`redstone.config.ts:3`） | `MAX_POWER_LEVEL` として反映済み |
| `DEFAULT_BUTTON_TICKS = 20`（バニラの石ボタン 1.0 秒、`redstone.config.ts:5`） | ボタンのパルス長。**未実装** |
