# 責務と非スコープ

出典: plan.md §3.12。

## 1. 責務

> **責務**: レッドストーン機構（ワイヤ電力伝播・トーチ/レバー/ボタン・リピーター・ピストン押し出し）

plan.md が挙げるのは 4 つだが、これは網羅リストではなく代表列である。
参照実装が実際に持っている部品面は 5 ファイルの `redstone-*-world-effects.ts` に現れており、
**これらもすべて本リポジトリのスコープに含まれる**。

| 部品 | 参照実装 | 本リポジトリでの扱い |
| --- | --- | --- |
| ワイヤ（電力伝播・1 マス 1 減衰） | `packages/entity/domain/redstone/redstone-simulation.ts:68`（`propagatePower`） | `domain/power-graph.ts` に実装済み |
| トーチ（1 tick 遅延反転） | 同 `:254`（`updateTorches`） | 実装済み |
| レバー / ボタン | 同 `:36-46`（`isPowerSource`） | 実装済み（状態付きAPIで既定10 tickのパルスと再トリガー） |
| リピーター | 同 `:219-245` | 実装済み（ダイオード + 状態付きAPIで1–4 tick遅延） |
| ピストン押し出し・sticky 引き戻し | `packages/app/application/frame/stages/redstone-piston-world-effects.ts`（263 LOC） | `domain/piston.ts` に typed plan/apply、runtime に powered transition を実装済み |
| ランプ | `redstone-lamp-world-effects.ts`（92 LOC） | `isLit` として実装済み |
| ディスペンサ | `redstone-dispenser-world-effects.ts`（137 LOC） | `domain/dispenser.ts` に**立ち上がりエッジ検出のみ**。中身 / ドロップ / 発射体は境界（[design-notes.md](./design-notes.md) DN-RS-17） |
| ホッパー | `redstone-hopper-world-effects.ts`（53 LOC） | `domain/hopper.ts` に**ロックの反転と搬送周期のみ**。搬送そのものは境界（DN-RS-16 §16-1、DN-RS-17） |
| オブザーバ | `redstone-observer-world-effects.ts`（73 LOC） | `domain/observer.ts` に実装済み（変化検出とパルス長。記憶は値であってモジュール変数ではない——DN-RS-15） |
| 感圧板 | `redstone-simulation.ts:40` | `domain/pressure-plate.ts` に**占有数 → 信号強度のみ**。占有判定は境界（DN-RS-17） |
| コンパレータ | `redstone-simulation.ts:292`（`updateComparators`） | `domain/comparator.ts` に実装済み（2 モード + コンテナ充填率の写像）。**本リポジトリの信号モデルの穴を露出させた部品である——DN-RS-13** |

移植元の実測は [porting.md](./porting.md) を参照。
`stages/registration.ts:157-161` が `redstone:effects` stage のコメントとして、
これらが最終的にどこへ落ちるかを記録している
（そのコメントは移植元を「six files」と書いているが、実測は 5 ファイルである。[porting.md](./porting.md) §2 を参照）。

### 1-1. plan.md §7 における位置

機能カバレッジ表（plan.md §7）で「レッドストーン」の行は `redstone` の 1 語だけである。

| 機能領域 | 割り当て先 |
| --- | --- |
| レッドストーン | redstone |

これは他の体験機能と対照的である。Mob は `sim + gameplay`（状態は sim、AI/スポーン/ドロップのルールは gameplay）、
戦闘・体力・空腹・XP は `sim（状態）+ gameplay（ルール）`、クラフトは `sim（レシピ/状態）+ ui（画面）` と、
**状態とルールが明示的に分割されている**。レッドストーンだけは分割されていない。

その理由は §3-1 で述べたとおり、電力グラフが永続化されない導出値だからである。
ただし**この行を額面どおりに読みすぎないこと**: ディスペンサはインベントリを読み書きし、
ホッパーはアイテムを移し、ピストンはエンティティを押す。それらの状態は例外なく mc-sim のものである。
§7 が単一所有者を書いているのは「レッドストーンという機能領域に home が 1 つある」という意味であって、
「mx-redstone が状態も持つ」という意味ではない。

## 2. 明示的な非スコープ

ここを守らないと、§5.3 が「自己完結だったから分離できた」と評価したこのリポジトリが、
自己完結でなくなる。触りたくなったものが下表にあれば、それは他所の資産である。

| 非スコープ | 置き場所 | 理由 |
| --- | --- | --- |
| ブロック定義（`REDSTONE_WIRE` / `PISTON` / `REDSTONE_LAMP` … のリテラル型と定義テーブル） | `mc-kernel` | ブロック語彙は全 16 リポジトリの共有物。ここに 2 つ目の語彙を作ると fork になる（plan.md §3.1） |
| **`pistonImmovable` 能力フラグと、そのメンバーシップ** | `mc-kernel` | 権威は `mc-kernel/docs/capability-flag-audit.md` §3。詳細は [design-notes.md](./design-notes.md) DN-RS-1 |
| 部品が置かれている世界・チャンク・そのライフサイクル | `mc-worldgen` | 名詞。`ChunkManager` がロード/アンロード/ダーティフラグを持つ（plan.md §3.7） |
| ピストンが押したエンティティの位置、ディスペンサ / ホッパーが読み書きするインベントリ、感圧板に乗っているもの | `mc-sim` | 名詞。`EntityManager` / `InventoryService`（plan.md §3.8）。**足りないものは [design-notes.md](./design-notes.md) DN-RS-17 に 1 つずつ名指ししてある**——`inventoryAt(position)` / `entitiesWithin(bounds)` / entity の寸法 / アイテムごとの `maxStackSize` |
| ディスペンサが出すドロップアイテムと矢のダメージ | `mx-gameplay`（**mc-sim 越しに観測される**） | `EntityManagerApi.spawn` は `SpawnRequest<S>` を取り、`behaviour: S` は rules tier のものである（`mc-sim/domain/entity.ts:347-352`）。`S` を名指すことは兄弟体験モジュールの import であり、エッジはゼロ（plan.md §2.3-1）。したがって**ディスペンサはイベントを出し、ドロップを作るのは mx-gameplay である** |
| レバーのクリック音・ピストンの伸縮音 | `mc-audio`（**`mc-sim` 経由で要求する**） | mc-audio は mx-redstone の親ではない。[architecture.md](./architecture.md) §7 |
| 回路を説明する画面・ホットバー・任意の DOM | `mx-ui` | 「全画面」は mx-ui（plan.md §3.13）。プレビューは例外だが、それは出荷物ではない |
| stage の全順序、Layer 配線、セッションライフサイクル | `mc-compose` | 全順序は compose だけが所有する（plan.md §2.3-3）。[public-api.md](./public-api.md) §3 |
| 押されたブロックとプレイヤーの衝突解決 | `mc-physics`（**`mc-sim` 経由**） | 推移閉包禁止により mc-physics は直接 import できない |
| 回路の永続化フォーマット | 現状スコープ外。必要になれば `mc-save` + `mc-sim` | [architecture.md](./architecture.md) §3-1 |
| 落下ブロック・流体伝播・作物 | `mx-gameplay` | 体験モジュール間エッジはゼロ。観測は mc-sim / mc-worldgen 越しに行う |
| スティッキーピストン・引き寄せ | 第一版のスコープ外（将来 mx-redstone） | 能力フラグが監査で確定していない。[design-notes.md](./design-notes.md) DN-RS-10 |

### 2-1. 監査が「mx-redstone のもの」と名指ししたもの

逆方向の境界も 1 件記録されている。`mc-kernel/docs/capability-flag-audit.md` §6-7 は、
参照実装の `interaction-break-handler.shared.ts:11-22` にある `REDSTONE_CLEANUP_BLOCK_TYPES` について
「**mx-redstone が所有するコンポーネント名簿であり、kernel の語彙ではない**」と結論している。

同 §6-10 の「アイテム → レッドストーン部品の設置表」（`interaction-redstone-handler.ts:69-80`）も、
ブロック属性ではなくアイテム側の対応表としてフラグ化を拒否されている。

つまり「レッドストーン部品はどれか」という名簿はここに来る。
一方「そのブロックがピストンで押せるか」は kernel に行く。**部品名簿は語彙ではなく規則の一部**、
というのが分割線である。

## 3. 親リポジトリ

| 親 | 種別 | 何のために |
| --- | --- | --- |
| `@nerima-games/mc-sim` | `dependencies` | エンティティ位置・インベントリ・ゲーム状態の読み書き。音の要求もここ経由 |
| `@nerima-games/mc-worldgen` | `dependencies` | 部品が置かれているブロックの読み書き、チャンクダーティ通知。どちらも `ChunkStore`（`@nerima-games/mc-worldgen/ChunkStore`）。**この行は当たっていた** — plan.md §3.8 が挙げるダーティ通知は mc-sim ではなく mc-worldgen に決着した |
| `@nerima-games/mc-kernel` | `dependencies`（普遍） | 共有語彙。許可リストに書かずに import 可、ただし `package.json` への記載は必要 |
| `@nerima-games/mc-playground-kit` | **`devDependencies` のみ** | 回路盤プレビューの起動ハーネス |

> **現状**: この表は**意図された最終形**であって、現在の `package.json` の内容ではない。
> `dependencies` は `effect` のみで、`@nerima-games/*` は 1 つも宣言されていない
> （どれもまだ publish されていないため。plan.md §6 Step 3 の bottom-up publish-then-pin）。
> `mc-playground-kit` を `devDependencies` に書くのは、kit が publish され、
> かつ `apps/preview-circuit-board/` を作るときである（現在プレビューは存在しない）。
> 依存グラフの権威は `package.json` ではなく
> `scripts/check-dependency-whitelist.ts` の roster であり、そちらは今日から実在する。

親が 2 つ（+ kernel）しかないことは
`test/check-dependency-whitelist.test.ts` の
`declares exactly the parents plan.md §3.12 gives it: sim and worldgen` が固定している。

### 3-1. なぜ kit が devDependency 専用なのか（plan.md §2.3-2）

`mc-playground-kit` は「ミニ平地ワールド + カメラ + レンダラ + 入力を 1 秒で束ねる糊」であり、
プレビュー起動専用の開発ツールである（plan.md §3.10）。

**実行時の入力サービスは `mc-render` が所有する。** kit ではない。
したがって kit を `dependencies` に入れると、次のことが起きる:

1. kit は出荷ビルドに含まれない（開発ツールだから）。
2. しかし出荷コードが kit の入力サービスを参照している。
3. 結果、**出荷されたゲームから入力処理が消える**。

これはビルドが通ってしまう種類の壊れ方なので、機械検査で塞いである。強制は 2 段構え:

| 検査 | 判定名 |
| --- | --- |
| kit が `dependencies` にある | `dev-only-package-in-dependencies` |
| kit を出荷ソース（`index.ts` / `domain/` / `stages/`）から import している | `dev-only-package-in-shipped-source` |

「出荷ソースかどうか」の判定は `isToolingOrTestPath`（`scripts/check-dependency-whitelist.ts:898-903`）にあり、
**`stages/` が出荷ソース側であること**を `test/check-dependency-whitelist.test.ts` の
`REGRESSION: \`stages/\` counts as shipped source, not as tooling` が固定している。
この述語を寛容な方向に間違えると、本プロジェクトが最も禁じたい import が静かに合法になる。

`test/` と `scripts/` からの kit import は許される。
`kit IS allowed from the circuit-board preview, which is the whole reason it exists` がそれを示している。

## 4. 内部構成

```
index.ts                      # 公開バレル。ただし「公開」の意味は public-api.md を読むこと
domain/
  frame-contract.ts           # plan.md §4.1 の契約をローカルに再掲。kernel 公開時に削除
  position-key.ts             # Position のキー表現。kernel 公開時に削除
  block-ref.ts                # ブロックの不透明な参照。kernel 公開時に削除
  signal-level.ts             # 信号の値域（0-15）。規則 3 つが共有するので独立している
  power-graph.ts              # 電力グラフ。規則を「置く」場所であって規則そのものではない
  piston.ts                   # ピストン伸縮の typed plan と atomic apply
  comparator.ts               # コンパレータの算術とコンテナ充填率
  observer.ts                 # ブロック変化検出とパルス長
  pressure-plate.ts           # 占有数 → 信号強度
  hopper.ts                   # ロックの反転と搬送周期
  dispenser.ts                # 立ち上がりエッジ検出
stages/
  stage-ids.ts                # このリポジトリが書き下す StageId を 1 ファイルに集約
  registration.ts             # StageRegistration の生成 = 唯一の公開 API
scripts/
  check-dependency-whitelist.ts   # 16 リポジトリ共通の境界ゲート（テンプレート）
```

**1 規則 1 ファイル**である（plan.md §3.11）。`power-graph.ts` が規則を持たないのはその帰結で、
あのファイルが知っているのは「どのセルが背面でどのセルが側面か」——つまり**設置**であり、
コンパレータが何を計算するかは知らない。逆に `comparator.ts` は盤面が何かを知らない。
`signal-level.ts` が独立しているのは同じ理由の裏返しで、値域を 3 つの規則が共有するため
`power-graph.ts` に置くと `power-graph -> comparator -> power-graph` の循環になる。

`domain/` と `stages/` の分割は依存境界ではなく**純粋性の境界**である。
`domain/` は世界を知らない純粋関数だけを置き、`stages/` が Effect と `Ref` を持ち込む。
この境界があるおかげで、回路シナリオテストがワールドなしで書ける（[testing.md](./testing.md) §3）。
