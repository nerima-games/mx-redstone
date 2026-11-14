# レッドストーンのブラウザデバッグ UI

## 起動と操作

リポジトリのルートで次を実行し、`http://localhost:5182` を開きます。

```console
$ pnpm preview:browser
```

既定ポートを変更する場合は `HARNESS_PORT` を指定します。設定されたポートが使用中の場合、サーバーは別のポートへ移動せず起動に失敗します。

```console
$ HARNESS_PORT=4191 pnpm preview:browser
```

Scenario でシナリオを選び、`Step frame` で redstone tick を 1 回進めます。`Play` / `Pause` で再生を制御し、`Speed` は 0.25×、0.5×、1×、2×、4×を切り替えます。`Reset` は選択中のシナリオを tick 0 に戻します。`Show panels` で診断パネルを表示し、`Copy URL` で現在のシナリオ、再生状態、速度、パネル表示、tick を含む URL をコピーします。

## パネル

- **Power and provenance**: 現在と直前の power map、各セルの電力、記録された電力の出所候補と経路を表示します。観測に値がない診断項目は unavailable として表示します。
- **Timeline and simulation ticks**: Shows integer redstone ticks supplied by mc-sim, the power difference between the latest two recorded ticks, and a tape of the latest 20 power samples. It does not accumulate frame delta or cap redstone catch-up ticks. The current observation is also available as JSON.
- **Components and decisions**: fixture と入力注入の状態、部品の状態と timer、保留中の button press、host fixture が実行した plan と拒否理由、invariant checker の結果を表示します。host 入力や部品状態が提供されない項目は unavailable または blocked として表示します。
- **Events and transitions**: 選択中の scenario と tick、直近に drain した event batch、fixture 入力、保留中の button press を表示します。event と入力の因果関係は現在記録していないため unavailable と表示します。
- **Host boundary**: host fixture が組み立てた realm snapshot、host apply に到達したか、適用された request、host failure を表示します。

## Scenario とデータの出所

registry には次の 23 scenario があります。

| 領域 | Scenario ID |
| --- | --- |
| 回路 | `rs.wire.attenuation`, `rs.torch.inversion-burnout`, `rs.lever.toggle`, `rs.button.pulse`, `rs.repeater.delay-lock`, `rs.lamp.isolation-transition`, `rs.comparator.ladder` |
| センサー | `rs.observer.change-pulse`, `rs.pressure-plate.occupancy`, `rs.target.hit-strength` |
| 効果・host | `rs.piston.push-refusal`, `rs.sticky-piston.retract-pull`, `rs.hopper.lock-transfer`, `rs.dispenser.rising-edge`, `rs.dropper.rising-edge`, `rs.note-block.trigger`, `rs.powered-rail.transition`, `rs.door.open-transition`, `rs.trapdoor.open-transition` |
| runtime・操作 | `rs.world.vertical-strong-power`, `rs.host.failure-injection`, `rs.stage.frame-timeline`, `rs.share.json-roundtrip` |

host path の scenario は fake realm から host snapshot を作り、runtime と stage を進めて `applyRedstoneHostEvents` まで実行します。fixture-only の scenario は決定的な `RedstoneWorldSnapshot` を runtime に渡します。blocked の scenario は、必要な入力が無い理由を表示します。いずれも mc-compose の実 world を読み取っているわけではありません。fixture の値を vanilla や実 world の観測値として扱わず、runtime から得られない値を推定しないでください。

## 内部 observation API

デバッグ UI は内部 API を使います。`src/index.ts` の package root export ではありません。

- `observeRedstoneFrame(runtime)` は tick、dimension ごとの component state / power / timer、および保留中の button press 位置を返します。button press の集合は読み取り側が runtime state を変更しないコピーです。
- `checkRedstoneInvariants(runtime)` は `power-level-range`、`wire-neighbor-decay`、`torch-support-exclusion`、`block-power-channel-consistency` の 4 結果を返します。失敗結果には違反した dimension と position が含まれます。
- `applyRedstoneHostEventsObserved({ runtime, realms, port, observer })` は piston の拒否時に `observer.onPistonRefusal({ event, outcome })` を通知します。通常の `applyRedstoneHostEvents` の contract は変更しません。

Invariant checker は source provenance を完全には復元できません。runtime が保持する block power は source 別の値ではなく channel ごとの最大値です。そのため support block で別 source と同じか弱い torch の寄与は分離できず、checker は観測可能な channel の超過を報告するにとどまります。

## Consumer 側の残作業

solid-block conduction を mc-compose の実 world で使うには、mc-compose が `isRedstoneConductiveAt` を `syncSnapshot` に渡し、適用対象の source component に `strongPowerTo` を設定する必要があります。この mc-compose 側の接続作業は今回の mx-redstone 実装範囲外です。

The host adapter decodes supported stateful blocks with mc-kernel schemas: comparator (`facing`, `mode`, `powered`), dispenser and dropper (`facing`, `triggered`), hopper (`facing`, `enabled`), observer (`facing`, `powered`), piston and sticky piston (`facing`, `extended`), floor redstone torch (`lit`), wall redstone torch (`facing`, `lit`), and repeater (`facing`, `delay`, `locked`, `powered`). Kernel 0.17.0 defines `sticky_piston` and `redstone_wall_torch`; sticky pistons use the existing sticky piston planner, and a wall torch uses the block opposite its `facing` state as support. Missing or invalid state still returns a typed failure. Button input and observed block identity arrive through host lookups. Pressure-plate occupancy and target hit coordinates are not available in the current host contract, so those scenarios remain deterministic snapshot fixtures.
