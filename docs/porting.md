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

**参照実装のテストは、すべてのソースファイルの隣にある。** 実測値:

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

さらに `packages/app/application/frame/stages/interaction-stage-redstone.test.ts` と、
共有ヘルパの `packages/entity/test/redstone/test-utils.ts` がある。

**テスト 2,093 行に対してソース 1,664 行。**
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
