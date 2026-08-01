# バージョニングと公開

## 1. 現状

- **バージョン: `0.2.4`。**
- **自動 publish パイプラインは無い。** `package.json` の `exports` は TypeScript ソース（`./src/index.ts`）を直接指しており、
  `tsconfig.base.json:59` が `noEmit: true` なので `dist/` は存在しない。
- **実行時依存は `effect` と公開済みの `mc-kernel` / `mc-sim` / `mc-worldgen`。**
  GitHub Packages に公開されたバージョンを pin する。
- 開発中は `mc-dev-meta` workspace（16 リポジトリを `repos/` に clone して 1 つの pnpm workspace として束ねる）による
  `workspace:*` 解決でモノレポ同等の DX を得る（plan.md §6 Step 0-2）。

## 2. 0.x に留める方針

**mc-compose が実際に契約を消費するまで `0.x` から出ない。**

`1.0.0` は「機能が揃った」という宣言ではない。**「この界面が実際に使われ、使えることが確認された」という宣言**である。
このリポジトリの公開 API は `makeRedstoneStages` ただ 1 つ（[public-api.md](./public-api.md)）なので、
その検証は「mc-compose がそれを受け取り、全順序に組み込み、フレームが回った」以外の方法では成立しない。

plan.md §6 Step 3:

> 界面が安定した（API ロック 4 週間無変更）リポジトリから GitHub Packages 等へ npm 公開 + changesets 運用に切り替え。
> それまでは dev-meta workspace 統合で開発。

**上記は plan.md 執筆時点の計画としての引用であり、現行の org 標準ではない。**
「API ロック 4 週間無変更」という日数計測ベースの自動フリーズゲートは api-lock.md 自体の廃止と共に撤去され、
1.0.0 への昇格は自動ゲートなしの maintainer 裁量判断に一本化されている(RELEASE_STANDARD.md §4)。
「界面が安定してから npm 公開に切り替える」という判断のタイミング自体は変わらないが、
その判定手段が変わった。

plan.md §8 のリスク表も同じことを別角度から書いている。

> **新規構築初期は全界面が高 churn** → npm 公開を遅らせ dev-meta workspace で開発。bump 連鎖を構造的に回避

`0.x` は semver 上「マイナー bump で破壊してよい」区間である。
机上で正しい API と実際に使える API は違う。特に `FrameServices` が現在 `never` である以上
（`domain/frame-contract.ts:81`）、実行時に何が要るかはまだ誰も知らない。

## 3. 公開先

**GitHub Packages**（`https://npm.pkg.github.com`、`access: restricted`）。
`package.json` の `publishConfig` に設定済みで、検証済みソースパッケージを手動 publish する。

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

`.npmrc` にレジストリ設定は入っていない。現在の `.npmrc` は `fast-check` / `pure-rand` の
hoist 設定だけであり、`@nerima-games:registry=` の行と認証トークンの受け渡しは
publish パイプラインを追加するときに足す。

### 3-1. build / publish は完成条件到達時に追加する

完成条件（[testing.md](./testing.md) §4）に到達した時点で以下を追加する。

1. `tsconfig.build.json` を emit ありに変更し、`dist/` を生成する
2. `package.json` の `main` / `types` / `exports` を `dist/` に向ける
3. `files` から `domain` / `stages` を外し `dist` を入れる
4. GitHub Actions に publish job を追加する（tag push トリガ）
5. changesets を導入する

**先にやらない理由**: ビルド成果物を介すと型エラーがビルド時にしか出なくなり、
16 リポジトリを 1 つの workspace で開発している間の DX が落ちる。

## 4. ボトムアップの publish-then-pin

**組織全体で「下から公開して、公開されたものをピン留めする」順序を守る。**
これが「本リポジトリの実行時依存が `effect` だけ」であることの直接の理由である。

plan.md §6 Step 2 の構築順:

```
kernel
  → noise / meshing / physics / save / audio（相互独立、並行可）
    → worldgen
      → sim
        → render
          → kit
            → gameplay / redstone（並行可）
              → ui
                → multiplayer
                  → compose
```

mx-redstone は最後から 4 番目のグループにいる。前にあるものが 1 つも公開されていない現在、
`dependencies` に `@nerima-games/mc-sim` を書くことはできない——インストールできない依存を宣言すると、
ビルドすらできないスケルトンになる。

したがって現在の姿は次のようになっている。

| 本来 | 現在 |
| --- | --- |
| `import type { StageRegistration } from '@nerima-games/mc-kernel'` | `domain/frame-contract.ts` にローカル再掲 |
| kernel の `Position` キー符号化 | `domain/position-key.ts` にプレースホルダ |
| kernel の能力アクセサ | `domain/piston.ts` の `BlockCapabilityLookup` |
| mc-sim / mc-worldgen のサービス呼び出し | 未実装（`redstone:effects` の `run` は `Effect.void`） |

npm 公開・バージョン bump 運用は**界面が実際に上位階層(mc-compose)に消費され、動作確認が完了するまで開始しない**。
1.0.0 への昇格を含め、日数計測ベースの自動フリーズゲート(旧「API ロック 4 週間無変更」)は採用せず、
maintainer(take)による裁量判断のみで行う(RELEASE_STANDARD.md §4.2)。
それまでは `mc-dev-meta` の `workspace:*` 解決で開発する。

## 5. このリポジトリにおける「破壊的変更」とは何か

**公開 API が stage 登録だけなので、観測可能な界面は 3 つしかない。**

| 観測可能なもの | 変更が破壊的である理由 |
| --- | --- |
| `StageId` の文字列（`redstone:power` / `redstone:effects`） | mc-compose の全順序表と、他モジュールの `after` が名指しできる |
| 宣言する `after` の集合 | 全順序の解決結果が変わる |
| stage の粒度（2 本を 1 本にする / 3 本に割る） | 順序表に穴が開く、または新しい制約が要る |

**逆に、次のものは破壊的変更ではない。**

- 電力グラフのデータ構造（`CircuitBoard` / `PowerMap` / `Component`）を全面的に作り直す
- 隣接をデータからチャンク索引に変える
- `PowerMap` を `Uint8Array` にビットパックする
- `planPush` のアルゴリズムを変える、`PushPlan` の形を変える
- `ComponentKind` に部品を足す / 減らす

**これらが PATCH で済むことが、`index.ts` の「見えるが公開ではない」という気持ち悪さに対して支払われる対価である。**
[public-api.md](./public-api.md) §2 が「電力グラフの形は必ず変わる」と書いているとおり、
性能改善は 1 回では終わらない。その 1 回 1 回が協調リリースを要求する世界と、
PATCH で済む世界の差は、本リポジトリの実装期間を通じて効き続ける。

`index.ts:17-23` はこの取引を明文化しており、権威は本ドキュメント群であると書いている。
その根拠がここにある。

### 5-1. bump の判断基準

> **`0.x` の間の読み替え（全 16 リポジトリ共通の方針）**
>
> 本リポジトリは `0.1.0` であり、下流が契約を実際に消費して確認するまで `0.x` から出ない。
> **semver では `0.x` の破壊的変更は major bump ではなく minor bump である**（`0.1.0` → `0.2.0`）。
> したがって以下の MAJOR / MINOR / PATCH は **`1.0.0` 到達後の分類**であり、
> `0.x` の間は次のように読み替える。
>
> | 分類 | `1.0.0` 到達後 | `0.x` の間（現在） |
> | --- | --- | --- |
> | MAJOR | major bump | **minor bump**（`0.1.0` → `0.2.0`） |
> | MINOR | minor bump | patch bump |
> | PATCH | patch bump | patch bump |
>
> 分類そのものは `0.x` でも意味を持つ。MAJOR に分類される変更は、
> bump の大きさに関わらず**下流に必ず影響するもの**であり、告知と協調リリースの対象である。
> `0.x` の間に major bump を切ることはない。

| 変更 | 分類（`1.0.0` 到達後の bump。`0.x` では上記の読み替え） |
| --- | --- |
| 新しい stage の追加（既存 `StageId` は不変） | MINOR |
| `after` 制約の**追加** | MINOR（compose 側で解決不能になれば話は別。その場合は要相談） |
| 内部実装（電力グラフ / ピストン計画 / 部品集合） | PATCH |
| `StageId` の文字列の改名 | **MAJOR** |
| `after` 制約の**削除**（順序保証が消える） | **MAJOR** |
| stage の分割・統合 | **MAJOR** |
| `makeRedstoneStages` のシグネチャ変更（`GameModule` 化を含む） | **MAJOR** |
| ドキュメント・コメントのみ | PATCH |

## 6. kernel 公開時に消えるもの — このリポジトリで本当に効くピン

以下は `@nerima-games/mc-kernel` が公開された瞬間に削除・差し替えされる。

| 対象 | 差し替え先 |
| --- | --- |
| `domain/frame-contract.ts`（ファイルごと削除） | `import type { StageRegistration } from '@nerima-games/mc-kernel'` |
| `domain/position-key.ts`（ファイルごと削除） | kernel の `Position` とそのキー符号化 |
| `domain/piston.ts` の `BlockCapabilityLookup` / `BlockRef` | kernel の能力アクセサと `BlockType` |

前 2 つは型の置き換えであり、機械的である。`frame-contract.ts:14-20` は
「kernel のコピーと**文字レベルで同一**に保つ」ことをファイルの契約として宣言しており、
差し替えは import 文 1 本になるよう設計されている。

**前 2 つが PATCH で済むのは、どちらも `index.ts` から re-export していないからである。**
`export *` していた時期があり、その形のままだと `StageId` / `DeltaTimeSecs` / `StageRegistration` が
「所有していないパッケージの公開 API」になり、上表の**削除がそのまま MAJOR**に化けていた。
今は `index.ts` の末尾コメントが 2 ファイルの存在と削除予定だけを記し、名前は 1 つも出していない
（`test/public-api.test.ts` の
`REGRESSION: does not republish mc-kernel’s vocabulary as its own` が固定している）。

**3 つ目が、このリポジトリにとって実際に重要なバージョンピンである。**

`BlockCapabilityLookup` は `pistonImmovable` を関数として受け取るだけの狭い型だが、
その裏側には `mc-kernel/docs/capability-flag-audit.md` §3 が確定した能力モデルがある。
差し替えた瞬間、mx-redstone は kernel の能力表の**セマンティクスに縛られる**:

- `pistonImmovable` が boolean のままか、enum に広がるか
- 既定値が「押せる」なのか「押せない」なのか
- スライム／ハチミツによる隣接ブロック連結能力（DN-RS-10、監査未確定）がどの形で追加されるか

`mc-kernel/docs/versioning.md` §6 は「**既定値の変更は MAJOR**」と定めている。
既定値が変わると「何も書いていない全ブロックの挙動が変わる」からで、
mx-redstone にとってそれは「ピストンが押せるブロックの集合が黙って変わる」ことを意味する。
本リポジトリが監視すべき kernel の変更は、フラグの追加ではなく**既定値の変更**である。

kernel 側の設計は加算的（書かなかった能力は文書化された既定に解決される）なので、
能力の追加そのものは MINOR で済む。mx-redstone がその恩恵を受けられるのは、
`domain/piston.ts` にブロック名を 1 つも持っていないから——
つまり [design-notes.md](./design-notes.md) DN-RS-1 の構造的防御が、
そのままバージョニング上の防御にもなっている。
