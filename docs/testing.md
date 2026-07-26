# 検証とテスト

## 1. 検証要件（plan.md §3.12）

> **検証**: 回路シナリオテスト（fixture 回路 → 期待状態）+ **回路盤プレビュー（部品を置いて動かすサンドボックス）**

2 本立てである。片方だけでは完成条件を満たさない（plan.md §6 Step 2: 「テスト green + プレビュー操作可能」）。

| 要件 | 状態 |
| --- | --- |
| 回路シナリオテスト | 実装済み（`test/power-graph.test.ts`） |
| ピストン押し出しの規則テスト | 実装済み（`test/piston.test.ts`） |
| stage 契約の回帰テスト | 実装済み（`test/stage-registration.test.ts`） |
| 依存境界ゲート | 実装済み（`test/check-dependency-whitelist.test.ts`） |
| **回路盤サンドボックスプレビュー** | **未着手**（§4） |

## 2. 今日のゲート

```console
$ pnpm verify        # typecheck && lint && check:deps && test。CI と同じ内容
```

| ゲート | 何を捕まえるか | 実測（2026-07-26） |
| --- | --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` と `tsconfig.test.json` の両方で型エラー | エラーなし |
| `pnpm lint` | oxlint。**このリポジトリ唯一の lint / format 設定**（prettier も biome も `.editorconfig` も置かない） | `Found 0 warnings and 0 errors`（13 ファイル / 97 ルール） |
| `pnpm check:deps` | 未許可 import / 推移閉包違反 / kit の実行時依存 / 循環 / 壁時計直読み | `OK — 13 file(s) scanned, allowed direct dependencies: @nerima-games/mc-sim, @nerima-games/mc-worldgen (plus @nerima-games/mc-kernel …)` |
| `pnpm test` | vitest | 5 ファイル / **68 テスト** pass |

`pnpm check:deps` が捕まえるものは 5 種類あり、typecheck と lint のどちらにも見えないものばかりである。
特に「stage の `after` に兄弟モジュールを書く」違反は check:deps にも見えず、
`pnpm test` 側で塞いである（[design-notes.md](./design-notes.md) DN-RS-7）。

CI（`.github/workflows/ci.yaml`）は同じ 4 つを個別ステップとして走らせ、
最後に `pnpm test:coverage` を実行して `coverage/` をアーティファクトとして残す。

## 3. 現在のテストスイート

5 ファイル / 68 テスト。すべて `@effect/vitest` の `it.effect` を使い、`environment: 'node'`（`vitest.config.ts:5`）。

| ファイル | テスト数 | 対象 |
| --- | ---: | --- |
| `test/power-graph.test.ts` | 21 | 回路シナリオ（ワイヤ減衰 / トーチ反転 / リピーター / 退化した盤面 / 収束と発振 / `sourcesOf`） |
| `test/check-dependency-whitelist.test.ts` | 18 | 依存ポリシー、体験モジュール間ゼロエッジ、推移閉包、kit の dev 専用、壁時計禁止、**他リポジトリの席から読んだ roster** |
| `test/stage-registration.test.ts` | 15 | §2.3-1 / §2.3-3 の回帰、固定レート tick、stage 挙動 |
| `test/piston.test.ts` | 9 | 能力フラグの構造的検査、押し出し計画 |
| `test/public-api.test.ts` | 5 | バレル（`index.ts`）の再エクスポートを名前で固定。契約と内部の区別を台帳化 |

### 3-0. `test/public-api.test.ts` がバレルを固定する理由

他の 4 ファイルは全部モジュールを直接 import している。したがって
**`index.ts` から再エクスポートを 1 行落としても、どのテストも落ちない**——
落ちるのは `index.ts` しか見ない唯一の消費者、mc-compose だけである。
`test/public-api.test.ts:4-7` がその状況をそのまま書いている。

このファイルは 2 つの肯定リスト（契約 / 内部だが可視）と 2 つの否定リストを持つ。
否定リストのほうが面白い:

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: exports no block roster — the immovable set belongs to mc-kernel` | `PISTON_IMMOVABLE_BLOCKS` / `BLOCK_TYPES` / `blockTypeToIndex` が**エクスポートに現れない**（DN-RS-1） |
| `REGRESSION: exports nothing that would let a consumer resolve a total stage order` | `sortStages` / `totalOrder` / `framePipeline` / `runFrame` が現れない（§2.3-3、DN-RS-7） |

「無いことをテストする」形になっているのは、**この 2 つが生えてくるのは自然な流れだから**である。
ピストンを実装すればブロック名簿が欲しくなり、プレビューを書けば順序解決器が欲しくなる。
どちらも公開してはならない。

### 3-1. fixture 回路という形

plan.md §3.12 の「回路シナリオテスト（fixture 回路 → 期待状態）」は、実際にはこう書ける。

```typescript
const board = line([
  ['lever', { kind: 'lever', active: true }],
  ['w0', wire()],
  ['lamp', { kind: 'lamp' }],
  ['w1', wire()],
  ['w2', wire()],
])

const power = propagateTick(board, emptyPowerMap)

expect(isLit(board, power, 'lamp')).toBe(true)
expect(powerAt(power, 'w1')).toBe(0)
```

**fixture がリテラルで書けるのは、隣接がデータだからである。**
`CircuitBoard.adjacency` は `ReadonlyMap<PositionKey, ReadonlyArray<PositionKey>>` として
外から与えられる（`domain/power-graph.ts:82-89`）。
もし隣接を「ボクセルの 6 面」から導出していたら、1 つの回路を書くのに
チャンクを組み立て、ブロックを置き、座標を計算する必要があり、
テストは読めなくなる。

`domain/power-graph.ts:23-27` がこの設計判断を記録している——
真の隣接は mc-kernel の座標型が持つべきものであり、ここで再定義すれば語彙の fork になる。
**幾何を持たないことは制約であると同時に、シナリオテストが読める理由でもある。**

### 3-2. テスト名の規約

`works correctly` のような名前を書かない。**そのテストが落ちたときに何が壊れたのかが名前から分かること。**

```
REGRESSION: a lamp receives power but does not conduct it, so circuits do not join through one
REGRESSION: a long frame is capped and the excess is DISCARDED, not banked (no spiral of death)
REGRESSION: no `after` edge names another experience module, even though §4.2 puts redstone between gameplay stages
```

`REGRESSION:` 接頭辞は「これは設計上の前提を固定しているテストであり、
落ちたときは実装ではなく前提が壊れている」という印である。

設計の前提を守るテストには**由来**（plan.md の節番号、参照実装の `path:line`、監査の節番号）をコメントで書く。
由来のないテストは、将来だれかが「たぶん間違いだろう」と直してしまう。
3 番目の例が「§4.2 が redstone を gameplay の stage 群の間に置いているにもかかわらず」まで名前に入れているのは、
まさにそれを防ぐためである。

## 4. 完成条件

plan.md §6 Step 2 の完了条件は 2 つある。

> 各リポジトリの完了条件: ユニット/シナリオテスト green + **内蔵プレビューが操作可能**

| # | 条件 | 状態 |
| --- | --- | --- |
| 1 | `pnpm verify` が green | ✅ |
| 2 | ワイヤ / トーチ / レバー / ボタン / リピーター / ピストンのシナリオテスト | ✅（部品の一部は未実装、[responsibility.md](./responsibility.md) §1） |
| 3 | ディスペンサ / ホッパー / オブザーバ / 感圧板 / コンパレータ | ❌ |
| 4 | 参照実装のテスト資産（2,093 行）をオラクルとして移植 | ❌（[porting.md](./porting.md) §3） |
| 5 | **回路盤サンドボックスプレビューが操作可能** | ❌ |
| 6 | スティッキーピストン / 引き寄せ | ❌（意図的にスコープ外、DN-RS-10） |
| 7 | 99% カバレッジゲートが有効 | ❌（完成時に有効化、§6） |

### 4-1. 回路盤サンドボックスプレビュー

plan.md §3.12 が要求する形は「**部品を置いて動かすサンドボックス**」である。
最低限これができること:

- 盤面に部品を置く・消す（ワイヤ、トーチ、レバー、ボタン、リピーター、ランプ、ピストン）
- レバーを倒す・ボタンを押す
- **1 tick ずつ進める**、および「安定するまで進む」（= `settle`。発振する回路では
  `oscillating: true` をそのまま表示する、DN-RS-4）
- 各セルの電力レベル 0–15 を見る

`domain/power-graph.ts` の API はこの用途に合わせて作られている。
`settle(board, { from })` が途中の電力マップから再開できるのは、まさにステップボタンのためである
（`settle can resume from a given power map, which is what the preview step button needs`）。
`makeRedstoneFrameState` が Effect であるのは、1 ページに 2 つの盤面を置けるようにするためである（DN-RS-8）。

配置場所は `apps/preview-circuit-board/`（plan.md §4.1: 「プレビューは契約に含めない。各リポジトリ内の dev アプリ。
`apps/preview-*/` に配置」）。起動ハーネスは `mc-playground-kit` を**devDependency として**使う
（[responsibility.md](./responsibility.md) §3-1）。

**プレビューがなぜ必須なのか。** テストが検出しない種類のバグがあるからである。
`stages/stage-ids.ts:50-54` が挙げている例——感圧板の 1 フレームちらつき——は、
「テストでは見えず、プレビューでは一目で分かる」ものの典型である。
回路の見た目が正しく更新されるかどうかは、`expect` では書けない。

## 5. 決定論

回路テストが**厳密に再現可能**であることは、3 つの性質から出てくる。

1. **固定レート tick。** 経過時間は `ticksForFrame` で整数の tick 数に量子化される。
   フレームレートは結果に影響しない（DN-RS-3）。
2. **壁時計を読まない。** `Date.now()` / `new Date()` / `performance.now()` は `pnpm check:deps` で禁止（DN-RS-9）。
3. **シードがない。** `propagateTick` / `settle` / `planPush` はすべて純粋関数で、乱数を使わない。
   参照実装は作物のドロップ等で乱数を使うが、それは mx-gameplay の資産である
   （`mc-kernel/docs/capability-flag-audit.md` §6-9）。

`vitest.config.ts:23-26` は `sequence.seed: 0` を固定しており、テストの実行順も再現する。

この 3 つが揃っているので、「fixture 回路 → 期待状態」は**毎回同じ答えを返す**。
1 つでも崩すと、シナリオテストは flaky テストに変わる。

## 6. カバレッジ — 99% ゲートは完成時に入れる

**現在、閾値は設定していない。これは意図的である。**

- 参照実装（`takeokunn/ts-minecraft`）は branches / functions / lines / statements のすべてに **99%** を強制している。
- しかし**スケルトンに閾値を課しても意味がない**。型定義とごく小さな純粋関数だけのリポジトリなら
  簡単に満たせてしまい、実装の品質について何も語らない数字になる。
  現状の 68 テストは「まだ書かれていない実装」については何も言っていない。
- 計測とレポートは常に動かしている（`pnpm test:coverage`）ので、数字はいつでも見える。
  CI は毎回 `coverage/` をアーティファクトとして残す（`.github/workflows/ci.yaml`、保持 7 日）。

**99% ゲートは完成条件（§4）に到達した時点で、`vitest.config.ts` と CI ワークフローの両方で有効化する。**
`vitest.config.ts:46-57` に有効化する行がコメントとして既に置いてあり、その上に理由も書いてある。

```typescript
// NO THRESHOLD YET — deliberate.
//   thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
```

CI 側にも同じ注記がある（`.github/workflows/ci.yaml` の `Coverage` ステップ:
「Coverage is reported but not yet thresholded — see vitest.config.ts.」）。
**2 箇所に書いてあるのは、片方だけ有効にしても意味がないから**である。

計測対象は `index.ts` / `domain/**/*.ts` / `stages/**/*.ts`（`vitest.config.ts:31`）。
`scripts/` と `test/` は対象外。

### 6-1. 閾値を「今」入れないことと、実装が閾値に備えていることは別

閾値は未設定だが、**実装のほうは既に「到達不能な分岐を作らない」という規律で書かれている**。
`domain/power-graph.ts` に 2 箇所その判断が記録されている（[design-notes.md](./design-notes.md) DN-RS-11）。

同じ理由で `domain/position-key.ts` は計測対象から除外してある（`vitest.config.ts:32-42`）。
型エイリアス 1 行だけで実行可能な文が 0 のファイルを、v8 provider は 100% ではなく **0%** と報告するため、
headline の数字が無意味になる。

```typescript
// PURE_TYPE: a single type alias, zero executable statements. v8 reports
// such a file as 0% rather than 100%, which would make the headline
// number meaningless.
```

**除外は「測れないもの」に限り、「測ると都合が悪いもの」には使わない。**
このファイルは kernel 公開時に削除される（[versioning.md](./versioning.md) §6）ので、除外も一緒に消える。

## 7. 参照実装のテストはオラクルである

plan.md §8 のリスク対策:

> 参照実装を仕様書として使い、テスト資産を各 Step で**先に**移植。**ゼロから仕様を再発明しない**

レッドストーンは仕様が細かい。「トーチは支持セルを電源にしない」「リピーターは前 tick を読む」
「コンパレータは背面 ≥ 側面のときだけ出力する」——どれも参照実装のテストに答えが書いてある。

参照実装のテスト資産は 2,093 行あり、ソース 1,664 行より多い（[porting.md](./porting.md) §3）。
**この比率がこのリポジトリの移植戦略を決めている**: 移植すべき主資産はソースではなくテストである。

再発明してはならない。参照実装のテストを読み、期待値を持ってきて、その上で実装を書くこと。
