# @nerima-games/mx-redstone

## 責務

レッドストーン機構（ワイヤ電力伝播・トーチ/レバー/ボタン・リピーター・ピストン押し出し）のルールを定義する。

mx-redstone は**体験モジュール**であり、plan.md §2.3-1 の言う**動詞**である。
「ワイヤは 1 マスごとに 1 減衰する」「トーチは入力を 1 tick 遅れで反転する」「ピストンは 12 ブロックまで押す」を所有する。
**状態は 1 つも所有しない。** ピストンが押すブロックは mc-worldgen のもの、押されたプレイヤーは mc-sim のもの、
ブロックの `pistonImmovable` 能力は mc-kernel のものである。

## 依存

`@nerima-games/mc-sim` と `@nerima-games/mc-worldgen`（+ 普遍的に import 可能な `@nerima-games/mc-kernel`）。
`@nerima-games/mc-playground-kit` は **devDependency 専用**。

これは設計上の制約であり、`pnpm check:deps` で機械的に強制されている
（`scripts/check-dependency-whitelist.ts` の `REPOSITORY_POLICY`）。
違反があれば CI は必ず非ゼロ終了する。

**`mc-audio` は親ではない。** レバーはカチッと鳴り、ピストンは伸縮音を出すが、
plan.md §3.12 は mx-gameplay（§3.11）と違ってこのリポジトリに audio エッジを与えていない。
したがって音は mc-sim 経由で要求する。**エッジを足すことは plan.md を変えることであって、
import 文を 1 行足すことではない。**
`test/check-dependency-whitelist.test.ts` の
`REGRESSION: mc-audio is NOT a parent, so a click sound is requested through mc-sim` がこの不在を守っている。

## このリポジトリの位置づけ

plan.md §5.3 の細分化棄却表に、レッドストーンは他と違う形で登場する。

> | mx-gameplay のさらなる分割 | 共通の stage 契約を共変更する一枚岩。**自己完結だったレッドストーンは分離済みで**、残りに狭い界面がない |

つまり mx-redstone は **mx-gameplay から実際に切り出せた唯一の部分**である。
採掘も農業も戦闘も切り出せなかった。レッドストーンだけが切り出せたのは、
「電力の伝播」という規則が他のゲームルールの中身を知らずに閉じるからである。

**これは過去についての事実ではなく、維持すべき性質である。**
ディスペンサやホッパーを実装するとき「ちょっとだけ mx-gameplay を見たい」誘惑が来る。
負けた瞬間、このリポジトリが存在する根拠が消える。

詳細は **[docs/architecture.md](./docs/architecture.md)**（全 16 リポジトリの依存グラフ、名詞/動詞ルール、
体験モジュール間エッジがゼロである理由、推移閉包禁止、stage 全順序の所有者）。

## 依存ルール（16 リポジトリ共通）

| ルール | 内容 |
| --- | --- |
| ハード失敗 | 違反があれば CI は必ず非ゼロ終了する。警告で済ませない |
| 循環禁止 | 循環依存は一切許可しない。「co-evolution ペア」のような例外リストは設けない |
| 推移閉包の禁止 | A→B、B→C のとき A は C を import できない。依存は直接依存のみが import 許可を意味する |
| kernel は例外 | mc-kernel はどこからでも import 可。**これが唯一の例外** |
| 宣言と実体の一致 | import する `@nerima-games/*` は `package.json` に記載されていなければならない |
| mc-playground-kit は devDependency 専用 | `dependencies` に入れてはならない。実行時依存になると、出荷ビルドから入力処理が消える |
| 壁時計の直読み禁止 | 時刻はすべて注入された Clock Port から取得する |

`scripts/check-dependency-whitelist.ts` は 16 リポジトリ共通のテンプレートである。
姉妹リポジトリへ移植する際は、ファイル冒頭で囲ってある `REPOSITORY_POLICY` 定数だけを書き換えればよい。

`REPOSITORY_POLICY.dependencyGraph` には **plan.md §2.1 の全 16 リポジトリ**が転記されている。
これにより、このリポジトリのコピーだけで組織全体の循環を検出でき、
推移閉包違反にも「なぜ違反なのか」の経路つきで説明できる。

### import ゲートに見えない違反が 1 つある

`StageId` は文字列である。`after: [StageId('gameplay:fluids')]` と書いても import 文は 1 行も増えないため、
**`pnpm check:deps` はこれを見られない**。この穴は `test/stage-registration.test.ts` が塞いでいる。
詳細は [docs/design-notes.md](./docs/design-notes.md) DN-RS-7。

### 壁時計直読み禁止の実装方法

oxlint 0.12 は `no-restricted-syntax` も `no-restricted-properties` も実装しておらず、
`no-restricted-globals` は `oxlint --rules` の一覧に出るものの実装されていない
（0.12.0 で実測確認済み。3 ルールすべてを設定した状態でも診断が 0 件）。

そのため禁止は **`scripts/check-dependency-whitelist.ts` 側で実装**している。
コメント・文字列リテラル・正規表現リテラルの中身はマスクされるので誤検知しない。
oxlint が該当ルールを実装したら .oxlintrc.json 側へ移す。

固定レートのシミュレーションが壁時計を読んだ瞬間、それは再現しなくなる。
このリポジトリではこの規則は「望ましい」ではなく**検証手法の前提条件**である
（[docs/design-notes.md](./docs/design-notes.md) DN-RS-9）。

## 開発

### セットアップ

```console
$ direnv allow          # flake.nix の devShell で nodejs_24 + corepack が入る
$ pnpm install
```

Nix を使わない場合は Node.js 24 以上と pnpm 11（`corepack` 推奨）を用意する。

```console
$ corepack enable
$ corepack prepare pnpm@11 --activate
```

> **注意**: ツールチェーンは `devenv.nix` から `flake.nix` + `flake.lock` に移行済みである。
> `flake.lock` はコミットされているので、`nix develop`（`.envrc` は `use flake`）は
> 誰の手元でも同じ nixpkgs に解決される。`devenv.nix` / `devenv.lock` はもう存在しない。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` / `tsconfig.test.json` / `tsconfig.preview.json` を型検査 |
| `pnpm lint` | oxlint（このリポジトリ唯一の lint / format 設定。prettier も biome も .editorconfig も置かない）。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`.oxlintrc.json` は 5 カテゴリすべてと個別 67 ルールが `warn`、`error` は 4 つだけ。このフラグが無かった頃は実質その 4 つしかゲートになっていなかった） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect` が主 API） |
| `pnpm test:watch` | vitest watch |
| `pnpm test:coverage` | カバレッジ計測（閾値は未設定。[docs/testing.md](./docs/testing.md) §6） |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + 壁時計直読み禁止の検査 |
| `pnpm preview` | 回路盤サンドボックス（[apps/preview-circuit-board/](./apps/preview-circuit-board/README.md)）。**`pnpm verify` には入れていない** |
| `pnpm verify` | `typecheck && lint && check:deps && api:check && test`。CI と同じ内容 |

## 現状

電力グラフに加え、ホストから世界スナップショットを同期して frame stage を実行する runtime port を持つ。

- **実行時依存は `effect` だけ。** 組織内でまだ何も公開されていないため、
  `@nerima-games/mc-sim` にも `@nerima-games/mc-worldgen` にも依存できない（ボトムアップの publish-then-pin、plan.md §6）。
- **`domain/frame-contract.ts` と `domain/position-key.ts` は mc-kernel の型のローカル再掲であり、削除期日つきである。**
  mc-kernel が公開された瞬間に両ファイルとも消え、import 文 1 本に置き換わる。
  `domain/piston.ts` の `BlockCapabilityLookup` も同時に kernel の能力アクセサへ差し替わる
  （[docs/versioning.md](./docs/versioning.md) §6）。
  **この 2 ファイルは `index.ts` から re-export していない。** 所有していない語彙（`StageId` /
  `DeltaTimeSecs` / `StageRegistration`）を公開 API に載せると、上記の削除が
  すべての消費者にとっての破壊的変更になるためである。
- **`RedstoneWorldRuntime` は dimension 単位の完全スナップショットを受け取る。**
  `redstone:power` が 6 近傍の回路盤を進め、`redstone:effects` がランプの on/off 変化だけを蓄積する。
  ホストは stage 実行後に `drainLampTransitions` と `drainPistonTransitions` を呼ぶ。
  ピストン遷移は `planPistonTransition` で純粋に計画し、`applyPistonPlan` の単一 atomic commit で世界へ反映する。
  ボタン入力は `pressButton(dimension, position)` でキューへ積み、次の redstone tick から
  `pulseTicks`（既定 10 tick）だけ通電する。再入力は残り時間を設定値へ戻す。
  ピストン伸縮・ディスペンサ発射・ホッパー移送・オブザーバのパルスは、すべて mc-sim / mc-worldgen
  への書き込みであり、書き込み先がまだ存在しない。**判断のほうは全部書いてある**——どの
  オブザーバが発火したか、どのディスペンサが立ち上がりを見たか、どのホッパーがロックされているか、
  コンテナの読みがいくつか——ので、足りないのは書き込み口だけである。
- **部品は 11 種**（wire / torch / lever / button / repeater / comparator / observer /
  pressure-plate / hopper / dispenser / lamp）。ただし**完全なのはコンパレータとオブザーバだけ**である。
  ホッパー・ディスペンサ・感圧板は**レッドストーンの規則**（ロックの反転、搬送周期、
  立ち上がりエッジ、占有数 → 信号強度）だけがここにあり、
  アイテムと entity に触る部分は境界の向こうにある。
  **境界は「あとで」ではなく名指ししてある**——[docs/design-notes.md](./docs/design-notes.md)
  DN-RS-17 に、足りない型とクエリが「どのファイルの何行目に無いか」まで表になっている。
  そのうち 3 つは `InventoryServiceApi.inventoryAt(position)` 1 つで同時にほどける。
- **ソース出力は隣接ワイヤへ同じ強度で入る。**
  レバー・トーチ・リピーターの 15 と、コンパレータ・重み付き感圧板の可変出力は、
  最初のワイヤでは減衰しない。ワイヤが次のセルへ渡すときだけ 1 減る（DN-RS-13）。
- **リピーター遅延・側面給電ロックとボタンパルスは状態付きtick APIで実装する。**
  `advanceTimedCircuit(board, state, pressedButtons)` はリピーターの 1–4 tick 遅延、ボタンの残り時間、
  0–15 の電力マップを一緒に進める。`propagateTick(board, previous)` は既存利用者との互換性のため
  1 tick の純粋伝播APIとして残す。時間状態は runtime の `redstone:power` stage が所有し、
  frame の分割や盤面の挿入順序には依存しない。リピーターは `sideInputs` のいずれかが前tickに
  通電していれば現在出力を保持し、解除後に背面入力を改めて設定遅延ぶん評価する。
- **高速反転するトーチは burnout する。** 状態付きtick APIは30 redstone ticks内に8回消灯した
  トーチを80 ticks停止し、その後に入力が無給電なら再点灯する。burnout状態は盤面の挿入順や
  壁時計に依存せず、従来の`propagateTick`による1 tick反転は互換性のため変更しない。
- **ワイヤの到達距離はバニラ同様 15 マスである。** ソース隣接ワイヤが 15、以後 1 ずつ減衰し、
  15 個目が 1、16 個目が 0 になる。cycle や複数ソースでも最大レベル更新だけを採用するため、
  盤面の挿入順に依存せず有限に収束する。
- **スティッキーピストンと引き寄せは未実装。** 工数ではなく、能力フラグが監査で確定していないためである。
  推測したフラグは 14 リポジトリへ一度に配られる（[docs/design-notes.md](./docs/design-notes.md) DN-RS-10）。
- **リピーターはダイオードである。** 背面から入り正面から出る。側面には出さず、自分の入力セルも駆動しない。
  トーチも取り付け先のセルを駆動しない。`Component` が `outputTo`（リピーターの出力）を持つのはこのためで、
  向きは kind の性質ではなく設置の性質だから述語では表現できない（DN-RS-12）。
- **回路盤サンドボックスプレビューは動く**（`pnpm preview`、[apps/preview-circuit-board/](./apps/preview-circuit-board/README.md)）。
  plan.md §6 Step 2 の完了条件「テスト green + **内蔵プレビューが操作可能**」の後半は、これで満たしている
  （[docs/testing.md](./docs/testing.md) §4-1）。
  部品を置き、レバーを倒し、**1 tick ずつ進めて**電力 0–15 の伝播を見る端末アプリである。
  **見せないもの**も明確で、プレイヤーも世界も無く、隣接は 2D の 4 近傍であり、
  ピストンの実移動はプレビュー内の代役である。
  依存は 0 個、壁時計の読み取りも 0 箇所。
  **初回実行で 7 件の欠陥を出した**（`pnpm preview --stats`）。うち 3 件——
  リピーターが自分をラッチして落ちない / `settle` が非循環回路を発振と誤判定する /
  `isLit` がランプ 1 個ぶん漏れる——は当時の 21 本の電力グラフテストが 1 つも捕まえていなかった。
  **4 件を修正し、残る 3 件は現在の挙動を名指しするテストを置いた。**
  `--stats` の行は pin ではない（測るだけで期待値を記録しないので、直すと finding は静かに消える）。
  pin は `test/power-graph.test.ts` の側にある。
- **ビルド／publish はまだない。** `exports` は TypeScript ソースを直接指しており、`noEmit: true` なので `dist` がない。
  GitHub Packages への publish パイプラインは完成条件到達時に追加し、それまで `version` は `0.x` に留める。
- **カバレッジ閾値は未設定。** 計測とレポートは常に動かしており、99% ゲートは完成条件到達時に有効化する
  （`vitest.config.ts` にコメントとして置いてある）。

`pnpm verify` は green（typecheck エラーなし / oxlint 0 件 / check:deps OK /
api-lock 一致 / vitest 12 ファイル 186 テスト）。

## ドキュメント

**[docs/README.md](./docs/README.md) が索引。**

| ドキュメント | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 4 階層、全 16 リポジトリの依存グラフ、名詞/動詞ルール、体験モジュール間エッジがゼロである理由 |
| [docs/responsibility.md](./docs/responsibility.md) | 責務と、**明示的な非スコープ**（どれが誰のものか） |
| [docs/public-api.md](./docs/public-api.md) | **公開 API は stage 登録と意味的 runtime port。** 電力グラフが内部でなければならない理由 |
| [docs/design-notes.md](./docs/design-notes.md) | 設計注意 DN-RS-1〜11。参照実装の `path:line` と回帰テスト名つき |
| [docs/porting.md](./docs/porting.md) | 移植元の**実測 LOC**、plan.md との差異、移植順序 |
| [docs/testing.md](./docs/testing.md) | 検証ゲート、fixture 回路テスト、完成条件、99% カバレッジゲートの投入時期 |
| [docs/versioning.md](./docs/versioning.md) | 0.x → 1.0.0 方針、GitHub Packages、**このリポジトリで破壊的変更とは何か** |

能力フラグの権威は `mc-kernel/docs/capability-flag-audit.md` である。
本リポジトリのドキュメントと食い違ったら、監査が正しい。

## License

MIT
