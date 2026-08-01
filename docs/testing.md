# 検証とテスト

## 1. 検証要件（plan.md §3.12）

> **検証**: 回路シナリオテスト（fixture 回路 → 期待状態）+ **回路盤プレビュー（部品を置いて動かすサンドボックス）**

2 本立てである。片方だけでは完成条件を満たさない（plan.md §6 Step 2: 「テスト green + プレビュー操作可能」）。

| 要件 | 状態 |
| --- | --- |
| 回路シナリオテスト | 実装済み（`test/power-graph.test.ts`） |
| 部品ごとの規則テスト | 実装済み（`test/comparator.test.ts` / `observer.test.ts` / `hopper.test.ts` / `dispenser.test.ts` / `pressure-plate.test.ts`） |
| ピストン押し出しの規則テスト | 実装済み（`test/piston.test.ts`） |
| stage 契約の回帰テスト | 実装済み（`test/stage-registration.test.ts`） |
| 依存境界ゲート | 実装済み（`test/check-dependency-whitelist.test.ts`） |
| **回路盤サンドボックスプレビュー** | **実装済み**（`apps/preview-circuit-board/`、§4-1） |

**両方が揃ったので、plan.md §6 Step 2 の完了条件のうち「テスト green + プレビュー操作可能」の 2 つは満たしている**
（機能面の残りは §4 の表のとおり）。

## 2. 今日のゲート

```console
$ pnpm verify        # typecheck && lint && check:deps && api:check && test
$ pnpm test:coverage # 99% ゲート。verify には含まれないので別に走らせる
```

| ゲート | 何を捕まえるか | 実測（2026-07-27） |
| --- | --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` / `tsconfig.test.json` / `tsconfig.preview.json` の 3 プロジェクトで型エラー | エラーなし |
| `pnpm lint` | oxlint。**このリポジトリ唯一の lint / format 設定**（prettier も biome も `.editorconfig` も置かない） | `Found 0 warnings and 0 errors`（37 ファイル / 97 ルール）。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`.oxlintrc.json` は 5 カテゴリすべてと個別 67 ルールが `warn`、`error` は 4 つだけ。このフラグが無かった頃は実質その 4 つしかゲートになっていなかった） |
| `pnpm check:deps` | 未許可 import / 推移閉包違反 / kit の実行時依存 / 循環 / 壁時計直読み | `OK — 37 file(s) scanned, allowed direct dependencies: @nerima-games/mc-sim, @nerima-games/mc-worldgen (plus @nerima-games/mc-kernel …)` |
| `pnpm api:check` | `api-lock.md` と公開 API の乖離 | `OK — api-lock.md matches the public API` |
| `pnpm test` | vitest | 11 ファイル / **181 テスト** pass |
| `pnpm test:coverage` | カバレッジ計測 + **99% ゲート**（4 指標すべて）。**`verify` には含まれない**ので別に走らせる | 100 / 100 / 100 / 100（§6） |

**`apps/` は `SCAN_ROOTS` にも lint 対象にも入っている。** プレビューは `pnpm verify` で*実行*されないが、
型検査・lint・依存ゲート・壁時計禁止はすべて適用される。
「dev アプリだから検査しない」にすると、依存を 1 つ足すのに最も抵抗の少ない場所ができてしまう。

`pnpm check:deps` が捕まえるものは 5 種類あり、typecheck と lint のどちらにも見えないものばかりである。
特に「stage の `after` に兄弟モジュールを書く」違反は check:deps にも見えず、
`pnpm test` 側で塞いである（[design-notes.md](./design-notes.md) DN-RS-7）。

CI（`.github/workflows/ci.yaml`）は同じ 4 つを個別ステップとして走らせ、
最後に `pnpm test:coverage` を **99% ゲートとして**実行し、`coverage/` をアーティファクトとして残す。
**`pnpm verify` は CI と同じ内容ではない**——カバレッジを含まないので、`domain/` や `stages/` の分岐に
触ったら `pnpm test:coverage` も走らせること（§6）。

## 3. 現在のテストスイート

11 ファイル / 181 テスト。すべて `@effect/vitest` の `it.effect` を使い、`environment: 'node'`（`vitest.config.ts:5`）。

| ファイル | テスト数 | 対象 |
| --- | ---: | --- |
| `test/power-graph.test.ts` | 59 | 回路シナリオ（ワイヤ減衰 / トーチ反転 / リピーター（ダイオード） / **コンパレータ** / **オブザーバ** / **感圧板** / **アクチュエータ** / 退化した盤面 / 収束と発振 / `sourcesOf` / ボタン / **参照実装から移植したオラクル 4 本**（§4-3）） |
| `test/api-lock.test.ts` | 26 | `api-lock.md` 生成器の挙動（plan.md §6 Step 0-3） |
| `test/stage-registration.test.ts` | 19 | §2.3-1 / §2.3-3 の回帰、固定レート tick、stage 挙動、ミラーした `DeltaTimeSecs` ブランドが kernel と一致すること |
| `test/check-dependency-whitelist.test.ts` | 19 | 依存ポリシー、体験モジュール間ゼロエッジ、推移閉包、kit の dev 専用、壁時計禁止、**他リポジトリの席から読んだ roster** |
| `test/comparator.test.ts` | 13 | コンパレータの算術を**全数**（16 x 16 x 2）＋コンテナ充填率の写像 |
| `test/piston.test.ts` | 9 | 能力フラグの構造的検査、押し出し計画 |
| `test/observer.test.ts` | 9 | 変化検出、armed 規則、記憶が値であること（DN-RS-15） |
| `test/dispenser.test.ts` | 7 | 立ち上がりエッジ、オブザーバとの非対称（DN-RS-15） |
| `test/pressure-plate.test.ts` | 7 | スイッチ板と重量板の写像（DN-RS-17） |
| `test/public-api.test.ts` | 7 | バレル（`index.ts`）の再エクスポートを名前で固定。契約と内部の区別を台帳化 |
| `test/hopper.test.ts` | 6 | ロックの反転と搬送周期（DN-RS-16 §16-1） |

### 3-00. コンパレータだけ全数テストである理由

他の全部品は fixture 回路で検証している。`comparatorOutput` は数を 3 つ取って 1 つ返す関数で、
入力空間は 16 x 16 x 16 x 2 しかない。ここでの off-by-one は「回路が動かない」ではなく
**「fixture が使う入力ではすべて正しく、プレイヤーのソーターが座る境界だけ間違っている」**であり、
`>=` を `>` と書いた版は**側面を配線していない全テストを通る**。
数えられる入力空間は数えるほうが安い。

**プレビュー（`apps/`）にテストは無い。** 意図的である——プレビューは検査対象ではなく検査**手段**であり、
そこで見つかったことは `test/power-graph.test.ts` に assertion として降ろすのが正しい置き場所である
（§4-1）。mc-worldgen の先例も同じ扱いをしている。

### 3-0. `test/public-api.test.ts` がバレルを固定する理由

他の 4 ファイルは全部モジュールを直接 import している。したがって
**`index.ts` から再エクスポートを 1 行落としても、どのテストも落ちない**——
落ちるのは `index.ts` しか見ない唯一の消費者、mc-compose だけである。
`test/public-api.test.ts:4-7` がその状況をそのまま書いている。

このファイルは 2 つの肯定リスト（契約 / 内部だが可視）と 3 つの否定リストを持つ。
否定リストのほうが面白い:

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: exports no block roster — the immovable set belongs to mc-kernel` | `PISTON_IMMOVABLE_BLOCKS` / `BLOCK_TYPES` / `blockTypeToIndex` が**エクスポートに現れない**（DN-RS-1） |
| `REGRESSION: exports nothing that would let a consumer resolve a total stage order` | `sortStages` / `totalOrder` / `framePipeline` / `runFrame` が現れない（§2.3-3、DN-RS-7） |
| `REGRESSION: does not republish mc-kernel’s vocabulary as its own` | `StageId` / `DeltaTimeSecs` が現れない。バレルは以前 `domain/frame-contract.ts` と `domain/position-key.ts` を `export *` しており、**所有していない語彙**を公開していた（[public-api.md](./public-api.md) §5） |

「無いことをテストする」形になっているのは、**この 3 つが生えてくるのは自然な流れだから**である。
ピストンを実装すればブロック名簿が欲しくなり、プレビューを書けば順序解決器が欲しくなり、
`export *` を 1 行足すのは仮置きファイルを可視化する最も自然な方法に見える。
どれも公開してはならない。3 つ目については、公開が**約束済みの削除を破壊的変更に変える**という点で最も静かに効く。

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
| 3 | ディスペンサ / ホッパー / オブザーバ / 感圧板 / コンパレータ | **コンパレータ・オブザーバ ✅／ホッパー・ディスペンサ・感圧板はレッドストーンの規則だけ ✅、残りは境界（§4-2、[design-notes.md](./design-notes.md) DN-RS-17）** |
| 4 | 参照実装のテスト資産（**2,658 行**）をオラクルとして移植 | **一巡した。4 本を移植し、残りは理由つきで見送った**（§4-3、[porting.md](./porting.md) §3-1） |
| 5 | **回路盤サンドボックスプレビューが操作可能** | ✅（§4-1） |
| 6 | スティッキーピストン / 引き寄せ | ❌（意図的にスコープ外、DN-RS-10） |
| 7 | 99% カバレッジゲートが有効 | ✅（`vitest.config.ts` の `thresholds` + CI の `Coverage (99% gate)` ステップ。実測 100/100/100/100、§6） |

### 4-3. 完成条件 #4 — 移植して分かった 2 つのこと

**数のほうが先である。「2,093 行」は算数としては正しく、名前としては誤っていた。**
1,128 + 965 は確かに 2,093 だが、それは [porting.md](./porting.md) §3 の表が数えた 9 ファイルの合計であって、
参照実装のレッドストーンテスト資産ではない。同じ節が表の直下の散文で名指ししている 2 ファイル（279 行）と、
どこにも書かれていなかった平置きの 2 ファイル（286 行、参照実装の vitest 設定に**一致するので実行されている**）が
落ちている。実測は **2,658 行**で、2,093 はその 78.7% である。
porting.md §3-0 に旧値と新値の両方を残した——**§2-1 が plan.md について指摘したのと同じ失敗が本書自身にあった**ので、
同じ扱いにする。

**中身のほうは、移植が 4 本で終わったことが結果である。** 内訳は porting.md §3-1 の台帳にあり、
見送りの理由は 2 つに集約される。

- 参照実装の主張の大半は**すでに別の語彙でここにある**。トーチの 1 tick 反転、ランプの不導通、
  リピーターのダイオード性、コンパレータの `>=`、オブザーバの初回武装、ディスペンサの立ち上がりエッジ。
  「今回上陸した 5 部品を優先せよ」という前提で入ったが、**その 5 部品こそ移植できるものが最も少なかった**
  ——参照実装はそれらを world-effects 層に、インベントリ・エンティティ・幾何と一緒に実装しており、
  そこは丸ごと §4-2 の「残り」の側だからである。ホッパーに至っては参照実装がロックも搬送周期も
  持っておらず（`redstone-hopper-world-effects.ts:11-14` が自分でそう書いている）、
  `test/hopper.test.ts` の期待値はバニラ由来であって参照由来ではない。
- 残りは幾何・インベントリ・エンティティについての主張で、そのどれもここには無い（DN-RS-17）。

移植した 4 本は `test/power-graph.test.ts` の `ported oracles` 節にあり、
**4 本とも production を壊して赤くなることを確認してある**。3 本は他のどのテストも巻き込まずに単独で落ちる。

| 移植した主張 | 赤くする変異 | 巻き込んだ既存テスト |
| --- | --- | --- |
| ランプは自セルの電力では点かない | `isLit` に `\|\| powerAt(power, key) > 0` | 無し |
| リピーターは前面の電力で ON にならない | `sourcesOf` のリピーター分岐が `outputTo` も読む | 1 本（`switch the lever OFF and a repeater lets go`） |
| 隣接行は有向である | `neighboursOf` が隣接表を対称化する | 無し |
| セルは最強の値を取る（+ 順序非依存） | `propagateTick` の max-guard を `power.has(neighbour)` に | 無し |

**最後の 1 行が今回いちばん重い。** `propagateTick` の max-guard は
**このリポジトリのどのテストも守っていなかった**。既存の
`two sources feeding one wire give it the stronger of the two` は参照実装の fixture と同じ形
（両端に等強度のソース）で、等強度だと sweep がレベル同期するため
「先に書いた者勝ち」と「最大を取る」が全セルで一致してしまう——**max-guard を削除しても通る。**
参照実装の当該テスト（`redstone-simulation.test.ts:171-188`）はコメントで
「BFS が先に届いた値ではない、これが max-guard を検査する」と**明言していながら、
その fixture では検査できていない**。ここでも fixture をそのまま写していたら同じ穴を写していた。
穴を塞ぐには強さも距離も異なる 2 ソースが要り、それは `emits`（重量感圧板）を持つ
**このリポジトリにしか組めない**。参照実装に重量板は無い。

**これが「主張を移植する」と「テストを移植する」の差である。**

#### 移植が露出させた production の穴（残り 1 つ）

ボタンのパルス長は `advanceTimedCircuit` と `RedstoneWorldRuntime.pressButton` に実装し、
`test/timed-power-graph.test.ts` と `test/world-runtime.test.ts` で停止と再押下まで固定した。
未解決なのは次の 1 点である。

1. **ピストンがエッジ駆動であること。** 参照実装の
   `redstone-piston-world-effects.test.ts:165-181`（`does not push again while a piston remains extended`）と
   `redstone-simulation.test.ts:193-240`（`updatePistons`）は、ピストンが**通電レベルではなく
   立ち上がりエッジで**伸び、伸びたまま押し続けないことを主張している。
   ここには対応するものが無い: `piston` は `ComponentKind` ですらなく、
   `domain/piston.ts` は伸縮状態を持たない純粋な押し出し計画である。
   **規則そのものは既にこのリポジトリにある**——`domain/dispenser.ts` の `dispenserEdges` が
   まさに「レベルではなくエッジ」であり、DN-RS-16 がディスペンサについて書いていることは
   ピストンにもそのまま当てはまる（どちらも受電も導通もしないアクチュエータである）。
   足りないのは規則ではなく、ピストンの伸縮という**状態の持ち主**で、
   それは DN-RS-17 の表に載っている 6 つの欠落と同じ性質のものである。
   `dispenserEdges` を流用してテストだけ書くことはできるが、
   それは**ディスペンサの関数でピストンの主張を固定する**ことになり、由来が嘘になるのでやらない。

### 4-2. 完成条件 #3 の 5 部品——2 つは全部、3 つは半分

**この分割そのものが成果物である。**「あとで」ではなく「何が無いか」で書いてある。

| 部品 | ここにあるもの | 残り |
| --- | --- | --- |
| コンパレータ | 全部。2 モード、側面、コンテナ読み取りの写像、可変強度ソースとしてのグラフ統合 | コンテナの中身（DN-RS-17 の 1 行目） |
| オブザーバ | 全部。変化検出、armed 規則、パルス長、ダイオードとしてのグラフ統合 | 無し（サンプリングの根拠は DN-RS-15 §15-2） |
| ホッパー | ロックの反転（通電で**止まる**唯一の部品）と搬送周期 | アイテムの移動 = `inventoryAt` + `ItemType` |
| ディスペンサ | 立ち上がりエッジ検出（記憶は値。参照実装はモジュール変数） | 中身の取り出し、ドロップの spawn、発射体 |
| 感圧板 | 占有数 → 信号強度（スイッチ板と重量板）、ソースとしてのグラフ統合 | 「誰が乗っているか」= 幾何 + entity の寸法 + 空間クエリ |

**コンパレータは、本リポジトリの信号モデルの穴を実際に露出させた。**
穴は「表現できない」ではなく「既に記録済みの乖離のコストが、この部品でだけ質的に違う」であり、
DN-RS-13 がそれである。**その発見はほかの 4 部品を合わせたより価値がある**というのが
このタスクの前提だったので、そのとおりに書いてある。

### 4-1. 回路盤サンドボックスプレビュー（実装済み）

`apps/preview-circuit-board/`。`pnpm preview` で起動する。
plan.md §4.1（「プレビューは契約に含めない。各リポジトリ内の dev アプリ。`apps/preview-*/` に配置」）のとおり
dev アプリであり、`index.ts` から export されず、`pnpm verify` はこれを実行しない。

plan.md §3.12 が要求する「部品を置いて動かすサンドボックス」の最低条件は全部満たしている。

| 要件 | 実装 |
| --- | --- |
| 部品を置く・消す | `1`–`9` / `0` / `-` で選択、`space` で設置、`e` で消去（ワイヤ / トーチ / レバー / ボタン / リピーター / **コンパレータ** / **オブザーバ** / ランプ / ピストン / ブロック / 黒曜石） |
| レバーを倒す・ボタンを押す | `t`。**同じキーがコンパレータの compare / subtract を切り替える**——バニラでも同じ操作である |
| **1 tick ずつ進める** | `.`（`n` で N tick、`s` で `settle`） |
| 安定するまで進む | `s`。発振する回路は `oscillating: true` をそのまま表示する（DN-RS-4） |
| 各セルの電力 0–15 を見る | `power` ビュー（`v` で巡回）。16 進 1 桁で全セル表示 |

**加えて、テストには書けないものを 2 つ出している。**

- **tick カウンタ**と、**tick 軸に沿った電力テープ**（`timeline` ビュー）。
  テストは最終状態を assert するので、「2 tick 遅れて届いた信号」は最終状態が同じ限り見えない。
  リピーターの遅延が効いているかどうかは、まさにこれでしか分からない。
- **ピストンの拒否理由**（`immovable` / `too-long`）。`planPush` が 2 種類の拒否を区別しているのは
  「プレイヤーへの説明が違うから」（`domain/piston.ts:98-116`）であり、
  表示されない拒否理由は「何も起きなかった」と区別がつかない。
- **オブザーバの 2 tick パルス**（`observer-edge` シナリオ）。プレビューは
  「変化していない世界」を実際に持っている唯一の場所である——監視セルのブロックを消して初めて発火し、
  ちょうど 2 tick 光って自分で消える。**最終状態を assert するテストにはこれが見えない**:
  最終状態はどちらの経路でも暗いからである。
  カウントダウンをしているのがプレビュー側（`sandbox.ts` の `advanceObservers`）で、
  `domain/` はどちらの tick も数えていない——DN-RS-15 §15-3 の「残り時間は呼び出し側」の実演になっている。

#### なぜ mc-playground-kit を使わなかったか

本節は以前「起動ハーネスは `mc-playground-kit` を devDependency として使う」と書いていた。
**この判断を変更した。** 理由は 3 つある。

1. **kit はまだ publish されていない**（README 現状のボトムアップ publish-then-pin）。
   実行できないプレビューは完了条件ではなく、完了条件を満たす計画である。
2. **回路盤は「状態を見せる」プレビューである。** plan.md が見せろと言っているもの——セルの電力、
   点いたランプ、何 tick かかったか——はすべて「座標に紐づいた数値」であり、
   一人称 3D はそれらに何も足さず、回路全体を一度に見る能力を奪う。
   mc-worldgen の地形プレビューが先に同じ論証をしており（`apps/preview-terrain/main.ts` 冒頭）、
   回路には失うシルエットすら無いぶん、こちらのほうが強い。
   **mc-sim の障害物コースは違う**——あれは一人称の操作そのものが対象なので、kit を待つのが正しい。
3. `tsconfig.base.json` は `lib` から "DOM" を外している。これは機械的な保証であり、
   3D プレビューはそれをどこかの tsconfig で戻すことを要求する。
   プレビューのために、出荷ソースの保証を「約束」に格下げすることになる。

#### プレビューは実際に何を見つけたか

`pnpm preview --stats` は数値レポートを出す。**全部が実行時の測定**であり、記録された期待値は 1 つも無い
——直せば finding は自動的に消える。初回実行で 7 件出た。詳細は
[`apps/preview-circuit-board/README.md`](../apps/preview-circuit-board/README.md) の表にある。

重いものを 3 つだけ（いずれも**修正済み**）:

- **リピーターがダイオードになっていなかった。** `propagateTick` はソースの電力を全隣接セルに流すので、
  リピーターは自分の入力セルを 12 → 14 に持ち上げ、次 tick に**自分自身から再点火していた**。
  レバーを切っても回路は永久に点いたままで、側面に触れただけの独立回路にも給電した。
  同じ原因でトーチも自分の支持セルを駆動し、NOT ゲートが 2 tick 周期で点滅していた（DN-RS-12）。
- **`settle` が非循環回路を OSCILLATING と報告していた。** `SETTLE_TICK_LIMIT = MAX_POWER_LEVEL + 2` の
  根拠は「ワイヤ最長走行距離 + 2」だが、収束時間を決めるのは減衰ではなく直列の遅延素子数である。
  リピーター 16 個の直列（ワイヤ 0 本、ループ無し）は 18 tick 必要で、既定の 17 では嘘の判定が出た（DN-RS-4）。
- **`isLit` がランプ 1 個ぶん漏れていた。** `propagateTick` は正しく——ランプは伝導しない——
  漏れていたのは accessor のほうで、隣接セルの電力を見るため「点灯」だけが 1 マス余分に伝わった（DN-RS-5 §5-1）。

**この 3 つはいずれも当時の 21 本の電力グラフテストが捕まえていなかった。**
理由は本節冒頭と同じで、テストは最終状態を assert し、これらの最終状態は**期待どおり**だった。
壊れていたのは「電源を外したあと」「隣に何があるか」「何 tick 目か」であり、
それを見るために作られたのがこのプレビューである。

#### 5 部品を足したときにプレビューが見つけたこと

- **コンパレータの減衰**（`--stats` の finding、`comparator-ladder` シナリオ）。
  4 段のラダーが `15, 14, 13, 12` を返す。バニラは全部 15 である。
  これは `MAX_POWER_LEVEL` が既に記録していた乖離だが、**到達距離の話としてしか書かれていなかった**——
  「数を次へ渡す部品」で何が起きるかは、ラダーを実際に組んで power ビューを見るまで誰も書いていない。
  DN-RS-13 がその finding である。
- **側面が同じ値だとモードの差が消える。** `comparator-sides` シナリオの最初の版は、
  側面レバーをコンパレータの 2 マス上に置いていた。すると側面は背面と同じ 14 になり、
  compare は**等号で通る**ので 14、subtract は 0 になる。
  境界ケースだけを実演するシナリオになっていたので、側面の走行を 1 マス伸ばしてある
  （13 対 14 → compare 14、subtract 1）。**説明用の回路は、説明したい規則の一般ケースに置く**という話であり、
  組んで数を見るまで気づかない類のものである。
- **2D 盤面ではコンパレータの側面と側方は同じセルである。** プレビューの格子は 4 近傍なので、
  「読むが駆動してはならないセル」が 1 つに重なる。テストでは 2 つに分けて書けるので、
  重なった場合が正しいことはプレビューでしか見えない（重なっても側方は 0 のままである）。

確認できた finding は `test/power-graph.test.ts` に assertion として落とすこと。
レポートは読まれなければ効かないが、テストは落ちる。
**`--stats` の行は pin ではない**——実行時に測って期待値を記録しないので、
直すと finding は「消える」のであって「固定される」のではない。
7 件のうち 4 件を直し、残る 3 件（vanilla との到達距離の差、リピーター遅延、ボタンのパルス）は
**現在の挙動を名指しするテスト**を置いた。deferred であることと、記録されていないことは違う。

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

## 6. カバレッジ — 99% ゲートは有効である

**閾値は 4 指標すべてに設定してある。** 参照実装（`takeokunn/ts-minecraft`）と同じ 99% である。

```typescript
// vitest.config.ts
thresholds: { branches: 99, functions: 99, lines: 99, statements: 99 },
```

現在の実測値は **statements 100 / branch 100 / functions 100 / lines 100**（181 テスト、2026-07-27）。

閾値を置かなかった理由は「スケルトンに課しても意味がない」であり、その前提はもう成り立たない。
`domain/` は電力グラフ・コンパレータ演算・ピストン押し出し・オブザーバ・ホッパー・ディスペンサ・
重量感圧板を持ち、`stages/` は stage 契約を持つので、パーセンテージがようやく
**実装の挙動についての主張**になった。

実測が 100 でも閾値を 100 にしないのは、ゲートが守るのは**退行**だからである。
現在値ぴったりに固定すると無関係なリファクタのたびに赤くなり、
「テストを書く」ではなく「数字を下げる」を学習させてしまう。1% はこのパッケージでは分岐 1 本強にあたる
——コミット 1 つ分の余裕であって、機能 1 つをテスト無しで入れられる幅ではない。

`vitest.config.ts` と CI ワークフロー（`Coverage (99% gate)` ステップ）の**両方**で有効にしてある。
閾値そのものは `vitest.config.ts` にしか書かない——`vitest run --coverage` が自力で非ゼロ終了するので
CI 側に追加のフラグは要らず、そうしておけば手元の `pnpm test:coverage` と CI が同じ判定をする。
**「push して初めて落ちるゲート」を作らないための配置**である。

なお `pnpm verify` はカバレッジを含まない（`pnpm test` であって `pnpm test:coverage` ではない）。
`domain/` や `stages/` の分岐に触ったら `pnpm test:coverage` も走らせること。

計測対象は `index.ts` / `domain/**/*.ts` / `stages/**/*.ts`（`vitest.config.ts:31`）。
`scripts/` と `test/` は対象外。

### 6-1. 有効化に要したテストは 1 本だった（そしてそれが DN-RS-11 の請求書である）

有効化の直前、branch は **99.31%** で、未到達の分岐は**全体でちょうど 1 本**だった。
`sourcesOf` の背面読み取り `component.inputFrom === undefined ? 0 : …` の `0` 側、つまり
**`containerSignal` も `inputFrom` も持たないコンパレータ**である。

これは死んだ分岐ではない。**プレイヤーがコンパレータを置いた直後の状態そのもの**であり、
「隣接しているだけの導線は背面にならない」という規則がここに掛かっている。
なので数字ではなく規則を主張するテストを 1 本足した
（`test/power-graph.test.ts` の「an edge is not a rear」。すぐ下の `sideInputs` のテスト——
**名前が付いた側面は辺が無くても読まれる**——のちょうど鏡像になっている）。

**1 本で済んだ理由は、テストの側ではなくコードの側にある。**
このリポジトリは最初から「到達不能な分岐を残さない」という規律（DN-RS-11）で書かれている。
`sourcesOf` が閉じた union に対して `switch` ではなく if 連鎖なのはそのためで、
`switch` にすれば oxlint の `default-case` が要求する `default` 節が
**型として到達不能なまま永久にレポートに赤く残る**。
その規律を守ったリポジトリは、ゲートの前に立った時点ですでに通っている——
**これが DN-RS-11 を守る理由であり、請求書が来たのがここだった**というだけである。

### 6-2. 除外している 1 件と、除外しなくてよかった 1 件

`domain/position-key.ts` は計測対象から除外してある（`vitest.config.ts:32-42`）。
型エイリアス 1 行だけで実行可能な文が 0 のファイルを、v8 provider は 100% ではなく **0%** と報告するため、
headline の数字が無意味になる。

```typescript
// PURE_TYPE: a single type alias, zero executable statements. v8 reports
// such a file as 0% rather than 100%, which would make the headline
// number meaningless.
```

**除外は「測れないもの」に限り、「測ると都合が悪いもの」には使わない。**
このファイルは kernel 公開時に削除される（[versioning.md](./versioning.md) §6）ので、除外も一緒に消える。

**除外していない同種のファイルが 1 つある。`domain/block-ref.ts` である。**
これも型エイリアス 1 行のファイルで、レポートの自分の行は同じく `0 | 0 | 0 | 0` と出る。
それでも headline は 100 のままで、閾値も通る——**合計は「覆われた数 / 総数」で計算され、
文が 0 本のファイルは 0/0 を足すだけだから**である。

つまり上の「headline の数字が無意味になる」は**行の見た目についての話であって、
ゲートについての話ではない**。`position-key.ts` の除外は headline を守るためではなく、
**レポートを読む人が赤い行を無視する習慣を付けないため**にある——
無視してよい赤があると、無視してはいけない赤も同じ扱いを受ける。
`block-ref.ts` は現にその赤い行として残っているので、除外リストを揃えるか、
両方残して「0/0 は合計に効かない」をここで一度説明しておくかのどちらかになる。
**後者を選んだ**。除外リストは短いほうがよく、この段落があれば次の読み手は 2 度目に驚かない。

## 7. 参照実装のテストはオラクルである

plan.md §8 のリスク対策:

> 参照実装を仕様書として使い、テスト資産を各 Step で**先に**移植。**ゼロから仕様を再発明しない**

レッドストーンは仕様が細かい。「トーチは支持セルを電源にしない」「リピーターは前 tick を読む」
「コンパレータは背面 ≥ 側面のときだけ出力する」——どれも参照実装のテストに答えが書いてある。

参照実装のテスト資産は **2,658 行**あり、ソース 1,664 行より多い（[porting.md](./porting.md) §3）。
以前ここは 2,093 と書いていた。足し算は合っていて、数えた集合が足りていなかった——§4-3 と porting.md §3-0。
**この比率がこのリポジトリの移植戦略を決めている**: 移植すべき主資産はソースではなくテストである。

再発明してはならない。参照実装のテストを読み、期待値を持ってきて、その上で実装を書くこと。
