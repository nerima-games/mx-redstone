# 設計ノート

plan.md §3.12 の「設計注意」は 1 行しかない。しかし参照実装のレッドストーンには、
1 行では書ききれない量の実測知見が残っている。本書はそれを `DN-RS-1` 〜 `DN-RS-12` として番号づけし、
**それぞれを「名前のついた回帰テスト」に対応させる**。

回帰テストになっていない設計注意は、いずれ「たぶん間違いだろう」と直される。
したがって各項は「規則 → 参照実装の証拠（`path:line`） → 破れたときに起きること → それを止めているテスト」の順で書く。

---

## DN-RS-1 `pistonImmovable` は kernel の能力フラグである

**本リポジトリで最も重要な設計注意。** plan.md §3.12 の設計注意欄そのものである。

> ピストンの不可動ブロック集合は能力フラグ（`pistonImmovable`）で kernel に定義（参照実装はローカル定数だった）

### 参照実装の実測

`packages/app/application/frame/stages/redstone-piston-world-effects.ts:12-33` に
**20 エントリ**の `const PISTON_IMMOVABLE_BLOCKS: ReadonlySet<BlockType>` がある。

```
AIR, BEDROCK, WATER, LAVA, FIRE, NETHER_PORTAL, END_PORTAL, END_PORTAL_FRAME,
END_PORTAL_FRAME_FILLED, END_GATEWAY, DRAGON_EGG, END_CRYSTAL, PISTON, PISTON_HEAD,
CHEST, FURNACE, SHULKER_BOX, ANVIL, CAULDRON, WATER_CAULDRON
```

消費は同ファイル `:47-48` の `isPistonMovableBlock`（`:48` が `!PISTON_IMMOVABLE_BLOCKS.has(blockType)`）。

この 20 個は 1 つ残らず**ブロックについての挙動判断**であり、
それがたまたま消費する側のファイルに書かれている。plan.md §3.1 が消し去ろうとしたパターンそのものである。

> 参照実装では挙動判定が `blockTypeToIndex('SAND')` 式の名指しで **51 ファイル 229 箇所**に散らばり、
> エンジンとコンテンツの分離を不可能にした。

実務的な代償は「ブロックを 1 つ足すたびに、この種のリストを全部探して直す」ことである。
1 つ見落とせば、その新ブロックはピストンで虚空へ押し出せる。

### 権威は監査であって plan.md ではない

**能力フラグの一次資料は `mc-kernel/docs/capability-flag-audit.md` である。**
既に書かれており、§3 のサマリ表に `pistonImmovable` の行がある。

| capability | 型 | 答える問い | 出現数 | plan.md |
| --- | --- | --- | --- | --- |
| `pistonImmovable` | boolean | ピストンが押せるか | 5 | ✅ (§3.12) |

boolean であること、参照実装での出現が 5 箇所であること、plan.md §3.12 に裏づけがあることが記録されている。
本リポジトリはこの表に従う。ここと監査が食い違ったら**監査が正しく、本リポジトリを直す**。

監査は自身の計数条件も開示している（同 §2）。
ブロック名リテラルの生出現は **335 箇所 / 80 ファイル**、比較文脈に限れば **192 箇所 / 61 ファイル**、
メンバーシップテーブルは **約 30 定義 / 28 ファイル**、和集合 **78 ファイル**。
plan.md の 51/229 とは一致しないが、監査自身が §2-4 で

> plan.md §3.1 の「51ファイル229箇所」とは計数条件（テスト除外・比較文脈限定）が異なる。
> 定義の差であり、どちらかが誤りとは判断しない。

と明記している。**数字を引くときは条件も一緒に引くこと。**
（`mc-kernel/docs/design-notes.md` §1-1 はさらに別の条件で 90 箇所 / 38 ファイルと測り直しており、
条件を書かない計数がいかに再現しないかの実例になっている。）

### 本リポジトリの構造的防御

`domain/piston.ts` には**ブロック名が 1 つも書かれていない**。能力は引数で受け取る。

```typescript
export type BlockCapabilityLookup = {
  /** kernel's `pistonImmovable` flag (capability-flag-audit.md §3). */
  readonly pistonImmovable: (block: BlockRef) => boolean
}
```

`BlockRef = string` を不透明なまま扱い、`planPush` は `capabilities.pistonImmovable(block)` を呼ぶだけである
（`domain/piston.ts:117-131`）。
「押せるかどうか」を決める権限がこのファイルに存在しないので、ローカル定数を書く場所がない。

**回帰テスト**: `test/piston.test.ts`
`describe('REGRESSION: the immovable set is a kernel capability flag, not a local constant')`

| テスト名 | 主張 |
| --- | --- |
| `a block name this repository has never heard of is immovable if — and only if — the lookup says so` | `QUANTUM_OBSIDIAN` という本リポジトリのどこにも現れない名前が、注入された lookup の言うとおりに振る舞う。ローカルリストがあれば注入で答えが変わらないので、2 つの assert のどちらかが落ちる |
| `the blocks the reference hardcoded are decided by the caller here, every one of them` | 参照実装の 20 エントリを逐語で並べ、**全部が呼び出し側の決定**であることを確認する |
| `a lookup that never refuses makes every block pushable, including bedrock` | 「岩盤が押せる」というゲーム規則として無意味な状態が成立する。それが正しい。mx-redstone は岩盤について意見を持たない |

3 番目は一見ばかげているが、これが本質である。**意見を持たないことをテストする**という形になっている。

---

## DN-RS-2 トーチは入力を 1 tick 遅れで反転する

### 規則

赤石トーチは、取り付けたセルの電力を反転して出力する。ただし**前 tick の電力**を読む。

```typescript
const inputPower =
  component.invertedBy === undefined ? 0 : powerAt(previous, component.invertedBy)
if (inputPower === 0) {
  sources.set(key, MAX_POWER_LEVEL)
}
```

`domain/power-graph.ts:117-126`（`sourcesOf` は `:106-148`）。`previous` は省略可能な引数ではなく必須引数である。

### なぜ実装上の都合ではないのか

**この 1 tick の遅延こそが、ゲーム内のあらゆるクロック・単安定・メモリセルの構成素子である。**
遅延がなければ NOT ゲートしか作れない。遅延があるから発振でき、発振できるから
「一定間隔で何かをする回路」が作れる。

現在の電力マップからトーチ状態を計算すると、トーチのループは発散するか一定値に張り付くかのどちらかになり、
**全プレイヤーのワールドの全クロック回路が動かなくなる**。
参照実装も同じ構造を取っている: `redstone-simulation.ts:254` の `updateTorches` は
propagate 後の `powered` マップを引数に受け取り、`redstone-service.ts:56-58` は
リピーターについて明示的にこう書いている。

> Repeaters sample the PREVIOUS tick's power at their rear cell — the one-tick delay falls
> out of the ordering.

### 実装上の罠（ソースに記録済み）

`domain/power-graph.ts:150-163` が、実装中に踏んだ罠を残している。

**電力を「受け取れる」のはワイヤとランプだけである。**

```typescript
const RECEIVES_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>(['wire', 'lamp'])
```

初期の版ではあらゆる部品が受電できた。すると、自分が反転しているワイヤの隣に立っているトーチが、
**消えるはずのその tick に、そのワイヤ自身から再点火される**。
結果は「絶対に消えないトーチ」であり、したがってクロックも単安定もメモリセルも存在しないゲームである。

症状は「回路が常に ON」であり、原因（受電可能集合が広すぎる）とは似ても似つかない。
だからこの定数には長いコメントが付いている。

参照実装の `canConduct`（`redstone-simulation.ts:24-34`）も同じ結論に達しており、
Wire / Lever / Button / Torch / Piston / PressurePlate / Observer / Repeater / Comparator / Dispenser を導通側に列挙し、
**Lamp と Hopper を除外している**。

**回帰テスト**: `test/power-graph.test.ts`
`describe('torch inversion — the one-tick delay every clock is built from')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: the torch reads the PREVIOUS tick, so inversion takes one tick rather than being instant` | tick 1 では base が点いてもトーチはまだ燃えている。tick 2 で消える。現在マップから計算すると 2 tick が 1 tick に潰れる |
| `a torch with an unpowered input burns` | 無入力 = 点灯という反転の基本形 |
| `a torch with no attachment is a permanent source, which is how a constant is written` | 取り付け先のないトーチは定数源。これが定数の書き方である |

受電集合のほうは `describe('wire propagation')` の
`REGRESSION: a lamp receives power but does not conduct it, so circuits do not join through one`
が別角度から固定している（DN-RS-5）。

**「無入力 = 点灯」はトーチだけの規則である。** リピーターに同じ既定を与えてはならない。
`describe('repeaters')` の
`a repeater with no input at all is inert, not a source`
がその非対称性を固定している——プレイヤーが置いたばかりで配線していないリピーターが電源になったら、
**設置のたびに落とし込んだ回路が通電する**。
`sourcesOf` のリピーター分岐が `inputPower > 0` を要求し、トーチ分岐が `inputPower === 0` を要求している
（`domain/power-graph.ts:117-136`）のは、この非対称が意図的であることの現れである。

---

## DN-RS-3 レッドストーンは固定レートで進む。フレームレートではない

### 規則

バニラのレッドストーンは 10 Hz の固定レート（redstone tick）で動き、描画フレームレートとは独立である。
`REDSTONE_TICK_SECS = 0.1`（`stages/registration.ts:39`）。

### 破れたときに起きること

電力グラフを 1 フレームに 1 回進めると、**速いマシンではリピーターチェーンの伝播が速くなる**。
プレイヤーが作ったタイミング回路（クロック、遅延ライン、モノステーブル）が全部ずれる。

これは**ユニットテストが検出しない種類のバグ**である。テストは 1 tick ずつ手で進めるので、
「1 フレームが 1 tick かどうか」を問わない。プレイヤーのマシンでしか現れない。

参照実装はまさにこの形をしていた。`redstone-service.ts:321` の `tick()` は
`(): Effect.Effect<RedstoneTickSnapshot, never>` という**引数のないシグネチャ**で、
`interaction-redstone-handler.ts:113` から

```typescript
Effect.flatMap(() => services.redstoneService.tick()),
```

として毎フレーム呼ばれる。dt はどこにも入っていない。

### 実装

`ticksForFrame`（`stages/registration.ts:96-117`）が dt を redstone tick 数と余りに変換する。

```typescript
const available = accumulatedSecs + Math.max(0, dt)
const wanted = Math.floor(available / tickSecs)
const ticks = Math.min(wanted, maxTicks)
const remainderSecs = wanted > maxTicks ? 0 : available - ticks * tickSecs
```

3 つの決定がある。

1. **余りを繰り越す。** 60 fps の 1 フレームは 0.167 redstone tick である。
   毎フレーム累積をリセットすると `floor(0.0167 / 0.1)` は永遠に 0 で、
   **レッドストーンは一度も動かない**。繰り越しがこの機構の全部である。
2. **追いつきループに上限を置く**（`MAX_TICKS_PER_FRAME = 4`、`stages/registration.ts:49`）。
3. **上限に当たったとき、余った時間は捨てる。** 繰り越すと次フレームも予算超過が確定し、
   その次も超過する——古典的な spiral of death である。捨てると 1 フレームだけレッドストーンが遅れるが、
   プレイヤーには見えない。フリーズは見える。

### plan.md §3.4 の dt クランプに依存しない

plan.md §3.4 は deltaTime を `min(max(0.001, raw), 0.05)` にクランプすると定めており、
これは mc-sim が上流で適用する。したがってデバッガの一時停止が 10 秒の dt を届けることは原理的にない。

それでも `MAX_TICKS_PER_FRAME` を置いてあるのは、`stages/registration.ts:22-26` が書いているとおり

> relying on somebody else's clamp is how you discover it was removed

だからである。上流のクランプは上流の都合で消える。**自分の不変条件は自分で守る。**

**回帰テスト**: `test/stage-registration.test.ts` `describe('fixed-rate redstone ticks')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: the tick remainder is carried across frames, so redstone does not stop dead at 60 fps` | 600 フレーム回して `executed * REDSTONE_TICK_SECS + accumulated` が経過時間と一致する（シミュレーション時間が失われない）。素朴版は同条件で **0 tick** |
| `REGRESSION: a long frame is capped and the excess is DISCARDED, not banked (no spiral of death)` | dt=10 で `ticks === 4` かつ `remainderSecs === 0` |
| `a frame shorter than one tick runs nothing and banks the time` | 0.016 秒は 0 tick + 0.016 秒の貯金 |
| `dt = 0 runs nothing and loses nothing` | ゼロ dt は合法。stage 側で拒否しない |
| `a negative dt is treated as zero rather than rewinding the accumulator` | 負の dt で累積が巻き戻らない |
| `a zero tick rate runs nothing instead of dividing by zero` | `tickSecs: 0` で `Infinity` tick ではなく 0 tick。プレビューが tick レートのスライダを 0 まで下げても止まるだけ |

1 番目のテストのコメントは、なぜ実行数が 100 ではなく 99 になるかまで書いてある——
浮動小数の反復減算で最後の 1 tick が閾値をわずかに下回るだけで、時間は `accumulated` の中にある。
**「99 は 100 の間違いだろう」と直されないための注記**である。

---

## DN-RS-4 レッドストーンクロックは収束しない

### 規則

不動点探索には必ず上限が要る。そして上限に当たったときは**ハングではなく文書化された答え**を返す。

```typescript
export const settleTickLimitFor = (board: CircuitBoard): number => /* … */ delayed + 2
export type SettleResult = {
  readonly power: PowerMap
  readonly ticks: number
  /** `true` when the limit was reached without reaching a fixpoint. */
  readonly oscillating: boolean
}
```

`domain/power-graph.ts:234-249`。

### なぜ当たり前ではないのか

「回路が安定するまで回す」は自然な API だが、**クロック回路は定義上決して安定しない**。
安定しないことがクロックの目的である。上限のない `settle` はプレビューの「安定まで進む」ボタンを押した瞬間にフリーズする。

`oscillating: true` は**エラーではなく答え**である。呼び出し側（プレビュー、テスト）は
「この回路は発振している」と表示できる。例外や `undefined` ではこの区別ができない。

なお、フレーム stage は `settle` を呼ばない。ゲームは 1 redstone tick ずつ進む——
途中経過こそがプレイヤーの見ているものだからである。

### 上限を決めるのは減衰距離ではなく直列の遅延素子数である

**この節は一度間違っていた。** 上限は定数 `SETTLE_TICK_LIMIT = MAX_POWER_LEVEL + 2 = 17` であり、
根拠は「非循環回路なら最長のワイヤ走行（15 マス）より 2 tick 多ければ必ず落ち着く」と書かれていた。
**この文は間違った量を測っている。**

ワイヤ走行は何マスあっても **1 tick で解決する**。`propagateTick` は盤面全体に対する BFS であり、
減衰は tick を 1 つも消費しない。tick を消費するのは `previous` を読むことだけで、
それをするのはトーチとリピーターの 2 つだけである。

したがって定数は 15 素子までは「間違った理由で正しく」、16 素子から単に間違っていた。
リピーター 16 個の直列はワイヤ 0 本・ループ無しで 18 tick 必要であり、
`settle` は**完全に安定した回路に `oscillating: true` を返していた**（20 素子 → 22 tick、24 → 26）。
フラグを信じる呼び出し側——「あなたの装置はクロックです」という警告、
安定した領域の tick を止めるスケジューラ——は、実在するあらゆるリピーターチェーンで誤答を受け取る。

正しい上限は `settleTickLimitFor(board)` である。

- **直列の遅延素子 1 つにつき 1 tick。** 素子は入力が確定する前に確定できないので、
  深さ *d* の素子は tick *d+1* で確定する。直列の最長鎖は盤面上の遅延素子数を超えられないので、
  **数えるだけで健全な過大評価**になる。「最長鎖」と違って O(components) で済み、
  遅延グラフに閉路がある盤面でも定義され続ける。
- **+1** は最終マップを生成する tick。
- **+1** は「変わらなかった」ことを観測する tick。不動点は、何も変えない tick を 1 つ回して初めて分かる。

遅延素子が 0 個の盤面は 2 になる。これはちょうど正しい（1 tick で全ワイヤが点き、1 tick で確認）。
**この上限は tight であって余裕を持たせていない。** 余裕は、モデルに 3 つ目の遅延素子が増えて
`DELAYED_KINDS` への追加を忘れた日を隠してしまう。

定数を残さず**名前ごと関数に置き換えた**のは、「1 つの数で全盤面を束ねられる」という主張自体が
defect だったからである。`SETTLE_TICK_LIMIT` を覚えていた人は、間違った数字ではなくコンパイルエラーを受け取る。

これは本プロジェクトで一度直した地形定数と同じ形である。**値が変わるかどうかは二の次で、
根拠が実際に上限を決めている量と一致していることが要件である。**

**回帰テスト**: `test/power-graph.test.ts` `describe('settling and oscillation')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: a torch clock never settles, and \`settle\` says so instead of hanging` | 自分自身を反転する最小クロックで `oscillating === true` かつ `ticks === settleTickLimitFor(board)` |
| `REGRESSION: the settle bound counts DELAY ELEMENTS, not wire cells, so no acyclic circuit is called a clock` | 長さ 2 / 15 / 16 / 24 のリピーター鎖で、既定の答えと `limit: 4096` の答えが**一致する**。数字ではなく性質を assert している——陳腐化したのは数字のほうだからである |
| `the bound is one tick per delay element plus two, and wire length does not enter it` | ワイヤ 40 本の盤面で上限が 2。トーチとリピーターは等しく 1 ずつ数えられ、ランプとレバーは数えられない |
| `settle can resume from a given power map, which is what the preview step button needs` | 途中の電力マップから再開できる |
| `a resumed map that disagrees with the board is RECOMPUTED, not trusted` | `from` に嘘の電力レベル（`w0: 99`）を渡しても、1 tick 目で訂正され、不動点と誤認されない |

最後の 1 つは `from` の意味を確定させている。**`from` は遅延部品（トーチ・リピーター）の出発点であって、
ワイヤのレベルについての主張ではない。** プレビューは編集途中のマップや、
すでに変わった盤面の残骸を渡してくる。それを信用すると、間違った状態が「安定した」と報告される。

---

## DN-RS-5 ランプは電力を通さない

### 規則

```typescript
const CONDUCTS_POWER: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'wire', 'lever', 'button', 'torch', 'repeater',
])
```

`domain/power-graph.ts:173-179`。ランプが入っていない。

### 破れたときに起きること

ランプに導通を許すと、**その両側にあった 2 つの独立した回路が黙って 1 つに溶接される**。
症状は「関係ないはずの回路が連動する」であり、原因の場所（ランプ 1 個）からは最も遠いところに現れる。
初心者が必ず一度やるバグであり、参照実装の `canConduct`（`redstone-simulation.ts:24-34`）も
Lamp を導通側に入れていない。

派生として、ランプの点灯判定は自分のセルの電力ではなく**自分に給電しているセル**の電力で行う。

```typescript
export const isLit = (board: CircuitBoard, power: PowerMap, key: PositionKey): boolean =>
  board.components.get(key)?.kind === 'lamp' &&
  neighboursOf(board, key).some(
    (neighbour) => powerAt(power, neighbour) > 0 && conductsInto(board, neighbour).includes(key),
  )
```

参照実装も同じ結論で、`redstone-lamp-world-effects.ts:77-78` に

> Vanilla: a lamp lights from an adjacent powered cell, not from power at its own
> (non-conducting) position — which the sim always reports as 0.

と書かれている。

### 5-1. この判定は一度「隣接セル」だけを見ていて、ランプ 1 個ぶん漏れていた

以前の実装は `neighboursOf(...).some((n) => powerAt(power, n) > 0)` だった。
`propagateTick` の側は**一貫して正しかった**——ランプは `CONDUCTS_POWER` に無いので、
2 つ目のランプの電力は 0 である。漏れていたのは accessor のほうで、
理由は**ランプが `RECEIVES_POWER` に入っている**ことにある。
点いたランプは自分の減衰済みレベルを持つので、`isLit` から見れば「電力を持つ隣接セル」であり、
**点灯だけが電力より 1 マス余分に伝わった**。ランプ 2 個が並ぶと 2 個とも点き、3 個目は点かない。

DN-RS-5 冒頭が警告している「2 つの独立した回路が黙って溶接される」という失敗の、
sweep ではなく accessor で起きた版である。同じ規則を 2 か所に書けば必ず片方だけ直る。
だから `isLit` は `conductsInto` を sweep と**共有**しており、両者が食い違えなくなっている。
リピーターの側面に置いたランプが暗いのも、電力が来ないのと同じ 1 つの理由による。

**「自分のレベル > 0」ではない。** そのほうが短く、上の 3 ランプ試験も通る。しかし
ワイヤ走行の末端で誤る: レベル 1 のワイヤは渡せるものが残っていない（`outgoing` が 0）ので
隣のランプの電力は 0 になるが、バニラではそのランプは**点く**。

**回帰テスト**: `test/power-graph.test.ts` `describe('wire propagation')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: a lamp receives power but does not conduct it, so circuits do not join through one` | ランプは点灯する（`isLit === true`）が、その向こう側のワイヤは `0` のまま |
| `isLit is false for a component that is not a lamp, however much power it carries` | 電力を持つワイヤは「点灯」しない。`isLit` が電力の言い換えになっていないことの確認 |
| `REGRESSION: a lit lamp does not light the lamp behind it — litness stops where power stops` | ランプ 3 個で、点くのは 1 個目だけ。2 個ではなく 3 個並べているのは、「2 個目が暗い」は「何も点かない規則」でも成立するからである |
| `a lamp beside the LAST wire of a run is lit, though its own power entry is 0` | 「自分のレベル > 0」という短絡を塞ぐ。レベル 1 のワイヤの隣のランプは点く |

---

## DN-RS-6 押し出し拒否の理由を区別する

### 規則

```typescript
export type PushRefusal = {
  readonly reason: 'immovable' | 'too-long'
  readonly at: number
}
```

`domain/piston.ts:88-92`。拒否は boolean ではなく理由つきである。

### なぜ

**プレイヤーにとって 2 つは違うことを意味する。**

- `immovable` = 「黒曜石は押せません」→ 設計を変えるしかない
- `too-long` = 「その装置は 1 ブロック大きすぎます」→ 1 個減らせば動く

`undefined` に潰すと（参照実装の `isPistonMovableBlock` という boolean 述語が実質そうだった）、
どちらも説明できない。`at` を返しているのも同じ理由で、
「列のどこで拒否されたか」が分かればプレビューでその位置を光らせられる。

`PISTON_PUSH_LIMIT = 12` はバニラの上限であり、**能力ではなく規則**なので kernel ではなくここに置く
（`domain/piston.ts:70-76`）。「ブロックとは何か」は kernel、「ピストンがどう振る舞うか」はここ、という分割である。

**回帰テスト**: `test/piston.test.ts` `describe('push planning')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: the two refusals stay distinguishable, because they mean different things to a player` | 2 つの拒否結果が `toStrictEqual` で等しくならない |
| `exactly 12 blocks move; the next one refuses with a distinguishable reason` | 上限ちょうどは押せ、1 つ超えると `{ reason: 'too-long', at: 12 }` |
| `an immovable block anywhere in the run refuses the whole push, and says where` | 列の途中の不可動ブロックが全体を拒否し、位置を返す |
| `the returned plan is a copy, so a caller cannot mutate the column it passed in` | 返り値の `moved` が入力配列そのものではない |

---

## DN-RS-7 `after` は制約だけ。全順序は mc-compose

plan.md §2.3-3。詳細は [public-api.md](./public-api.md) §3-1 / §4-1 に書いたので、ここでは
**なぜこれが import ゲートで守れないか**だけを繰り返す。

`StageId` は文字列である（`domain/frame-contract.ts:41`）。

```typescript
export type StageId = string & Brand.Brand<'StageId'>
```

文字列であることは意図的で、`after: [StageId('sim:physics')]` と書けば
mc-sim の stage モジュールを import せずに順序を表現できる。
しかし同じ性質により、`after: [StageId('gameplay:fluids')]` と書いても
**`pnpm check:deps` には何も見えない**。import 文が 1 行も増えないからである。

だから穴は 2 つあり、塞ぐものも 2 つある。

| 破り方 | 塞ぐもの |
| --- | --- |
| `import ... from '@nerima-games/mx-gameplay'` | `scripts/check-dependency-whitelist.ts` |
| `after: [StageId('gameplay:fluids')]` | `test/stage-registration.test.ts` |

**回帰テスト**: `test/stage-registration.test.ts`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: no \`after\` edge names another experience module, even though §4.2 puts redstone between gameplay stages` | 全 `after` 辺を集め、`gameplay:` / `ui:` / `multiplayer:` で始まるものが 1 本もない |
| `REGRESSION: every declared upstream stage belongs to a foundation repository` | `UPSTREAM_STAGE_IDS` 側も同条件 |
| `REGRESSION: a registration carries constraints and nothing else — no priority, no index` | 登録オブジェクトのキーが `['after', 'id', 'run']` だけ |
| `StageId rejects a blank id` | 空白だけの id は `Brand.refined` で弾かれる |

テスト名に「§4.2 が redstone を gameplay の stage 群の間に置いているにもかかわらず」と入っているのは、
このテストを見た人が「骨格に従っていないのでは」と思って**直しにこないため**である。

---

## DN-RS-8 初期化は再入可能でなければならない

### 規則

`makeRedstoneFrameState` は定数ではなく Effect である。

```typescript
export const makeRedstoneFrameState: Effect.Effect<RedstoneFrameState> = Effect.gen(function* () {
  const board = yield* Ref.make<CircuitBoard>(emptyCircuitBoard)
  ...
})
```

`stages/registration.ts:78-85`。呼ぶたびに新しい `Ref` 4 本が生まれる。

### なぜ

plan.md §3.8 が参照実装の最大級のバグ源としてこう記録している。

> **ゲームループ・自動保存は `forkDaemon`**（スコープ非依存）+ 明示 `stop()`。
> 参照実装では 2 周目ワールドのデッドロック/やり残し fiber が最大級のバグ源だった。
> アプリスコープのシングルトンは**再入可能な初期化**を最初から

モジュールレベルの `const state = { board: Ref.unsafeMake(...) }` は書きやすく、
**2 つ目のワールドが 1 つ目の `Ref` を継承する**。回路盤プレビューを 1 ページに 2 つ置けば、
2 つの盤面が同じ `Ref` を共有する。

**回帰テスト**: `test/stage-registration.test.ts` `describe('stage behaviour')`

| テスト名 | 主張 |
| --- | --- |
| `each call to makeRedstoneFrameState yields independent state (re-entrant initialisation)` | 2 回呼んで一方に盤面を入れても、他方の `components.size` が 0 のまま |

---

## DN-RS-9 `Date.now()` 禁止

### 規則

plan.md §4.3 / §5.1-3。時刻はすべて注入されたクロック Port から取る。
`Date.now()` / `new Date()` / `performance.now()` の 3 つが禁止される。

### なぜこのリポジトリで概念的に最も重いのか

DN-RS-3 のとおり、レッドストーンは**固定レートのシミュレーション**である。
固定レートのシミュレーションが壁時計を読んだ瞬間、それは**再現しない**。
同じ入力列を同じ順で流しても同じ結果にならない。

すると回路シナリオテストが意味を失う。「fixture 回路 → 期待状態」が成立するのは、
tick が壁時計と無関係だからである（[testing.md](./testing.md) §5）。
他リポジトリでは「決定論のために望ましい」規則だが、ここでは**検証手法の前提条件**である。

### 実装が oxlint ではなく `check:deps` にある理由

oxlint 0.12 は `no-restricted-syntax` も `no-restricted-properties` も実装しておらず、
`no-restricted-globals` は `oxlint --rules` の一覧に出るが実装されていない。
3 ルールすべてを設定した状態でも `Date.now()` を含むファイルの診断が 0 件であることが
0.12.0 で実測確認されている（`.oxlintrc.json` の冒頭コメント、`scripts/check-dependency-whitelist.ts:43-49`）。

そのため禁止は `findBannedTimeSources`（`check-dependency-whitelist.ts:847-875`）にある。
コメント・文字列リテラル・正規表現リテラルの中身は `maskSource` でマスクされるので誤検知しない。
クロック Port の実装アダプタだけは実クロックを読む必要があるため、
`mc-kernel-allow-time-source` コメントで除外できる。

oxlint が該当ルールを実装したら `.oxlintrc.json` 側へ移す。

**回帰テスト**: `test/check-dependency-whitelist.test.ts`
`describe('§4.3: the clock is injected, never read from a global')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: Date.now(), new Date() and performance.now() are all rejected` | 3 つとも `banned-time-source` として行番号つきで報告される |
| `a mention of Date.now() inside a comment or a string is not a violation` | マスクが効いており、本ドキュメントのような記述で CI が落ちない |

---

## DN-RS-10 スティッキーピストンと引き寄せは第一版のスコープ外

### 決定

`domain/piston.ts` は押し出し（`planPush`）だけを実装する。引き寄せは無い。

### なぜ「あとで」なのか

理由は工数ではない。**能力フラグが監査で確定していないから**である。

引き寄せには独自の規則がある。スティッキーピストンはちょうど 1 ブロックを引く。
スライムブロックは隣接ブロックを 3 次元に引きずる。
つまり「このブロックは粘着に引っ張られるか」「引きずり連結を伝播させるか」という
**新しい能力**が要る。`mc-kernel/docs/capability-flag-audit.md` はこれを扱っていない
（§3 の 28 行に該当行が無く、§8 の「参照実装に存在しない概念」にも挙がっていない）。

ここで能力名とセマンティクスを推測すると、その推測が kernel に入る。
kernel は 14 リポジトリからピン留めされるので、**間違った推測が一度に 14 リポジトリへ配られる**
（`mc-kernel/docs/versioning.md` §5-1 の深さ 5 の republish カスケード）。
監査が答えを出すまで待つほうが、確実に安い。

`domain/piston.ts:38-45` がこの判断を「意図的なスコープ制限」として記録している。
未実装であることを README の「現状」にも書いてあるのは、
**忘れられた未実装と、決定された未実装を区別するため**である。

---

## DN-RS-11 到達不能な分岐をコードに残さない

### 規則

**書けてしまうが決して実行されない分岐は、書かない。**
`domain/power-graph.ts` に、この規律のために通常と違う書き方を選んだ箇所が 2 つある。

### 11-1. 閉じた union に対して `switch` を使わない

`sourcesOf` は `ComponentKind` の 6 値に対して `switch` ではなく if 連鎖で分岐している
（`domain/power-graph.ts:106-148`）。理由がコメントに書いてある（`:138-144`）。

> An if-chain rather than a `switch`, deliberately: a `switch` over a closed union needs a
> `default` clause to satisfy oxlint's `default-case`, and that clause is unreachable — an
> uncoverable branch sitting permanently in the report, which is exactly the kind of noise
> that makes a coverage threshold something people learn to ignore.

oxlint の `default-case` は `.oxlintrc.json` で `restriction` カテゴリの一部として有効になっている。
閉じた union に対する網羅 `switch` に `default` を足すと、その節は**型として到達不能**になる。
テストでは絶対に踏めないので、カバレッジレポートに永久に赤い分岐が 1 つ残る。

### 11-2. BFS キューを添字で読まない

`propagateTick` は `for (const key of queue)` でループしている（`:207`）。理由は `:202-206`:

> `for...of` over an array re-reads `length` on every step, so entries pushed inside the loop
> ARE visited — which makes this a BFS queue with no cursor and no `queue[head]` indexed read.
> Under `noUncheckedIndexedAccess` that read would be `PositionKey | undefined` and would need
> an unreachable `undefined` guard, i.e. a branch that can never be covered.

`queue[head]` は `noUncheckedIndexedAccess` の下で `PositionKey | undefined` になり、
`if (key === undefined) continue` を書かされる。その節も決して踏まれない。

### なぜこれが設計注意なのか

**カバレッジ閾値の価値は、100% に近いことではなく「落ちたら本当に何かが抜けている」ことにある。**
到達不能な分岐が数個あるだけで、`branches: 99` は達成不能になるか、
あるいは達成するために `/* c8 ignore */` を撒くことになる。どちらの道も、
最終的に「カバレッジの赤は無視するもの」という文化に着地する。

このリポジトリはまだ閾値を有効にしていない（[testing.md](./testing.md) §6）。
**しかし閾値を入れる日を前提にコードを書いている**というのが、この 2 箇所の意味である。
後から到達不能分岐を掃除するのは、書かないより高い。

同じ判断が `vitest.config.ts:32-42` の除外にも現れている——
`domain/position-key.ts` は型エイリアス 1 行で実行可能な文が 0 であり、v8 provider がそれを 0% と報告するため
計測対象から外してある。**「測ると 0% になるもの」を外すことと「測ると都合が悪いもの」を外すことは違う。**

**回帰テストは無い。** 到達不能な分岐が存在しないことは、実行では確かめられない。
確かめる手段はカバレッジレポートそのものであり、それが 6 節の閾値が最終的に果たす役割である。

---

## DN-RS-12 セルを「読む」部品は、そのセルを「駆動」してはならない

### 規則

隣接（`CircuitBoard.adjacency`）は無向である。**ワイヤについてはそれが全部だが、
セルを読む 2 つの部品についてはそうではない。**

- **リピーターはダイオードである。** 背面から入り、正面から出る。側面からは何も出ない。
- **トーチは取り付け先のブロックに給電しない。**

```typescript
const conductsInto = (board: CircuitBoard, key: PositionKey): ReadonlyArray<PositionKey> => {
  const component = board.components.get(key)
  if (component === undefined || !CONDUCTS_POWER.has(component.kind)) {
    return []
  }
  const neighbours = neighboursOf(board, key)
  if (component.kind === 'repeater') {
    return neighbours.filter((neighbour) => neighbour === component.outputTo)
  }
  if (component.kind === 'torch') {
    return neighbours.filter((neighbour) => neighbour !== component.invertedBy)
  }
  return neighbours
}
```

### 破れたときに起きること

初期の版は、ソースの電力を**全隣接セル**に流していた。結果は 2 つとも**ラッチ**である。

1. **リピーターが自分をラッチして二度と落ちない。** リピーターは自分の入力セル（`inputFrom`）を
   自分の出力で 12 → 14 に持ち上げ、次 tick に `sourcesOf` が「入力に電力がある」と見て
   **自分自身から再点火する**。レバーを切っても、盤面上に電源が 1 つも無くても、出力は 14 のままである。
   **リピーターを含むあらゆる回路が二度と OFF にできない。**
2. **リピーターが側面にも給電する。** リピーターの側面に触れただけの独立回路が 14 になる。
   DN-RS-5 が「ランプに導通を許すと 2 つの独立回路が黙って溶接される」と警告しているのと同じ失敗が、
   **プレイヤーが回路を分離するために置く部品**で起きていた。
3. **トーチが 2 tick 周期で点滅する。** トーチは自分が反転しているワイヤを 14 に駆動し、
   次 tick にそれを読んで消え、その次に戻る。NOT ゲートが 5 Hz の発振器になっていた。
   [testing.md](./testing.md) §7 は「トーチは支持セルを電源にしない」を、
   参照実装が既に決着させた規則として挙げている——新しい意見ではなく、**グラフに書かれていなかった規則**である。

**既存の 21 本の電力グラフテストが 1 本も捕まえていない。** 理由は形にある:
テストは**最終状態**を assert し、レバーが ON のときの最終状態は期待どおりだった。
壊れていたのは「電源を外したあと」と「隣に何があるか」であり、どちらも誰も尋ねていなかった。

### 形の変更であって述語の調整ではない

`CONDUCTS_POWER` は `ComponentKind` の集合であり、**向きを表現できない**。
向きは kind の性質ではなく**設置の性質**だからである。したがって `Component` に出力側の名前が要る。

```typescript
readonly inputFrom?: PositionKey   // リピーター: 読むセル（既存）
readonly outputTo?: PositionKey    // リピーター: 駆動する唯一のセル（新規）
```

決めたことが 3 つある。

| 判断 | なぜ |
| --- | --- |
| **`outputTo` 未指定 = 何も駆動しない**（全隣接ではない） | 正面に何も無いまま置かれたリピーターの状態。防ぐ失敗（2 回路の無言の溶接）は不可視で、招く失敗（何もしないリピーター）は次の tick に画面に出る。`inputFrom` 未指定を「電源にしない」とした DN-RS-2 の非対称と同じ向きである |
| **`neighboursOf` を filter する**（`[outputTo]` を直接返さない） | `adjacency` が**グラフそのもの**である。`outputTo` は自分の辺を 1 本**選ぶ**のであって、新しい辺を**作らない**。さもなければ呼び出し側は遠いセルを名指しして電力をテレポートでき、出力セルを削除された盤面のリピーターは存在しない座標に給電し続ける |
| **トーチは `invertedBy` を除外**（`outputTo` を持たない） | トーチはバニラでも無指向（隣接する全ダストを点ける）。制約は「支持ブロックを除く」という 1 点だけなので、除外で足りる。リピーターに同じ形（`inputFrom` だけ除外）を使うと側面が残る |

### 遅延とパルスの状態は純粋な伝播の外に置く

`Component.delayTicks` と `Component.pulseTicks` は盤面に規則を宣言するが、残り時間は
`TimedCircuitState` が持つ。`advanceTimedCircuit(board, state, pressedButtons)` はリピーターの
1–4 tick 遅延とボタンのパルスを進め、その tick で有効な盤面を `propagateTick` に渡す。
したがって `propagateTick(board, previous)` の 1 tick 伝播契約は互換性のため変わらない。

runtime では `stages/registration.ts` が dimension ごとの `TimedCircuitState` を保持し、
`RedstoneWorldRuntime.pressButton` の入力を次の redstone tick で消費する。押下中の再押下は
残り時間を `pulseTicks`（既定 10 tick）へ戻す。盤面スナップショット自体は書き換えない。

**回帰テスト**: `test/power-graph.test.ts`
`describe('repeaters — a diode, which means both ends are named')` ほか

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: switch the lever OFF and a repeater lets go — it does not latch itself on forever` | ON で 4 tick 回してから電源を切り、2 tick で出力が 0、さらに 20 tick 回して**電力マップが空**になる |
| `REGRESSION: a repeater does not power its own input cell — the wire behind it stays the lever’s level` | ラッチの機構そのもの。入力ワイヤはレバーから 2 歩なので 13 であり、14（リピーター自身の出力の戻り）ではない |
| `REGRESSION: a repeater powers nothing on its flanks, so it cannot weld two circuits together` | 側面のワイヤが 0。側面のランプが `isLit === false` |
| `a repeater with no output named drives nothing — an unwired repeater is inert in both directions` | 既定値の選択そのもの |
| `a named output that is not a declared edge drives nothing — adjacency is still the graph` | 隣接に無いセルを名指しても何も駆動しない |
| `REGRESSION: a torch does not power the cell it inverts, so an inverter is steady rather than a 2-tick blinker` | レバー OFF で 20 tick、トーチは 15 のまま、支持セルは 0 のまま |
| `legacy propagation keeps its one-tick repeater contract when delay metadata is present` | 旧 API は `delayTicks` を解釈せず、従来どおり各リピーターを 1 tick で伝播する |
| `test/timed-power-graph.test.ts` の repeater / button 節 | 1–4 tick の境界、遷移キャンセル、パルス停止、再押下、挿入順非依存を固定する |

---

## DN-RS-13 ソース出力は隣接ダストへ同じ強度で入る

**コンパレータと重み付き感圧板は 0〜15 の値を出力する。** その値を隣接ダストへ
渡すだけで 1 減らすと、算術結果そのものが変わる。

### 規則

`sourcesOf` は各ソースをその出力強度で seed する。`propagateTick` はソースから
隣接セルへ同じ強度を渡し、**ダストが次のセルへ伝えるときだけ** 1 減らす。

```
lever  C  dust  C  dust  C  dust
15     15  15   15  15   15  15
```

これにより、レベル 15 は 15 個のダストへ届き、レベル 4 の感圧板は
隣接ダストを 4、その次を 3、2、1 と駆動し、それ以降は 0 になる。

### 破れたときに起きること

**アイテムソーターが壊れる。** プレイヤーがコンパレータで作る装置のほぼ全部は
「2 つのコンテナの読みを比較する」形をしている。経路のコンパレータの個数が違えば、
**中身が等しい 2 つのチェストが違う数を返す**。到達距離の乖離と違って、これは
「1 マス足りない」ではなく「答えが間違っている」である。

### 回帰境界

**回帰テスト**: `test/power-graph.test.ts`
`describe('comparators — the only component whose output is a NUMBER')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: comparator stages preserve the level they emit into adjacent dust` | 1〜4 段のラダーがすべて 15 を返す |
| `a comparator emits the LEVEL it read, not full power — the first variable-strength source` | `sourcesOf` が 15 以外で seed できることそのもの |

---

## DN-RS-14 コンテナの読みは盤面でも前 tick の電力でもない第 3 の入力である

### 規則

`sourcesOf(board, previous)` は (盤面, 前 tick の電力マップ) の純関数である。
チェストを背面に置いたコンパレータの出力は**そのどちらでもない**——
中身は mc-sim のものだからである。

解決は `Component.containerSignal`、すなわち**世界の所有者の申告**である。
ボタンの `active` と同じ形であり、同じ理由による（`sourcesOf` のコメント全文を参照）。

```typescript
const rear =
  component.containerSignal ??
  (component.inputFrom === undefined ? 0 : powerAt(previous, component.inputFrom))
```

`??` であって `Math.max` ではない。**世界ではコンパレータの背面セルはコンテナかワイヤのどちらかであり、
両方ではない。** 最大値を取ると、空のチェストの脇に配線を回して満杯の読みを作れてしまう。

### 規則は本リポジトリのもの、データは mc-sim のもの

`containerSignalStrength(slots)`（`domain/comparator.ts`）は本リポジトリにある。
「コンテナの充填率をどう 0-15 に写すか」は**レッドストーンの規則**であり、
プレイヤーのソーターが読む数を決めるのはこの式だからである。

一方、その `slots` を埋めるものは 2 つとも存在しない。**[DN-RS-17](#dn-rs-17-実装できない部分は名指しする) が全部を表にしてある。**

`ContainerSlot` が `{ count, maxStack }` であって `ItemType` を含まないのは意図的である。
アイテム語彙は mc-kernel のもの（`domain/item-type.ts:128`）であり、
規則がここに住み、データがあちらに住むためには**規則がアイテムを名指ししない**必要がある。
`test/public-api.test.ts` の
`REGRESSION: exports no item roster either` がそれを構造的に固定している。

**回帰テスト**: `test/comparator.test.ts` / `test/power-graph.test.ts`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: `containerSignal` REPLACES the rear reading rather than adding to it` | 空チェスト（0）でコンパレータが 0。`Math.max` なら背面ワイヤの 14 が出る |
| `REGRESSION: one item in a big chest reads 1, not 0 — empty and nearly-empty must differ` | 27 スロットに 1 個で 1。床がなければ 0 でソーターが動かない |
| `fullness is measured in STACKS, so one bucket fills a slot as much as 64 cobblestone` | `maxStack` がスロットごとである理由。全体定数 64 で割るとバケツのチェストは 1 になる |
| `REGRESSION: a corrupt slot contributes nothing rather than poisoning every comparator on the board` | `NaN` が全盤面へ伝播しない（`NaN > 0` は false なので、症状は「動かないソーター」になる） |

---

## DN-RS-15 オブザーバの記憶は値である。ブロック変更イベントは存在しない（そして要求すべきでもない）

### 15-1. 参照実装のモジュールレベル Map

`redstone-observer-world-effects.ts:34`:

```typescript
const lastSeenBlocks = new Map<string, BlockType>()
```

6 行下に `resetObserverWatchState()` があり、コメントは
「Exposed for tests: reset the change-detection memory between scenarios」と書いてある。
**この脱出ハッチが診断そのものである。** plan.md §3.8 が参照実装最大級のバグ源として記録し、
DN-RS-8 が `makeRedstoneFrameState` を Effect にした理由と同じものが、
ここではリセット関数という蓋つきで残っている。

参照実装自身も代償を認めている——「a stale entry after a world switch costs at most one spurious
pulse」。オブザーバの spurious pulse 1 回は、**TNT 1 個の起爆**である。
ディスペンサ側（`redstone-dispenser-world-effects.ts:36`）も同じ形をしている。

`observeChanges(current, previous)` は記憶を引数で受け取り戻り値で返す。
コストは引数 1 つとフィールド 1 つで、リセット関数とそれが存在する理由のクラスごと消える。

### 15-2. 変更イベントはある。粒度が違う

mc-worldgen は変更フィードを publish している——`ChunkStoreApi.subscribeDirty`
（`application/chunk-store.ts:174`）。ただし返るのは

```typescript
ChunkDirtyBatch = { changed: ReadonlyArray<ChunkCoord>; removed: ReadonlyArray<ChunkCoord> }
```

（`mc-worldgen/domain/chunk-store-state.ts:208-211`）であり、**チャンク粒度である。**
その上のヘッダ（`:180-198`）が、SET への重複排除こそが設計の全部だと書いている——
落下砂の柱は 1 tick に同じチャンクを最大 32 回 dirty にし、購読者は 1 回だけ再メッシュしなければならない。

したがって「ブロック座標のバッチをくれ」は**要求してはならない**。
それは mx-redstone が、自分がルックアップを 1 回省くために
mc-worldgen を全購読者に対して遅くしろと言うことである。

**代わりにサンプリングする。** オブザーバ 1 個につき redstone tick 1 回の `getBlock`。
これは **O(設置されたオブザーバ数)** であって O(chunks × blocks) ではない——
plan.md §3.11 が「disaster」と呼ぶ per-tick 全走査は**ロードされた世界の量**に比例するが、
これは**プレイヤーが建てたもの**に比例する。

さらに、誰にも代償を払わせずに狭められる: `subscribeDirty` は健全な**ゲート**である。
変わらなかったチャンクにある監視セルは飛ばしてよい。
**dirty バッチはどのブロックが動いたかを言えないが、どれが動かなかったかは確実に言える。**

### 15-3. だから `Component` に `watching` は無い

グラフはブロックを読めない。読めないセルを名指すフィールドは
**受け取って保存して一度も読まれない**状態にしてはならない。DN-RS-12 の `delayTicks` は
`advanceTimedCircuit` が解釈するため、この条件を満たす。
オブザーバがどのセルを見ているかは、それが生む `active` の隣、世界の所有者のところにある。

パルス長 `OBSERVER_PULSE_TICKS = 2`（参照実装 `:17` と一致）は**規則**なのでここにあり、
**カウントダウンは呼び出し側**にある。ボタンのパルスと同じ答えである。
プレビューがその呼び出し側を実演している（`apps/preview-circuit-board/sandbox.ts` の `advanceObservers`）。

**回帰テスト**: `test/observer.test.ts`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: the FIRST sighting arms the detector and fires nothing` | 既にあったブロックの隣に置いても発火しない。チャンクロードごとのパルスの雨を止める |
| `REGRESSION: the memory is a value in and a value out — one sweep cannot arm another observer’s` | 2 つの盤面が互いの sighting を継がない |
| `REGRESSION: an observer that is gone is dropped, so a new one at the same cell arms afresh` | エントリ漏れと、同座標の新品が他人の記憶を継ぐ問題の両方 |
| `a block replaced and restored between two ticks is ONE change — the divergence is named` | サンプリング由来の乖離を**名指し**している（イベント駆動のバニラなら 2 回見える） |

---

## DN-RS-16 アクチュエータは受電もしないし導通もしない

### 規則

ホッパーとディスペンサは `RECEIVES_POWER` にも `CONDUCTS_POWER` にも**入っていない**。
盤面上では**空セルと同じくらい電力に対して透明**である。
「電力が来ているか」は `drivenPowerAt` / `isPowered` が答える。

```typescript
export const drivenPowerAt = (board, power, key): PowerLevel  // 自分を駆動する隣接セルの最大レベル
export const isPowered = (board, power, key): boolean         // それが > 0 か
```

### 参照実装の `canConduct` は逆のことを言っている。矛盾ではない

DN-RS-2 が引いているとおり、参照実装の `canConduct`（`redstone-simulation.ts:24-34`）は
Dispenser を導通側に列挙し、Lamp と Hopper だけを外している。

**`canConduct` は 1 つの述語で両方向を兼ねている。**
本リポジトリは同じ問いを 2 つに割っており（`RECEIVES_POWER` と `CONDUCTS_POWER`）、
その分割は既にこの行に現れている——**ランプは受電するが導通しない**。参照実装はそれを言えない。
したがって「ディスペンサを RECEIVES_POWER に入れないこと」は DN-RS-2 と矛盾しない。
DN-RS-2 の規則文は「受電できるのはワイヤとランプだけ」であり、**その文はそのまま真である**。

### 入れるとどうなるか

1. **ホッパーが導通すると、フィルタが自分の線を溶接する。** ホッパーはプレイヤーが
   **回路の中に置く**ブロックである。DN-RS-5 がランプについて警告している
   「2 つの独立回路が黙って 1 つに溶接される」が、それを目的に置かれた部品で起きる。
2. **アクチュエータが受電すると、自分の減衰済みレベルを持つ。** DN-RS-5 §5-1 が
   その代償の記録である——ランプは `RECEIVES_POWER` にいて、自分のエントリを読んだ accessor が
   点灯を電力より 1 マス多く漏らした。同じバグを継いだアクチュエータは、
   **ディスペンサなのでそれで発射する**。

`isLit` は `drivenPowerAt` の上に書き直してあり、**sweep と accessor が `conductsInto` を共有する**
という DN-RS-5 §5-1 の性質はそのまま、消費者が 1 つ増えただけである。

**回帰テスト**: `test/power-graph.test.ts`
`describe('hoppers and dispensers — actuators, which conduct nothing')`

| テスト名 | 主張 |
| --- | --- |
| `REGRESSION: power stops dead at a hopper, so a filter cannot weld the line feeding it to the line beyond` | ホッパー / ディスペンサの向こう側のワイヤが 0 |
| `REGRESSION: `isPowered` still says yes, though the actuator’s own entry is 0` | 自分のエントリ 0、`drivenPowerAt` 14 |
| `an actuator on a repeater’s flank is unpowered, because the repeater drives only its output` | accessor が sweep の拒否を漏らさない |
| `` `drivenPowerAt` is not `isLit`: a powered WIRE is driven but is not lit `` | `isLit` の kind 検査が冗長でないこと |

### 16-1. ホッパーは電力が「止める」唯一の部品

`isHopperLocked(powered) === powered`。**通電したホッパーはロックされる。**
他の全部品と向きが逆であり、モデルを知っている読み手ほど `if (powered)` と書いて
**閉じるべきときに開いているフィルタ**を作る。だから 1 行の関数に名前がついている。

参照実装はロックもクールダウンもモデルしていない——
`redstone-hopper-world-effects.ts:11-14` が「this model transfers directly」と書き、
毎フレーム手の届く範囲を全部移す。ロックを無視するホッパーは**遅いホッパーではなく、
フィルタとして使えないホッパー**であり、ゲーム中の仕分け機は全部フィルタである。

搬送周期 `HOPPER_TRANSFER_PERIOD_TICKS = 4`（バニラの 8 game tick、redstone は 10 Hz なので半分）は
**規則**なのでここにあり、**カウンタは呼び出し側**にある。4 回目の同じ答えである。
比較が `>=` であって `===` でないのは、`stages/registration.ts` が長いフレームのあと
超過分を**捨てる**（DN-RS-3）ので、カウンタは任意の値を飛び越えうるからである。
`===` にすると、そのホッパーは二度と来ない数を永久に待つ。

---

## DN-RS-17 実装できない部分は名指しする

完成条件 #3 の 5 部品のうち、**コンパレータとオブザーバは完全に本リポジトリのもの**であり、
**ホッパー / ディスペンサ / 感圧板はレッドストーンの部分だけがここにある**。
残りは「あとで」ではなく、**具体的に何が無いか**である。TODO ではない。

| 欲しいもの | どこに無いか | 誰が要るか |
| --- | --- | --- |
| `InventoryServiceApi.inventoryAt(position)` | mc-sim `application/inventory-service.ts:17-53` は**プレイヤーの 1 つのインベントリ**だけを扱う。`add` / `remove` / `countOf` / `snapshot` のどれも位置を取らない。`Inventory`（`domain/inventory.ts:112`）は識別子を持たない `ReadonlyArray<Slot>` である | コンパレータ（コンテナの読み）、ホッパー（搬送）、ディスペンサ（在庫）。**3 つは 1 つの追加でほどける** |
| アイテムごとの `maxStackSize` 能力 | mc-kernel は `MAX_STACK_COUNT = 64` を単一の全体定数として publish している（`domain/quantities.ts:20`）。`BLOCK_CAPABILITY_DEFAULTS`（`domain/block-capabilities.ts:97-179`）の 11 フラグは `passable` / `pistonImmovable` / `suffocates` など**全部ブロックの物理**で、アイテムの能力表は無い | コンパレータ。バケツのチェストは満杯であり、64 で割ると 1/64 になる |
| ドロップアイテムを spawn する手段 | `EntityManagerApi.spawn` は**ある**（`mc-sim/application/entity-manager.ts:100`）。呼べない: `SpawnRequest<S>`（`mc-sim/domain/entity.ts:347-352`）の `behaviour: S` は mc-sim 自身の言葉で「rules tier が entity ごとに持つもの——クリーパーなら mx-gameplay の `CreeperFuse`」であり、`S` を名指すことは兄弟体験モジュールの import である（plan.md §2.3-1、エッジはゼロ） | ディスペンサ。**したがってドロップの生成は mx-gameplay がレッドストーンのイベントに反応する形になる。mx-redstone が mx-gameplay へ手を伸ばす形にはならない** |
| 発射体とそのダメージ | 参照実装は `entityManager.getEntities()` を hitscan して `applyDamage` する（`redstone-dispenser-world-effects.ts:90-115`）。ダメージ数値は mc-sim のものでもない——`mc-sim/domain/entity.ts` が「剣が何ダメージか」「落下で何ダメージか」は mx-gameplay と明記している | ディスペンサ。矢の 5 点はレッドストーンのリポジトリが発明する戦闘定数である |
| `EntityManagerApi.entitiesWithin(bounds)` | 公開されているのは `entities` / `find` / `count` / `countOfKind` / `sweep`（`mc-sim/application/entity-manager.ts:100-140`）で、**全部 roster 全体に対するもの**。`entities` にはそこで「THE HOT PATH」と注記がある | 感圧板。板ごとに数えると redstone tick ごとに O(板 × entity) で、その注記が防ごうとしているものそのもの |
| entity の大きさ | `EntityState`（`mc-sim/domain/entity.ts:229-260`）は `feetPosition` / `healthPoints` / 不透明な `behaviour` だけで、寸法をいっさい持たない。参照実装は mob spawner config の `MOB_HALF_WIDTH` / `MOB_HALF_HEIGHT` を読む（rules tier の定数） | 感圧板。AABB 重なり判定（`entity-update-stage.pressure-plate.ts:19-54`）が書けない |
| 幾何そのもの | `domain/power-graph.ts` 冒頭が「There is NO geometry here」と書き、`domain/position-key.ts` は不透明な文字列である。kernel の `Position` が来るまで、この リポジトリは**航行できない** | 感圧板。重なり判定はキーの上には書けない |

**境界は「何を諦めたか」ではなく「何を足せばほどけるか」で書いてある。**
1 行目がその形の価値を示している——コンパレータ・ホッパー・ディスペンサの 3 つは、
別々の 3 つの欠落ではなく **`inventoryAt` 1 つ**である。

### 感圧板で「本リポジトリのもの」だった部分

`plateSignal(occupants, weighing)`（`domain/pressure-plate.ts`）。
石 / 木の板はスイッチ（何か乗っていれば 15）、重量感圧板は**測定器**である——
金は 15 個で、鉄は 150 個で飽和する。この写像はレッドストーンの規則であり、
**プレイヤーのカウンタが読む数を決める**。

参照実装はスイッチしか持たない（`redstone-simulation.ts:40`）ので、
重量板の算術はバニラからの移植である。飽和する **ceil** であって round ではない:
1 個で 0 を返す重量板は、**11 個目まで壊れて見える板**である。

「どの entity を数えるか」（石の板はドロップアイテムを無視し、木の板は無視しない）は
呼び出し側の判断である。`EntityKind` は mc-sim が分類を持たない branded string
（`mc-sim/domain/entity.ts:157`）であり、それは正しい——分類は rules tier のものだからである。
**呼び出し側がフィルタし、このファイルは数える。**

### 板の解放遅延はここに無い

バニラの板は最後の entity が降りたあとしばらく通電したままである。それは**残り時間**であり、
状態である。本リポジトリは同じ答えを 4 回出した——ボタンのパルス、リピーターの遅延、
オブザーバのパルス、そしてこれ。電力マップに置く場所は無く、盤面は入力である。
`stages/registration.ts` の tick カウンタの隣に行く。
