# 実装前確定ルール SSOT — 完全版 v3.0

> **正本**: 本文書が運用ルール確定の唯一の正本。実装時にルール判断が必要な場合は本文書を参照すること。  
> **最終更新**: 2026-03-13 v3.0  
> **前提**: docs/14_技術設計チェックリストSSOT.md の設計決定を踏まえた実装レベルの運用ルール  
> **対象ファイル**: intent.ts / process-line-event.ts / record-persister.ts / clarification-handler.ts / interpretation.ts / memory-extraction.ts / pending-clarifications-repo.ts / correction-history-repo.ts / user-memory-repo.ts  
> **スキーマバージョン**: `INTENT_SCHEMA_VERSION = "1.0.0"` (intent.ts で管理)

---

## 0. 5系統の分類と事故パターン

| 系統 | 事故パターン | 本文書のルール |
|------|-------------|---------------|
| **1. 保存の境界** | 相談のつもりが自動保存される / 記録のつもりが相談扱い | R1〜R4 |
| **2. 日付と食事区分** | 「昨日の夕食」が「今日の昼食」に入る | R5〜R8 |
| **3. 修正フロー** | 修正が別の食事を上書きする | R9〜R12 |
| **4. pending 競合** | BOTが質問の回答を別の質問の回答と取り違える | R13〜R17 |
| **5. 監査・観測** | 「なぜ保存されたか」が追えない | R18〜R22 |

加えて **F. 技術負債予防** で Prompt drift / Memory汚染 / 二重保存 をカバーする。

---

## 1. 保存の境界（R1〜R4）

### R1. 主意図と副次意図の保存条件

> **原則**: 「記録モード」と「相談モード」で保存の挙動を明確に分離する

| # | 状況 | 判定 | 保存動作 | Phase B 起動 | 理由 |
|---|------|------|---------|-------------|------|
| R1-1 | 記録モード + intent_primary = record_* | confidence 不問 | Phase A→B→C パイプライン | **する** | 記録が本来の責務 |
| R1-2 | 記録モード + intent_primary = consult | — | 相談モードに自動切替して相談処理 | しない | ユーザーの意図を尊重 |
| R1-3 | 相談モード + intent_secondary = record_* + confidence **>= 0.8** + canSaveImmediately == **true** | 保存する | **即時保存のみ**。返信末尾に「📝 ※記録も保存しました」を付加 | **しない** | 相談UXを壊さない |
| R1-4 | 相談モード + intent_secondary = record_* + confidence **< 0.8** | 保存しない | 相談応答のみ返す | **しない** | 確信度不足で誤保存するリスク |
| R1-5 | 相談モード + intent_secondary = record_* + canSaveImmediately == **false** | 保存しない | 相談応答のみ返す。**Phase B は絶対に起動しない** | **しない** | 相談中に「いつの食事ですか？」はUX崩壊 |
| R1-6 | 相談モード + intent_primary = record_*（主意図が記録） | — | 記録モードに自動切替して Phase A→B→C パイプライン | **する** | 明確に記録したいユーザー |

**定数**: `CONSULT_SECONDARY_SAVE_THRESHOLD = 0.8`

**R1の鉄則**: 相談モードでは**即時保存できるものだけを保存する**。不足情報があるものは**絶対に保存しない**。

#### R1-6 補足: 自動切替ログフォーマット

```
[Consult] auto-switch to record: primary={intent_primary}, conf={confidence}
```

**コード実装箇所**: `handleConsultText()` — intent_primary が record_* の場合、`updateThreadMode(db, threadId, 'record')` の後に `handleRecordText()` へ委譲する。

---

### R2. 即時保存(canSaveImmediately)の判定基準

| 記録種別 | 必須条件（全て AND） | 保存先 | 備考 |
|----------|---------------------|--------|------|
| `record_weight` | ① weight_kg != null<br>② 20 <= weight_kg <= 300<br>③ needs_clarification == [] | body_metrics | 日付は timestamp でもOK（体重は推定誤差が小さい） |
| `record_meal` | ① target_date.resolved != null<br>② target_date.source ∈ {`explicit`, `inferred`}（**`timestamp` は不可**）<br>③ meal_type.value != null<br>④ meal_type.source ∈ {`explicit_keyword`, `time_expression`, `content_inference`}（**`timestamp` は不可**）<br>⑤ content_summary が非空（trim後1文字以上）<br>⑥ needs_clarification == [] | meal_entries | `source == 'timestamp'` は R3 へ |

**R2の鉄則**: `timestamp` 推定のみの場合、食事記録は即時保存しない。

**相談モードでの適用**: R1-3 でも同一ロジック。canSaveImmediately == false なら R1-5 により保存しない。

---

### R3. 確認付き保存(canSaveWithConfirmation)のポリシー

> **適用スコープ**: **記録モードのみ**。相談モードでは canSaveWithConfirmation は**使用しない**（R1-5 で担保）。

| # | 条件 | 動作 | 返信への付加文 |
|---|------|------|---------------|
| R3-1 | intent_primary == `record_meal` + needs_clarification == [] + content_summary 非空 + target_date.source == `timestamp` **のみ** | **保存する** + 推定通知 | `⏰ 日付は送信時刻から推定しました。違う場合は「昨日」などと教えてください。` |
| R3-2 | 同上 + meal_type.source == `timestamp` **のみ** | **保存する** + 推定通知 | `⏰ 食事区分は送信時刻から推定しました。違う場合は「朝食」などと教えてください。` |
| R3-3 | target_date.source == `timestamp` **かつ** meal_type.source == `timestamp` | **保存する** + 両方通知 | `⏰ 日付・食事区分は送信時刻から推定しました。違う場合はテキストで教えてください。` |

**R3のポリシー**: 「保存してから確認」（save-then-confirm）。UXを優先し、間違いは訂正フロー(R9〜R12)で対処。

**代替案の却下理由**:
- 「確認してから保存」(confirm-then-save) → pending が増え、UXが悪化。ユーザーが2ステップ必要
- 「明確化必須」 → 相談と記録の切替が煩雑。ほとんどのtimestamp推定は正しい

**R3-3 のコード実装**:
```typescript
// process-line-event.ts handleRecordText() 内
const confirmNotes: string[] = []
if (intent.target_date.source === 'timestamp') {
  confirmNotes.push('⏰ 日付は送信時刻から推定しました。違う場合は「昨日」などと教えてください。')
}
if (intent.meal_type?.source === 'timestamp') {
  confirmNotes.push('⏰ 食事区分は送信時刻から推定しました。違う場合は「朝食」などと教えてください。')
}
const confirmNote = confirmNotes.length > 0
  ? '\n\n' + confirmNotes.join('\n')
  : ''
```

---

### R4. 同日同区分の meal_entry 重複処理

| # | 状況 | 動作 | DB操作 | 理由 |
|---|------|------|--------|------|
| R4-1 | 同日同区分の meal_entry が**存在しない** | 新規作成 | INSERT | 通常のケース |
| R4-2 | 同日同区分の meal_entry が**既に存在** | **追記**（`/` 区切り） | UPDATE meal_text = old + ' / ' + new | 「朝食にパン」→「朝食にヨーグルト」は追記が自然 |
| R4-3 | **上書き**したい場合 | ユーザーが明示的に修正指示 | correct_record (content_change) | 「朝食をパンに変更」→ 置換 |
| R4-4 | **別レコード**にしたい場合 | **しない**。1日1区分1レコード固定 | — | スキーマの一貫性。PFC合算も1レコード前提 |

**R4の鉄則**: 1日1区分1レコード。追記のみ。置換は修正フロー経由。

**追記の上限**: meal_text の長さが 2000 文字を超える場合は追記せずエラーメッセージ「記録が長すぎます。修正で内容を整理してください。」を返す。

---

## 2. 日付と食事区分の解釈（R5〜R8）

### R5. 日付解釈ルール

> **タイムゾーン**: 全て **JST (UTC+9)** 固定。サーバー時刻に依存しない。

| # | ユーザー表現 | 解釈 | source | needs_confirmation |
|---|-------------|------|--------|-------------------|
| R5-1 | 「今日」「きょう」「today」 | 当日 JST | `explicit` | false |
| R5-2 | 「昨日」「きのう」「yesterday」 | 当日 - 1 | `explicit` | false |
| R5-3 | 「おととい」「一昨日」 | 当日 - 2 | `explicit` | false |
| R5-4 | 「さっき」「今」「たった今」 | 当日 | `inferred` | false |
| R5-5 | 「3/10」「3月10日」 | 直接パース（年は送信年。未来なら前年） | `explicit` | false |
| R5-6 | 「月曜日の」「先週の水曜」 | 直近の過去の該当曜日 | `explicit` | false |
| R5-7 | 「朝」「昼」「夜」（日付としてではなく時間帯として） | 当日 | `inferred` | false |
| R5-8 | **日付表現が一切ない** | メッセージ送信時刻から当日を設定 | `timestamp` | **true** |
| R5-9 | 「今朝」 | 当日 | `explicit` | false |

#### R5-10: 深夜帯ルール（JST 0:00〜4:59）

| 時間帯 | ユーザー表現 | 解釈 |
|--------|-------------|------|
| 0:00〜4:59 | 「夜中にラーメン食べた」「夜食」 | **当日**として扱う（日付は変わっているが、生活リズムとしては同日） |
| 0:00〜4:59 | 「さっき」「今」 | **当日**として扱う |
| 0:00〜4:59 | 「昨日の夕食」 | 通常通り前日 |
| 0:00〜4:59 | 日付表現なし | **当日** (timestamp)。source=`timestamp`, needs_confirmation=true |

**R5の鉄則**: 深夜帯は「当日扱い」。前日にはしない。ユーザーが「昨日」と言った場合のみ前日。

#### R5-11: 未来日付の扱い

| 状況 | 動作 | 理由 |
|------|------|------|
| 解釈結果が未来日付 | target_date.resolved = **null**、source = `unknown`、needs_clarification に `target_date` を追加 | 食事・体重は過去の記録のため |
| 「明日」「来週」 | 同上 | 予約記録は非対応 |

#### R5-12: 30日以上前の日付

| 状況 | 動作 | 理由 |
|------|------|------|
| 解釈結果が30日以上前 | target_date.resolved = **null**、source = `unknown`、needs_clarification に `target_date` を追加 | 古すぎるデータは誤解釈の可能性大 |

**定数**: `DATE_LOOKBACK_DAYS = 30`

---

### R6. 食事区分(meal_type)解決ルール

> **優先順位（上から順に適用。最初にヒットしたものを採用）**

| 優先度 | 解決方法 | source | needs_confirmation | 例 |
|--------|----------|--------|-------------------|-----|
| 1 | **明示的キーワード** | `explicit_keyword` | false | 「朝食」「昼ごはん」「ランチ」「おやつ」 |
| 2 | **時間表現** | `time_expression` | false | 「3時に」→ snack、「夜9時に」→ dinner |
| 3 | **内容推定** | `content_inference` | false | 「ポテチ」「チョコ」→ snack |
| 4 | **送信時刻** | `timestamp` | **true** | 下記テーブル参照 |
| 5 | **不明** | `unknown` | true | value = null、clarification 対象 |

#### R6-1: 時間帯 → meal_type マッピング（JST）

| 時間帯 | meal_type | 理由 |
|--------|-----------|------|
| 05:00〜10:29 | `breakfast` | 朝食の一般的な時間 |
| 10:30〜14:59 | `lunch` | 昼食の一般的な時間 |
| 15:00〜17:29 | `snack` | おやつの時間 |
| 17:30〜22:59 | `dinner` | 夕食の一般的な時間 |
| 23:00〜04:59 | `other` | 夜食 |

**R6の鉄則**: keyword > time_expression > content_inference > timestamp。timestamp推定は必ず confirmation 付き。

---

### R7. 食事キーワード → meal_type マッピング

| meal_type | キーワード（日本語） | キーワード（英語） |
|-----------|---------------------|-------------------|
| `breakfast` | 朝食、朝ご飯、朝ごはん、朝飯、モーニング | breakfast |
| `lunch` | 昼食、昼ご飯、昼ごはん、昼飯、ランチ | lunch |
| `dinner` | 夕食、夕飯、夕ご飯、夕ごはん、晩ご飯、晩飯、ディナー | dinner |
| `snack` | 間食、おやつ、お菓子、スナック、3時のおやつ | snack |
| `other` | 夜食、深夜メシ | — |

---

### R8. 体重バリデーション

| # | ルール | 値 | 動作 |
|---|--------|-----|------|
| R8-1 | 最小値 | `20` kg | 未満は reject + clarification |
| R8-2 | 最大値 | `300` kg | 超過は reject + clarification |
| R8-3 | 小数点以下 | 最大2桁 | `58.5`, `72.35` はOK。`58.123` は2桁に丸める |
| R8-4 | 日付不問 | — | 体重は timestamp でも即時保存可（R2参照）。推定誤差の影響が小さいため |

**定数**: `WEIGHT_MIN = 20`, `WEIGHT_MAX = 300`

---

## 3. 修正フロー（R9〜R12）

### R9. 修正対象の特定ロジック（優先順位）

> **鉄則**: 推定で修正しない。特定できない場合は**必ず再質問**する。

| 優先順位 | 特定方法 | 条件 | 例 | フォールバック |
|----------|----------|------|-----|-------------|
| 1 | **明示指定** | correction_target に target_date + target_meal_type が**両方**ある | 「昨日の朝食を夕食に変更」 | — |
| 2 | **日付+直前コンテキスト** | target_date のみ指定 + 直前BOT返信に食事区分あり | 「昨日の記録を鮭に修正」（直前が朝食保存の返信）→ 昨日の朝食を修正 | 優先順位3へ |
| 3 | **直前の記録** | target_date も target_meal_type も null + 直前BOT返信に保存完了メッセージ | 「鮭じゃなくて卵焼き」→ 直前に保存した記録を修正 | 優先順位4へ |
| 4 | **候補提示** | 上記全て失敗 | 「記録を直して」→ Phase B clarification で「どの記録を修正しますか？」 | — |

#### R9 補足: 「直前コンテキスト」の定義

- **直前BOT返信** = conversation_messages テーブルから `sender_type='bot'` の最新1件を取得
- **食事区分の検出** = BOT返信のテキストに「朝食」「昼食」「夕食」「間食」等のキーワードが含まれる場合
- **有効期限** = 直前BOT返信の `sent_at` が現在時刻から **30分以内** のみ有効。30分超は無視。
- **定数**: `CORRECTION_CONTEXT_EXPIRY_MINUTES = 30`

#### R9-1: 修正不能時の挙動

| 状況 | 動作 | **やってはいけないこと** |
|------|------|----------------------|
| 対象レコードが見つからない | 「{日付}の{食事区分}の記録が見つかりませんでした。」と返信 | **勝手に推定して別のレコードを修正しない** |
| correction_target が全て null | Phase B clarification を起動。「どの記録を修正しますか？」 | **デフォルトで今日の最新レコードを修正しない** |
| 複数候補がある | 候補を一覧表示して選択させる（Phase 2 で実装。MVPでは最新1件を修正） | — |

---

### R10. correction_history の必須項目

| フィールド | 必須 | 値の説明 | 備考 |
|-----------|------|---------|------|
| `id` | ✅ | 自動生成 UUID | |
| `user_account_id` | ✅ | 操作ユーザー | |
| `target_table` | ✅ | `meal_entries` / `body_metrics` / `daily_logs` | |
| `target_record_id` | ✅ | 修正対象のレコードID | |
| `correction_type` | ✅ | enum（R10-1参照） | |
| `old_value_json` | ✅ | **修正前の完全な値**。JSON文字列 | **ロールバック用。省略禁止** |
| `new_value_json` | ✅ | 修正後の値。delete時はnull | |
| `triggered_by` | ✅ | `user`（デフォルト） / `system` / `admin` | |
| `message_id` | ○ | 修正指示のメッセージID | source追跡用 |
| `reason` | ○ | AI の reasoning テキスト | デバッグ用 |
| `created_at` | ✅ | ISO8601 | |

#### R10-1: correction_type の enum

| correction_type | 説明 |
|----------------|------|
| `meal_type_change` | 食事区分の変更（朝食→夕食等） |
| `content_change` | 食事内容の変更（鮭→卵焼き等） |
| `date_change` | 日付の変更 |
| `nutrition_change` | 栄養値の手動修正 |
| `weight_change` | 体重値の変更 |
| `delete` | 削除 |
| `append` | R4: 同日同区分への追記（自動） |

---

### R11. 削除ルール

| # | ルール | 確定値 | 理由 |
|---|--------|--------|------|
| R11-1 | 削除種別 | **物理削除**（DELETE FROM） | 論理削除は meal_entries のクエリを複雑にする |
| R11-2 | correction_history | **必須**。削除前に old_value_json を INSERT | 復元可能にする |
| R11-3 | 削除確認 | **MVP: 確認なし即削除**。Phase 2: Quick Reply「はい/いいえ」 | MVP のシンプルさ優先 |
| R11-4 | 体重の削除 | **非対応**（MVP）。body_metrics は上書きのみ | 体重は日次1件のため上書きで十分 |

---

### R12. 修正と保存のアトミシティ

| # | ルール | MVP実装 | Phase 2 実装 |
|---|--------|--------|-------------|
| R12-1 | correction_history INSERT と レコード UPDATE は同時に成功する | **try-catch で順次実行**。history失敗時はエラーログのみ | `env.DB.batch([...])` でアトミック化 |
| R12-2 | correction_history INSERT 失敗時にレコードを修正しない | **MVPでは保証しない**（history失敗でもUPDATE済み） | batch() で保証 |
| R12-3 | 同一メッセージで同一レコードを2回修正しない | **F3 idempotency で保証** | — |

**R12 MVPの許容基準**: correction_history の INSERT 失敗率は D1 の SLA 上極めて低い（<0.01%）。万一失敗した場合もレコード自体は正しく修正されるため、UX上の問題は軽微。ただし `console.error` でアラートし、Phase 2 で batch() に移行する。

---

## 4. pending 状態の競合（R13〜R17）

### R13. 1ユーザー1pending の原則

| # | ルール | 実装 |
|---|--------|------|
| R13-1 | 1ユーザーにつき `status = 'asking'` のレコードは**常に最大1件** | createPendingClarification で既存 asking を cancelled にしてから INSERT |
| R13-2 | `pending_clarifications` と `pending_image_confirm` は**並立しない** | 画像確認中(S3)は全テキスト入力をブロック（① の最優先処理）。pending_clarification は不要 |
| R13-3 | `pending_clarifications` と `intake`(問診) は**並立しない** | 問診中(S1)は ④ で先にハンドル。pending_clarification は存在しない |

**定数**: `MAX_PENDING_PER_USER = 1`

---

### R14. pending cancel 条件（完全一覧）

> **重要: clarification 回答 vs 新規テキストの判定基準**  
> - `handleRecordText()` の冒頭で `findActiveClarification()` を行い、pending が存在する場合は**まず回答として解釈を試みる**（`handleClarificationAnswer()`）。  
> - パース成功 → clarification の回答として処理。新 Phase A は起動しない。  
> - パース失敗 → 再質問。新 Phase A は起動しない。  
> - pending が**存在しない**場合のみ、通常の Phase A 処理に進む。  
> - したがって R14-1 の「新しい記録テキスト」が pending を cancel するケースは、**明示的モード切替コマンド**（R14-2）や**画像送信**（R14-3）経由でのみ発生する。通常テキストは clarification 回答として優先消費される。

| # | トリガー | pending_clarifications の動作 | 理由 |
|---|---------|------------------------------|------|
| R14-1 | **新しい記録テキスト**が来た（clarification 回答パース失敗 + ユーザーが明確に別の記録を送った場合） | 現実装では pending が残り再質問。Phase 2 で AI が「これは回答ではなく新規記録」と判定し cancel する機能を追加予定 | MVPでは回答優先。ユーザーが「記録モード」と切替すれば R14-2 で cancel |
| R14-2 | **モード切替コマンド**（「相談モード」「記録モード」等）| 既存 asking を `cancelled`。モード切替実行 | 明示的ユーザー意思 |
| R14-3 | **画像**が送信された | 既存 asking を `cancelled`。画像処理を実行 | 画像は新しい記録行為 |
| R14-4 | **問診コマンド**（「問診」「ヒアリング」等） | 既存 asking を `cancelled`。問診開始 | 問診は最優先 |
| R14-5 | **招待コード**が送信された | 既存 asking を `cancelled`。コード処理を実行 | 認証は最優先 |
| R14-6 | **24時間経過** | Cron で `expired` に更新 | 放置 pending のクリーンアップ |
| R14-7 | **Phase C 完了** | `answered` レコードを**物理削除** | DB 肥大化防止 |
| R14-8 | **新規 pending 作成時** | 既存 asking を `cancelled`（R13-1 の強制） | 1ユーザー1pending |

---

### R15. 画像確認中(S3)のブロック範囲

| # | 入力種別 | S3中の動作 | 理由 |
|---|----------|----------|------|
| R15-1 | 確定キーワード（「確定」「はい」「OK」等） | 画像確認を実行 | — |
| R15-2 | 取消キーワード（「取消」「キャンセル」「いいえ」等） | 画像を破棄 | — |
| R15-3 | その他テキスト | **テキスト修正**として処理（AI再解析→提案更新） | S3中は記録/相談をブロック |
| R15-4 | 新しい画像 | **ブロック**。「先に確認が完了してから」と返信 | 同時処理不可 |

---

### R16. 問診中(S1)のブロック範囲

| # | 入力種別 | S1中の動作 | 理由 |
|---|----------|----------|------|
| R16-1 | 問診の回答テキスト | 問診フローを進める | — |
| R16-2 | 招待コード（② で先に評価） | コード処理を実行 | 認証は例外的に受付 |
| R16-3 | モード切替コマンド | **無視**。問診の回答として処理 | 問診中はモード切替不可 |
| R16-4 | 記録テキスト/相談テキスト | **無視**。問診の回答として処理 | 問診完了まで他の機能はロック |
| R16-5 | 画像 | **通常処理**（問診とは独立して解析） | 画像は問診の回答ではないため |

---

### R17. pending のステータス遷移（一方向のみ）

```
asking ──→ answered ──→ (物理削除)
  │
  ├──→ cancelled（新 pending 作成時 / モード切替 / 画像 / 新テキスト）
  │
  └──→ expired（24時間経過 Cron）
```

**逆方向の遷移は禁止**: cancelled → asking にする場合は新規レコードを INSERT する。

**cancelled / expired の保持期間**: 監査用に **30日間** DB に保持。30日経過後に Cron で物理削除。
**定数**: `PENDING_RETENTION_DAYS = 30`

---

## 5. 監査・観測（R18〜R22）

### R18. 解釈結果のログ保存

| # | 保存項目 | 保存先 | タイミング |
|---|---------|--------|----------|
| R18-1 | intent_primary | console.log | Phase A 完了時 |
| R18-2 | intent_secondary | console.log | Phase A 完了時 |
| R18-3 | confidence | console.log | Phase A 完了時 |
| R18-4 | needs_clarification | console.log | Phase A 完了時 |
| R18-5 | UnifiedIntent JSON 全体 | conversation_messages.normalized_text | Phase A 完了時（Phase 2 で interpreted_messages テーブルに移行） |

**ログフォーマット**:
```
[RecordText] Phase A: primary={intent_primary}, secondary={intent_secondary}, conf={confidence}, clarify=[{needs_clarification}]
```

**Phase 2 の interpreted_messages テーブル移行計画**:
- migration 0017_interpreted_messages.sql で新テーブルを作成
- フィールド: id, conversation_message_id, intent_json, schema_version, processing_time_ms, created_at
- intent_json には UnifiedIntent の完全 JSON を保存
- schema_version で Prompt Contract Drift を追跡

---

### R19. 明確化フローのログ保存

| # | 保存項目 | 保存先 | タイミング |
|---|---------|--------|----------|
| R19-1 | clarification開始: id, field, missing_fields | console.log | startClarificationFlow |
| R19-2 | 回答受信: field, parsed_value, remaining | console.log | handleClarificationAnswer |
| R19-3 | 完了/期限切れ/キャンセル | console.log + pending_clarifications.status | 各遷移時 |
| R19-4 | ask_count（質問回数） | pending_clarifications.ask_count | 毎回更新 |

---

### R20. 保存結果のログ

| # | 保存項目 | 保存先 | タイミング |
|---|---------|--------|----------|
| R20-1 | 保存操作: created / updated(追記) / rejected | console.log | persistRecord完了時 |
| R20-2 | 保存先テーブル + レコードID | console.log | persistRecord完了時 |
| R20-3 | 保存失敗理由 | console.error | persistRecord失敗時 |

**ログフォーマット**:
```
[RecordPersister] {action}: table={table}, id={id}, date={date}, type={type}
[RecordPersister] error: {reason}
```

---

### R21. 相談中副次記録のログ

| # | 保存項目 | 保存先 | タイミング |
|---|---------|--------|----------|
| R21-1 | 副次意図検出: intent_secondary, confidence | console.log | handleConsultText |
| R21-2 | 保存判定: saved / skipped(confidence不足) / skipped(not-immediate) | console.log | handleConsultText |
| R21-3 | 保存した場合: record_type + 値 | console.log | handleConsultText |

**ログフォーマット**:
```
[Consult] secondary: intent={intent_secondary}, conf={confidence}, decision={saved|skipped_confidence|skipped_not_immediate}
```

---

### R22. AIフォールバックのログ

| # | 保存項目 | 保存先 | タイミング |
|---|---------|--------|----------|
| R22-1 | AI成功/失敗 | console.log/error | interpretMessage |
| R22-2 | fallback使用: regex_weight / regex_meal / unclear | console.log | createFallbackIntent |
| R22-3 | JSON parse 失敗の raw 先頭200文字 | console.warn | interpretMessage |

**ログフォーマット**:
```
[Interpretation] AI OK: intent={primary}, conf={confidence}
[Interpretation] AI FAIL: using fallback. error={message}
[Interpretation] fallback: type={regex_weight|regex_meal|unclear}
```

---

## F. 技術負債予防

### F1. Prompt Contract Drift（AI出力の形状崩れ）

| # | 対策 | 実装状態 |
|---|------|---------|
| F1-1 | UnifiedIntent の JSON Schema を固定 | ✅ intent.ts で型定義済み |
| F1-2 | validateAndNormalizeIntent() で全フィールドをバリデーション | ✅ 実装済み |
| F1-3 | 不正な enum 値は安全なデフォルトにフォールバック | ✅ intent_primary → 'unclear', confidence → 0.5 |
| F1-4 | responseFormat: 'json_object' を必ず使用 | ✅ interpretation.ts |
| F1-5 | **INTENT_SCHEMA_VERSION** 定数で互換性を管理 | ✅ intent.ts v3.0 で追加 |

---

### F2. Memory 汚染（user_memory_items の誤抽出長期汚染）

| # | 対策 | 実装状態 | 定数 |
|---|------|---------|------|
| F2-1 | confidence < 0.6 のメモリはコンテキスト注入しない | ✅ 実装済み | `MEMORY_CONFIDENCE_MIN = 0.6` |
| F2-2 | allergy / health_condition は confidence >= 0.9 で抽出 | ✅ プロンプトで指示済み | — |
| F2-3 | 既存メモリより低い confidence の更新はスキップ | ✅ upsertMemoryItem で confidence 比較 | — |
| F2-4 | memory の is_active=0 で論理削除（物理削除は将来） | ✅ deactivateMemoryItem | — |
| F2-5 | admin によるメモリ修正 | ❌ Phase 2 | — |
| F2-6 | decay_score / last_used_at | ❌ Phase 2 | — |
| F2-7 | superseded_by（矛盾メモリの追跡） | ❌ Phase 2 | — |

---

### F3. 二重保存（Webhook retry / LINE再送）

| # | 対策 | 実装状態 |
|---|------|---------|
| F3-1 | line_message_id UNIQUE インデックス（migration 0016） | ✅ 適用済み |
| F3-2 | INSERT 失敗時（UNIQUE違反）はイベント処理をスキップ | ✅ process-line-event.ts |
| F3-3 | correction_history に source_message_id を記録 | ✅ message_id フィールド |
| F3-4 | webhook は常に 200 OK を返す | ✅ routes/line/webhook.ts |

---

### F4. 相談中の自動保存の暴走

| # | 対策 | 実装状態 |
|---|------|---------|
| F4-1 | confidence >= 0.8 のみ（R1 参照） | ✅ |
| F4-2 | canSaveImmediately == true のみ（Phase B は起動しない）| ✅ |
| F4-3 | 保存時は必ず「📝 ※記録も保存しました」を返信に含める | ✅ |
| F4-4 | 曖昧なら**保存しない** | ✅ R1-4, R1-5 で保証 |

---

## 定数一覧（コードに埋め込む全ての値）

| 定数名 | 値 | ファイル | ルール |
|--------|-----|---------|--------|
| `INTENT_SCHEMA_VERSION` | `"1.0.0"` | intent.ts | F1-5 |
| `CONSULT_SECONDARY_SAVE_THRESHOLD` | `0.8` | intent.ts | R1-3 |
| `WEIGHT_MIN` | `20` | intent.ts | R2, R8-1 |
| `WEIGHT_MAX` | `300` | intent.ts | R2, R8-2 |
| `CLARIFICATION_EXPIRY_HOURS` | `24` | intent.ts | R14-6 |
| `MAX_PENDING_PER_USER` | `1` | intent.ts | R13-1 |
| `DATE_LOOKBACK_DAYS` | `30` | intent.ts | R5-12 |
| `MEMORY_EXTRACTION_MIN_LENGTH` | `5` | intent.ts | F2 |
| `MEMORY_CONFIDENCE_MIN` | `0.6` | intent.ts | F2-1 |
| `CORRECTION_CONTEXT_EXPIRY_MINUTES` | `30` | intent.ts | R9 |
| `PENDING_RETENTION_DAYS` | `30` | intent.ts | R17 |
| `MEAL_TEXT_MAX_LENGTH` | `2000` | intent.ts | R4 |

---

## 実装GOチェックリスト

| # | 条件 | 状態 | 確認箇所 |
|---|------|------|---------|
| 1 | docs/15_実装前確定ルールSSOT.md が完成 | ✅ | 本文書 v3.0 |
| 2 | Unified Intent Schema が固定（バージョニング付き） | ✅ | intent.ts INTENT_SCHEMA_VERSION |
| 3 | pending / correction / memory の3テーブル定義が固定 | ✅ | migration 0013-0015 |
| 4 | save_policy の判定基準が固定（canSaveImmediately / canSaveWithConfirmation） | ✅ | R2, R3 |
| 5 | correction target resolution の優先順位が固定 | ✅ | R9 |
| 6 | idempotency と audit の実装方針が固定 | ✅ | F3, R18-R22 |
| 7 | 相談と記録の境界が固定 | ✅ | R1 |
| 8 | timestamp 推定の保存ポリシーが固定 | ✅ | R3（記録モード限定） |
| 9 | pending cancel 条件が網羅 | ✅ | R14（回答vs新規テキストの判定含む） |
| 10 | 削除ルールが固定 | ✅ | R11 |
| 11 | R3 の相談モード非適用が明文化 | ✅ | R3 適用スコープ |
| 12 | clarification 回答 vs 新規テキストの判定基準が明文化 | ✅ | R14 冒頭注記 |

---

## 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。12項目を4カテゴリで明文化 |
| 2026-03-13 | v2.0 | **完全版に書き換え**。5系統22ルール + 技術負債予防4項目に拡大。全決定事項を曖昧さゼロで明文化。日付解釈ルール（深夜帯、未来日付、30日制限）、食事区分マッピング、修正対象特定優先順位、pending cancel完全一覧、S3/S1ブロック範囲、監査ログ必須項目、Memory汚染対策を追加 |
| 2026-03-13 | v3.0 | **曖昧さゼロ完全確定版**。以下を追加・明文化:<br>- INTENT_SCHEMA_VERSION 定数追加 (F1-5)<br>- R3 の適用スコープを「記録モード限定」に明文化<br>- R3-3 の confirmNote 組立ロジックを正確なコード例で記載<br>- R4 に meal_text 上限 2000文字を追加<br>- R9 の「直前コンテキスト」定義を DB 参照方法・有効期限(30分)込みで明文化<br>- R12 の MVP 許容基準を定量的に記載<br>- R14 冒頭に clarification 回答 vs 新規テキストの判定基準を詳細記載<br>- R17 に cancelled/expired の保持期間(30日)を追加<br>- R18 に Phase 2 interpreted_messages テーブル移行計画を追加<br>- R1-6 に自動切替時のログフォーマットを追加<br>- 新定数: CORRECTION_CONTEXT_EXPIRY_MINUTES, PENDING_RETENTION_DAYS, MEAL_TEXT_MAX_LENGTH<br>- GOチェックリストを12項目に拡大 |
