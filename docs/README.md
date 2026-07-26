# mx-redstone ドキュメント

`@nerima-games/mx-redstone` は 16 リポジトリ構成の**体験モジュール**、すなわち plan.md §2.3-1 の言う**動詞**である。
「電力はこう流れる」という規則を所有し、状態は 1 つも所有しない。
ピストンが押すブロックも、押されたプレイヤーも、mc-worldgen と mc-sim のものである。

上位仕様は `/Users/take/Documents/plan.md`（以下 plan.md）。
能力フラグについての権威は `mc-kernel/docs/capability-flag-audit.md` であり、本ドキュメント群より上位にある。

## 索引

| ドキュメント | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 4 階層、全 16 リポジトリの依存グラフ、**名詞/動詞ルール**、体験モジュール間エッジがゼロである理由、推移閉包禁止、mc-audio という不在のエッジ |
| [responsibility.md](./responsibility.md) | 責務と**明示的な非スコープ**（どれが誰のものか）、親リポジトリ、kit が devDependency 専用である理由 |
| [public-api.md](./public-api.md) | **公開 API は stage 登録だけ**。電力グラフが内部でなければならない理由、`index.ts` 全エクスポートの契約/内部の台帳 |
| [design-notes.md](./design-notes.md) | 設計注意 DN-RS-1〜11。それぞれ参照実装の `path:line` と**回帰テスト名**つき |
| [porting.md](./porting.md) | 参照実装からの移植元（**実測 LOC**）、plan.md との差異、移植順序 |
| [testing.md](./testing.md) | 検証ゲート、fixture 回路テストの形、完成条件、99% カバレッジゲートの投入時期 |
| [versioning.md](./versioning.md) | 0.x → 1.0.0 方針、ボトムアップ publish-then-pin、**このリポジトリで破壊的変更とは何か** |

## 読む順序

- **初めてこのリポジトリを見る**: [architecture.md](./architecture.md) §3（名詞/動詞）→ [responsibility.md](./responsibility.md) §2（非スコープ）
- **stage を足す / 順序を触る**: [public-api.md](./public-api.md) §3-4 → [design-notes.md](./design-notes.md) DN-RS-7
- **ピストンやブロック判定を実装する**: [design-notes.md](./design-notes.md) DN-RS-1 →
  `mc-kernel/docs/capability-flag-audit.md`（**先に監査を読むこと**）
- **回路のロジックを書く**: [design-notes.md](./design-notes.md) DN-RS-2〜DN-RS-6 → [testing.md](./testing.md) §3
- **カバレッジ / テストの書き方**: [testing.md](./testing.md) §3-2, §6 → [design-notes.md](./design-notes.md) DN-RS-11
- **参照実装から移植する**: [porting.md](./porting.md) → [testing.md](./testing.md) §7（テストを先に移す）
- **リリースする**: [versioning.md](./versioning.md)

## ドキュメントの性質について

`porting.md` の LOC は 2026-07-26 に `wc -l` で実測した値である。plan.md §3 の数値は「目安」であり、
一致しない箇所は**訂正せず差異として記録してある**（`porting.md` §2-1）。
数字を引用するときは計数条件も一緒に引くこと。

能力フラグについて本ドキュメント群と `mc-kernel/docs/capability-flag-audit.md` が食い違った場合、
**監査が正しく、こちらを直す**。
