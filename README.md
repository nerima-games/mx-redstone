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
oxlint が該当ルールを実装したら oxlint.json 側へ移す。

固定レートのシミュレーションが壁時計を読んだ瞬間、それは再現しなくなる。
このリポジトリではこの規則は「望ましい」ではなく**検証手法の前提条件**である
（[docs/design-notes.md](./docs/design-notes.md) DN-RS-9）。

## 開発

### セットアップ

```console
$ direnv allow          # devenv 経由で nodejs_22 + pnpm が入る
$ pnpm install
```

devenv を使わない場合は Node.js 22 以上と pnpm 9.15.0（`corepack` 推奨）を用意する。

```console
$ corepack enable
$ corepack prepare pnpm@9.15.0 --activate
```

> **注意**: `devenv.lock` はコミットされていない。生成には `devenv` の実行が必要なため、
> 初回に devenv を動かした人がコミットすること。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` と `tsconfig.test.json` の両方を型検査 |
| `pnpm lint` | oxlint（このリポジトリ唯一の lint / format 設定。prettier も biome も .editorconfig も置かない） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm test` | vitest（`@effect/vitest` の `it.effect` が主 API） |
| `pnpm test:watch` | vitest watch |
| `pnpm test:coverage` | カバレッジ計測（閾値は未設定。[docs/testing.md](./docs/testing.md) §6） |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + 壁時計直読み禁止の検査 |
| `pnpm verify` | `typecheck && lint && check:deps && test`。CI と同じ内容 |

## 現状

**実装前の叩き台（first cut）である。** 契約と設計上の防御を先に置き、中身はこれから埋める。

- **実行時依存は `effect` だけ。** 組織内でまだ何も公開されていないため、
  `@nerima-games/mc-sim` にも `@nerima-games/mc-worldgen` にも依存できない（ボトムアップの publish-then-pin、plan.md §6）。
- **`domain/frame-contract.ts` と `domain/position-key.ts` は mc-kernel の型のローカル再掲であり、削除期日つきである。**
  mc-kernel が公開された瞬間に両ファイルとも消え、import 文 1 本に置き換わる。
  `domain/piston.ts` の `BlockCapabilityLookup` も同時に kernel の能力アクセサへ差し替わる
  （[docs/versioning.md](./docs/versioning.md) §6）。
- **`redstone:effects` stage の `run` は `Effect.void`。** ピストン伸縮・ランプ点灯・ディスペンサ発射・
  ホッパー移送・オブザーバのパルスは、すべて mc-sim / mc-worldgen への書き込みであり、
  書き込み先がまだ存在しない。
- **部品は 6 種のみ**（wire / torch / lever / button / repeater / lamp）。
  ディスペンサ・ホッパー・オブザーバ・感圧板・コンパレータは未実装
  （[docs/responsibility.md](./docs/responsibility.md) §1 に参照実装の全部品面がある）。
  リピーターの `delayTicks` とボタンのパルス長も型にあるだけで未消費。
- **スティッキーピストンと引き寄せは未実装。** 工数ではなく、能力フラグが監査で確定していないためである。
  推測したフラグは 14 リポジトリへ一度に配られる（[docs/design-notes.md](./docs/design-notes.md) DN-RS-10）。
- **プレビューはまだ無い。** plan.md §3.12 が要求する回路盤サンドボックス（部品を置いて動かす）は未着手であり、
  したがって完成条件は満たしていない（[docs/testing.md](./docs/testing.md) §4）。
- **ビルド／publish はまだない。** `exports` は TypeScript ソースを直接指しており、`noEmit: true` なので `dist` がない。
  GitHub Packages への publish パイプラインは完成条件到達時に追加し、それまで `version` は `0.x` に留める。
- **カバレッジ閾値は未設定。** 計測とレポートは常に動かしており、99% ゲートは完成条件到達時に有効化する
  （`vitest.config.ts` にコメントとして置いてある）。

`pnpm verify` は green（typecheck エラーなし / oxlint 13 ファイル 0 件 / check:deps OK 13 ファイル / vitest 5 ファイル 68 テスト）。

## ドキュメント

**[docs/README.md](./docs/README.md) が索引。**

| ドキュメント | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 4 階層、全 16 リポジトリの依存グラフ、名詞/動詞ルール、体験モジュール間エッジがゼロである理由 |
| [docs/responsibility.md](./docs/responsibility.md) | 責務と、**明示的な非スコープ**（どれが誰のものか） |
| [docs/public-api.md](./docs/public-api.md) | **公開 API は stage 登録だけ。** 電力グラフが内部でなければならない理由 |
| [docs/design-notes.md](./docs/design-notes.md) | 設計注意 DN-RS-1〜11。参照実装の `path:line` と回帰テスト名つき |
| [docs/porting.md](./docs/porting.md) | 移植元の**実測 LOC**、plan.md との差異、移植順序 |
| [docs/testing.md](./docs/testing.md) | 検証ゲート、fixture 回路テスト、完成条件、99% カバレッジゲートの投入時期 |
| [docs/versioning.md](./docs/versioning.md) | 0.x → 1.0.0 方針、GitHub Packages、**このリポジトリで破壊的変更とは何か** |

能力フラグの権威は `mc-kernel/docs/capability-flag-audit.md` である。
本リポジトリのドキュメントと食い違ったら、監査が正しい。

## License

MIT
