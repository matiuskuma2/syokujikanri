# diet-bot LINE 運用フロー・画面要件 SSOT

> **最終更新**: 2026-03-12 v2.0  
> **対象**: diet-bot v1.2.0  
> **正本宣言**: このドキュメントが LINE BOT 会話設計の唯一正本（SSOT）です。  
> コード変更時はまずこのドキュメントを更新し、コードをドキュメントに合わせること。  
> 旧版 `docs/05_LINE会話フローSSOT.md` を置き換えます。

---

## 0. 設計原則（7項目）

| # | 原則 | 説明 |
|---|------|------|
| P1 | **非ブロッキングフロー** | ユーザーが操作不能になる状態を最小限に。画像確認待ち以外はいつでもモード切替可能 |
| P2 | **決定論的ステートマシン** | 招待コード検証・問診進行・モード切替・確定取消判定は AI 不使用。正規表現・キーワード・DB 状態のみ |
| P3 | **AI 使用箇所の限定** | OpenAI は画像解析（分類+栄養推定）、相談応答、週次レポート要約の 3 用途のみ |
| P4 | **1 ユーザー = 1 アカウント不変** | 最初の招待コード使用でアカウント紐付け確定。以降は変更不可 |
| P5 | **replyToken は 1 回限り** | 同一イベントでの reply は 1 回。追加送信は push を使用 |
| P6 | **問診は常に現在の質問を返す** | 「続けますか？」等の確認を挟まない。質問番号と質問文のみを返す |
| P7 | **画像確認待ち中は他入力ブロック** | 確定/取消以外のテキストには「いま画像確認中です」と返す。モード切替も不可 |

---

## 1. ユーザー SSOT 状態（5 状態）

| 状態 | コード | 判定条件 | 利用可能機能 |
|------|--------|----------|-------------|
| **S0: 未接続** | `no_access` | `invite_code_usages` に記録なし | 招待コード入力のみ |
| **S1: 接続済み・問診未完了** | `intake_pending` | `invite_code_usages` あり + `intake_completed = 0` | 問診回答のみ |
| **S2: 利用中** | `active` | `intake_completed = 1` + `bot_enabled = 1` | 全機能（記録・相談・画像・LIFF） |
| **S3: 画像確認待ち** | `pending_image` | `bot_mode_sessions.current_step = 'pending_image_confirm'` | 確定/取消のみ |
| **S4: 停止中** | `suspended` | `bot_enabled = 0`（admin が停止） | なし（停止メッセージのみ表示） |

### 1.1 状態遷移図

```
  友達追加
     │
     ▼
   ┌────┐  招待コード成功   ┌────┐  問診完了   ┌────┐
   │ S0 │ ──────────────→ │ S1 │ ────────→ │ S2 │
   └────┘                 └────┘           └────┘
     ▲                      ▲               │ ▲
     │                      │ 問診やり直し   │ │
     │                      └───────────────┘ │
     │                                        │
     │                    画像解析完了          │ 確定/取消
     │                    ┌────┐               │
     │                    │ S3 │ ──────────────┘
     │                    └────┘
     │
     │  admin停止    ┌────┐
     └───────────── │ S4 │ ←── admin停止（S0/S1/S2/S3 どこからでも遷移可）
                    └────┘
```

---

## 2. メッセージ処理優先順位（不変ルール）

テキストメッセージ受信時、以下の順序で**上から順に評価**し、最初にマッチした処理を実行して return する。**順序変更禁止**。

| 優先度 | 処理 | 評価条件 | AI | 状態制約 |
|--------|------|----------|:--:|----------|
| **①** | 画像確認待ち応答 | `session.step = 'pending_image_confirm'` | ❌ | S3 のみ |
| **②** | 招待コード | regex `/^[A-Z]{3}-\d{4}$/i` | ❌ | 全状態（最優先認証処理） |
| **③** | サービスアクセス確認 | `checkServiceAccess()` 失敗 → 「招待コード入力を」| ❌ | S0 → ブロック |
| **④** | 問診途中 | `mode = 'intake'` | ❌ | S1 のみ |
| **⑤** | モード切替コマンド | キーワード完全/部分一致 | ❌ | S2 |
| **⑥** | 体重記録 | regex `WEIGHT_PATTERN` | ❌ | S2 (mode=record) |
| **⑦** | 相談テキスト | `mode = 'consult'` or 相談キーワード | ✅ | S2 |
| **⑧** | 通常テキスト（食事記録等） | fallback | ❌ | S2 (mode=record) |

画像メッセージの優先順位:

| 優先度 | 処理 | 条件 | AI |
|--------|------|------|:--:|
| **I-①** | アクセス確認 | access NG → ブロック | ❌ |
| **I-②** | 画像受信→解析→確認 | access OK | ✅ |

---

## 3. 3 レーン設計

### LANE 1: 接続（Connection）— AI 不使用

```
友達追加 → 招待コード入力促進 → コード認証 → アカウント紐付け
```

**DB テーブル**: `line_users`, `user_accounts`, `user_service_statuses`, `invite_codes`, `invite_code_usages`

### LANE 2: 問診（Hearing）— AI 不使用

```
Q1(nickname) → Q2(gender) → Q3(age_range) → Q4(height) → Q5(weight) → Q6(target) → Q7(goal) → Q8(concerns) → Q9(activity) → 完了
```

**DB テーブル**: `user_profiles`, `intake_answers`, `body_metrics`(Q5), `bot_mode_sessions`, `user_service_statuses`(完了フラグ)

### LANE 3: 運用（Operation）

| サブレーン | AI使用 | 説明 |
|-----------|:------:|------|
| record(体重テキスト) | ❌ | 正規表現で検出、即DB書込 |
| record(食事テキスト) | ❌ | キーワード分類、即DB書込 |
| image(食事写真) | ✅ | OpenAI Vision → 確定/取消 → DB書込 |
| image(体重計) | ✅ | OpenAI Vision → 確定/取消 → DB書込 |
| image(進捗写真) | ✅ | OpenAI Vision分類 → 確定/取消 → DB書込 |
| consult | ✅ | OpenAI Chat + RAG + ナレッジ + 個人コンテキスト |
| cron(リマインダー) | ✅ | パーソナライズ文面生成 |
| cron(週次レポート) | ✅ | 集計 → AI要約 |

---

## 4. AI vs 決定論的ロジック境界定義

### 4.1 AI 使用箇所（OpenAI のみ）

| # | 用途 | モデル | temp | 入力 | 出力形式 | ソースファイル |
|---|------|--------|------|------|----------|---------------|
| A1 | 画像カテゴリ分類 | Vision | 0.2 | 画像(base64) | JSON `{category, confidence}` | `jobs/image-analysis.ts` |
| A2 | 食事写真 栄養推定 | Vision | 0.2 | 画像(base64) | JSON `{meal_description, calories_kcal, ...}` | `jobs/image-analysis.ts` |
| A3 | 栄養ラベル読取 | Vision | 0.2 | 画像(base64) | JSON `{product_name, calories_kcal, ...}` | `jobs/image-analysis.ts` |
| A4 | 体重計数値読取 | Vision | 0.2 | 画像(base64) | JSON `{weight_kg, unit}` | `jobs/image-analysis.ts` |
| A5 | 相談応答 | Chat | 0.7 | テキスト + 履歴 + ナレッジ + 個人コンテキスト | テキスト(200字以内) | `process-line-event.ts` |
| A6 | 栄養コメント生成 | Chat | 0.7 | 食事記録 + PFC値 | テキスト | 未実装(Phase 2) |
| A7 | 週次レポート要約 | Chat | 0.7 | 週間集計データ | テキスト | `jobs/weekly-report.ts` |

### 4.2 決定論的ロジック（AI 不使用、必須保証）

| # | 処理 | 判定方法 | 失敗時 |
|---|------|----------|--------|
| D1 | 招待コード検出 | regex `/^[A-Z]{3}-\d{4}$/i` | 非コード→次の優先度へ |
| D2 | 招待コード検証 | DB: `invite_codes` 状態チェック | エラーメッセージ返信 |
| D3 | アカウント紐付け | DB: INSERT/UPDATE `user_accounts` | エラーメッセージ返信 |
| D4 | サービスアクセス判定 | DB: `user_service_statuses` 参照 | 「招待コードを入力してください」 |
| D5 | 問診ステップ進行 | `bot_mode_sessions.current_step` | 現在の質問を再送 |
| D6 | 問診回答バリデーション | 数値範囲/選択肢一致 | スキップ扱い→次の質問 |
| D7 | モード切替コマンド | キーワード完全/部分一致 | 該当なし→次の優先度へ |
| D8 | 体重テキスト検出 | regex `WEIGHT_PATTERN` | 非体重→次の優先度へ |
| D9 | 食事区分判定 | キーワード正規表現 | `other` |
| D10 | 画像確認応答判定 | キーワード一致（確定/取消） | 再確認促す |
| D11 | 登録済み判定 | `invite_code_usages` 存在チェック | 未登録→コード入力促す |
| D12 | 問診完了判定 | `intake_completed` フラグ | 未完了→現在の質問返す |
| D13 | 次の返答決定 | 上記優先順位に従い分岐 | フォールバック返信 |

---

## 5. 接続フロー（LANE 1）詳細

### 5.1 友達追加（follow イベント）

```
[LINE follow event]
  │
  ├─ upsert line_users (displayName, pictureUrl, followStatus='following')
  ├─ ensureUserAccount (デフォルトclientAccountIdに仮紐付け)
  ├─ upsertUserServiceStatus (bot_enabled=1, intake_completed=0)
  ├─ ensureOpenThread
  │
  ├─ 既存 invite_code_usages あり？
  │   ├─ YES + intake_completed → 「おかえりなさい！」(S2)
  │   ├─ YES + !intake_completed → startIntakeFlow('follow') (S1)
  │   └─ NO → 「招待コードを入力してください」(S0)
  │
  └─ END
```

### 5.2 招待コード処理（5 パターン）

| パターン | 条件 | 返信 | DB操作 | 遷移先 |
|---------|------|------|--------|--------|
| **A: 新規成功** | コード有効 + 未使用ユーザー | 「✅ 登録完了」+ Q1 | `invite_code_usages` INSERT, `user_accounts` UPDATE, `user_service_statuses` UPSERT, `bot_mode_sessions` INSERT(intake) | S0→S1 |
| **B: 既登録+問診完了** | `invite_code_usages` あり + `intake_completed=1` | 「ℹ️ 既に登録済み。そのままご利用ください」+ 利用案内 | なし | S2 維持 |
| **C: 既登録+問診未完了** | `invite_code_usages` あり + `intake_completed=0` | 「ℹ️ 登録済み」+ 現在の問診質問（Q1からではなく途中から） | `bot_mode_sessions` UPSERT(intake, 途中step) | S1 維持 |
| **D: コード無効** | DB に存在しない / revoked | 「❌ 無効なコードです」 | なし | 変化なし |
| **E: コード期限切れ/上限** | expired / use_count >= max_uses | 「⏰ 期限切れ」/「⚠️ 上限到達」 | なし | 変化なし |

---

## 6. 問診フロー（LANE 2）詳細 — 9 問ステートマシン

### 6.1 ルール

- **常に現在の質問を返す**（「続けますか？」は挟まない）
- 回答を保存したら即座に次の質問を送信
- 「スキップ」で null 保存→次の質問
- Q8(concerns) のみ複数選択→「次へ」で進行
- Q5(current_weight) は `body_metrics` にも保存

### 6.2 状態遷移テーブル

| Step | 質問 | 入力形式 | バリデーション | DB書込 | 次Step |
|------|------|---------|---------------|--------|--------|
| `intake_nickname` | Q1: ニックネーム | テキスト | len ≤ 20 | `user_profiles.nickname`, `intake_answers` | `intake_gender` |
| `intake_gender` | Q2: 性別 | QR: 男性/女性/答えない | 「男」→male,「女」→female,他→other | `user_profiles.gender`, `intake_answers` | `intake_age_range` |
| `intake_age_range` | Q3: 年代 | QR: 20s/30s/40s/50s/60s+ | 選択肢一致 | `user_profiles.age_range`, `intake_answers` | `intake_height` |
| `intake_height` | Q4: 身長(cm) | テキスト | 100 < x < 250 | `user_profiles.height_cm`, `intake_answers` | `intake_current_weight` |
| `intake_current_weight` | Q5: 現在体重(kg) | テキスト | 20 < x < 300 | `user_profiles.current_weight_kg`, `intake_answers`, `body_metrics`, `daily_logs` | `intake_target_weight` |
| `intake_target_weight` | Q6: 目標体重(kg) | テキスト | 20 < x < 300 | `user_profiles.target_weight_kg`, `intake_answers` | `intake_goal` |
| `intake_goal` | Q7: 目標・理由 | テキスト | len ≤ 200 | `user_profiles.goal_summary`, `intake_answers` | `intake_concerns` |
| `intake_concerns` | Q8: 気になること | QR(複数)+「次へ」 | タップ→tags[]追加 | `user_profiles.concern_tags`(JSON), `intake_answers` | `intake_activity` (on「次へ」) |
| `intake_activity` | Q9: 活動レベル | QR: sedentary/light/moderate/active | 選択肢一致 | `user_profiles.activity_level`, `intake_answers` | `intake_done` |
| `intake_done` | — | — | — | `user_service_statuses.intake_completed=1`, `bot_mode_sessions` → record mode | (S2 遷移) |

### 6.3 中断・再開パターン

| ケース | 挙動 |
|--------|------|
| セッション TTL 切れ(24h) + 次回テキスト | `intake_answers` から最終回答を検索 → 次のステップから質問送信 |
| 「問診再開」コマンド | 現セッション step の質問を送信 |
| 「問診やり直し」コマンド | `intake_completed=0` → Q1 から再開 |
| 再フォロー（ブロック解除） | `invite_code_usages` チェック → 登録済みなら intake or 利用案内 |

---

## 7. 記録フロー（LANE 3 record）

### 7.1 体重記録

```
ユーザー: "58.5kg"
  │
  ├─ regex WEIGHT_PATTERN → weightKg = 58.5
  ├─ ensureDailyLog
  ├─ upsertWeight (daily_logs, body_metrics)
  ├─ createConversationMessage (bot reply)
  │
  └─ reply: "体重 58.5kg を記録しました ✅"
```

### 7.2 食事テキスト記録

```
ユーザー: "朝食 トースト コーヒー"
  │
  ├─ classifyMealType → 'breakfast'
  ├─ ensureDailyLog
  ├─ createMealEntry or UPDATE existing
  ├─ createConversationMessage
  │
  └─ reply: "食事を記録しました ✅（朝食）"
```

### 7.3 食事画像フロー

```
ユーザー: [画像送信]
  │
  ├─ reply: "📷 画像を受け取りました！解析中です..."  (replyToken 消費)
  │
  ├─ [バックグラウンド]
  │   ├─ getMessageContent → R2.put
  │   ├─ OpenAI Vision: 分類 (A1)
  │   ├─ OpenAI Vision: 栄養推定 (A2/A3/A4)
  │   ├─ saveImageIntakeResult (applied_flag=0)
  │   ├─ upsertModeSession (pending_image_confirm) → S3
  │   └─ push: "🍽 解析結果... この内容で記録しますか？" + [確定/取消]
  │
  ├─ ユーザー: "確定"
  │   ├─ applyProposedAction → meal_entries / body_metrics / progress_photos
  │   ├─ markIntakeResultApplied (applied_flag=1)
  │   ├─ deleteModeSession → S2
  │   └─ reply: "✅ 記録を保存しました！"
  │
  ├─ ユーザー: "取消"
  │   ├─ markIntakeResultDiscarded (applied_flag=2)
  │   ├─ deleteModeSession → S2
  │   └─ reply: "🗑 取り消しました"
  │
  └─ ユーザー: (その他テキスト) ← P7: ブロック
      └─ reply: "🔄 いま画像の確認中です。「確定」または「取消」で応答してください。"
```

### 7.4 進捗写真フロー

```
[画像分類 → progress_body_photo]
  │
  ├─ push: "📸 体型写真を受け取りました！保存しますか？" + [確定/取消]
  ├─ 確定 → createProgressPhoto → "✅ 体型写真を保存しました！"
  └─ 取消 → discard → "🗑 取り消しました"
```

---

## 8. 画像確認待ち状態（S3）— ブロッキングルール

### 8.1 受付する入力

| 入力 | 処理 |
|------|------|
| 「確定」「はい」「yes」「ok」「OK」「記録」「保存」 | `handleImageConfirm` → S2 |
| 「取消」「キャンセル」「cancel」「いいえ」「no」「やめる」「削除」 | `handleImageDiscard` → S2 |

### 8.2 ブロックする入力（S3 中は全てブロック）

| 入力 | 返信 |
|------|------|
| 招待コード (ABC-1234) | 「🔄 いま画像の確認中です。「確定」または「取消」で応答してください。」 |
| モード切替コマンド | 同上 |
| 体重テキスト | 同上 |
| 食事テキスト | 同上 |
| 問診コマンド | 同上 |
| その他テキスト | 同上 |
| 画像送信 | 「🔄 いま画像の確認中です。確認が完了してから新しい画像を送ってください。」 |

### 8.3 タイムアウト

- 24 時間後に Cron ジョブで `applied_flag=3`(expired)、`bot_mode_sessions` 削除 → S2 復帰

---

## 9. 相談フロー（LANE 3 consult）

### 9.1 相談モード切替

**トリガーキーワード**（部分一致）:
- 明示的: 「相談モード」「相談にして」「相談する」→ 即座にモード切替
- 暗黙的: 「相談」「質問」「アドバイス」「教えて」「どうすれば」「悩み」「ヘルプ」→ record モード中でも consult に自動切替

### 9.2 相談プロンプト構成

```
[system_prompt]
├─ base_prompt: DB (bot_versions.system_prompt) or ハードコード
│   "あなたはダイエット専門のAIアシスタントです。
│    - 医療診断は行わず、専門医への相談を促す
│    - 日本語で、丁寧かつ親しみやすい口調
│    - 回答は200文字以内で簡潔に"
│
├─ personal_context: (ユーザー個人情報注入)
│   "【ユーザー情報】
│    ニックネーム: ○○, 性別: 女性, 年代: 30s
│    身長: 160cm, 現在体重: 65kg, 目標: 55kg
│    最近7日の体重推移: [65.2, 64.8, ...]
│    今日の食事: 朝食(トースト, 280kcal), ..."
│
└─ knowledge_context: (ナレッジ検索結果 top 3)
    "【参考ナレッジ】
     [糖質制限の基本] ..."
```

### 9.3 入出力

| 入力 | 処理 | 出力 |
|------|------|------|
| テキスト | OpenAI Chat (A5) + 直近10ターン履歴 | テキスト返信(200字以内) + QR[記録に戻る/続けて相談] |

---

## 10. 入力分岐テーブ（完全版 SSOT）

### 10.1 テキストメッセージ

| # | 入力パターン | 検出方法 | 前提状態 | 実行関数 | DB UPDATE | BOT 返信 | 次状態 |
|---|-------------|----------|---------|---------|-----------|---------|--------|
| T01 | 確定/はい/yes/ok/記録/保存 | keyword includes | S3 | `handleImageConfirm` | `image_intake_results(applied=1)`, `meal_entries`/`body_metrics`/`progress_photos`, `bot_mode_sessions` DELETE | 「✅ 記録を保存しました！」 | S2 |
| T02 | 取消/キャンセル/cancel/いいえ/no/やめる/削除 | keyword includes | S3 | `handleImageDiscard` | `image_intake_results(applied=2)`, `bot_mode_sessions` DELETE | 「🗑 取り消しました」 | S2 |
| T03 | (S3 中のその他テキスト) | fallback | S3 | — | なし | 「🔄 いま画像の確認中です。確定 or 取消で応答してください」 | S3 |
| T04 | `ABC-1234` (招待コード) | regex `/^[A-Z]{3}-\d{4}$/i` | S0 | `handleInviteCode` (Pattern A) | `invite_code_usages`, `user_accounts`, `user_service_statuses`, `bot_mode_sessions` | 「✅ 登録完了」+ Q1 | S1 |
| T05 | `ABC-1234` (招待コード) | regex | S1(問診未完了) | `handleInviteCode` (Pattern C) | `bot_mode_sessions` UPSERT(intake, 途中step) | 「ℹ️ 登録済み」+ 現在の質問 | S1 |
| T06 | `ABC-1234` (招待コード) | regex | S2(問診完了) | `handleInviteCode` (Pattern B) | なし | 「ℹ️ 登録済み。そのままご利用ください」 | S2 |
| T07 | `ABC-1234` (無効コード) | regex | any | `handleInviteCode` (Pattern D/E) | なし | 「❌ 無効」/「⏰ 期限切れ」/「⚠️ 上限」 | 変化なし |
| T08 | (access NG のテキスト) | `checkServiceAccess` fail | S0 | — | なし | 「📋 招待コードを入力してください」 | S0 |
| T09 | (問診中の回答) | `mode = 'intake'` | S1 | `handleIntakeStep` | `user_profiles`, `intake_answers`, `bot_mode_sessions`, (`body_metrics` for Q5) | 次の質問 | S1 (or S2 on Q9完了) |
| T10 | 問診/ヒアリング/登録/初期設定 | exact match + regex | S2 | `startIntakeFlow` | `bot_mode_sessions` | 完了済み案内 or 途中再開 | — |
| T11 | 問診やり直し | exact match | S2 | `beginIntakeFromStart` | `user_service_statuses(intake_completed=0)`, `bot_mode_sessions` | Q1 | S1 |
| T12 | 問診再開 | exact match | S1/S2 | `resumeIntakeFlow` | — | 途中の質問 | S1 |
| T13 | 相談モード/相談にして/相談する | keyword includes | S2 | `updateThreadMode('consult')`, `upsertModeSession` | `conversation_threads`, `bot_mode_sessions` | 「💬 相談モードに切替」 | S2(consult) |
| T14 | 相談/質問/アドバイス/教えて/どうすれば/悩み/ヘルプ | keyword includes | S2(record) | auto-switch to consult | `conversation_threads`, `bot_mode_sessions` | 相談開始 + AI応答 | S2(consult) |
| T15 | 記録モード/記録にして/記録する/戻る | keyword includes | S2 | `deleteModeSession` | `conversation_threads`, `bot_mode_sessions` | 「📝 記録モードに切替」 | S2(record) |
| T16 | `XX.Xkg` (体重) | regex `WEIGHT_PATTERN` | S2(record) | `handleRecordText` | `daily_logs`, `body_metrics`, `conversation_messages` | 「体重 XX.Xkg を記録しました ✅」 | S2 |
| T17 | 食事テキスト (朝食/昼食等 or 8文字以上) | `classifyMealType` + len | S2(record) | `handleRecordText` | `daily_logs`, `meal_entries`, `conversation_messages` | 「食事を記録しました ✅」 | S2 |
| T18 | (相談テキスト) | fallback | S2(consult) | `handleConsultText` (A5) | `conversation_messages` | AI 応答 | S2(consult) |
| T19 | (判定不能テキスト) | fallback | S2(record) | `handleRecordText` | `conversation_messages` | 「体重・食事を入力してください」 | S2 |

### 10.2 画像メッセージ

| # | 入力 | 前提状態 | 実行関数 | AI | DB UPDATE | BOT 返信 | 次状態 |
|---|------|---------|---------|:--:|-----------|---------|--------|
| I01 | 画像 | S3(画像確認待ち) | — | ❌ | なし | 「🔄 確認中です。先に確定/取消してください」 | S3 |
| I02 | 画像 | S0(access NG) | — | ❌ | なし | 「📋 招待コードを入力してください」 | S0 |
| I03 | 画像 | S2(access OK) | `handleImageMessageEvent` | ✅ | `conversation_messages`, `message_attachments`, `image_analysis_jobs`, R2, `image_intake_results`, `bot_mode_sessions` | reply「解析中…」+ push「結果+確定/取消」 | S3 |

### 10.3 イベント

| # | イベント | 処理 | DB UPDATE | BOT 返信 | 次状態 |
|---|---------|------|-----------|---------|--------|
| E01 | follow(初回) | `handleFollowEvent` | `line_users`, `user_accounts`, `user_service_statuses`, `conversation_threads` | 「友達追加ありがとう+招待コード入力を」 | S0 |
| E02 | follow(再フォロー/コード使用済み/問診完了) | `handleFollowEvent` | — | 「おかえりなさい！」 | S2 |
| E03 | follow(再フォロー/コード使用済み/問診未完了) | `handleFollowEvent` → `startIntakeFlow('follow')` | `bot_mode_sessions` | 現在の問診質問 | S1 |
| E04 | unfollow | `handleUnfollowEvent` | `line_users(follow_status='blocked')` | なし | — |

---

## 11. キーワード・正規表現一覧（実装値）

### 11.1 正規表現

| 名前 | パターン | 用途 |
|------|---------|------|
| `INVITE_CODE_PATTERN` | `/^([A-Z]{3}-\d{4})$/i` | 招待コード検出（テキスト全体一致） |
| `WEIGHT_PATTERN` | `/(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg\|ｋｇ\|キロ\|Kg\|KG)/i` | 体重テキスト検出 |

### 11.2 キーワードリスト

| 変数名 | 値 | マッチ方式 | 用途 |
|--------|---|-----------|------|
| `SWITCH_TO_CONSULT` | 相談モード, 相談にして, 相談する | `includes`(部分一致) | 明示的 consult 切替 |
| `CONSULT_KEYWORDS` | 相談, 質問, アドバイス, 教えて, どうすれば, 悩み, ヘルプ | `includes`(部分一致) | 暗黙的 consult 切替 |
| `SWITCH_TO_RECORD` | 記録モード, 記録にして, 記録する, 戻る | `includes`(部分一致) | record 切替 |
| `RECORD_KEYWORDS` | 記録, ログ, メモ | (将来用) | — |
| 画像確定 | 確定, はい, yes, ok, OK, 記録, 保存 | `includes`(部分一致) | S3 確定 |
| 画像取消 | 取消, キャンセル, cancel, いいえ, no, やめる, 削除 | `includes`(部分一致) | S3 取消 |
| 問診スキップ | スキップ, skip, 省略, とばす, 飛ばす | `toLowerCase().includes` | 問診項目スキップ |
| concerns 次へ | 次へ, next, 完了, done, スキップ | `includes` | Q8 → Q9 進行 |

### 11.3 食事区分判定

| 区分 | キーワード | 正規表現 |
|------|-----------|----------|
| `breakfast` | 朝, 朝食, 朝ご飯, breakfast | `/朝\|朝食\|朝ご飯\|breakfast/i` |
| `lunch` | 昼, 昼食, 昼ご飯, ランチ, lunch | `/昼\|昼食\|昼ご飯\|ランチ\|lunch/i` |
| `dinner` | 夜, 夕, 夕食, 夕ご飯, ディナー, dinner | `/夜\|夕\|夕食\|夕ご飯\|ディナー\|dinner/i` |
| `snack` | 間食, おやつ, snack | `/間食\|おやつ\|snack/i` |
| `other` | 上記以外 (8文字以上) | — |

---

## 12. 管理者・スーパーアドミン画面スコープ

### 12.1 ロール別表示スコープ

| 機能 | ユーザー(LINE) | admin | superadmin |
|------|:-------------:|:-----:|:----------:|
| 体重記録・食事写真送信 | ✅ | — | — |
| AI 相談 | ✅ | — | — |
| LIFF ダッシュボード | ✅ | — | — |
| 招待コード発行 | — | ✅(自分の顧客) | ✅(全体) |
| ユーザー一覧 | — | ✅(自分の顧客) | ✅(全体) |
| ユーザーサービス停止 | — | ✅(自分の顧客) | ✅(全体) |
| admin 追加・無効化 | — | — | ✅ |
| BOT 設定・ナレッジ管理 | — | — | ✅ |
| システム監視 | — | — | ✅ |

---

## 13. Cron ジョブ一覧

| ジョブ | スケジュール | 処理 | AI |
|--------|-------------|------|:--:|
| daily-reminder | JST 21:00 (UTC 12:00) | 未記録ユーザーに Push | ✅ |
| weekly-report | 日曜 JST 20:00 (UTC 11:00) | 週次集計 → AI 要約 → Push + DB | ✅ |
| cleanup | 毎時 0 分 | ① pending 画像 24h 破棄 ② 期限切れセッション削除 ③ 期限切れ招待コード失効 | ❌ |

---

## 14. 実装タスク優先順位

### Phase 1（即時 — 今回実装）

| # | タスク | ファイル | 内容 |
|---|--------|---------|------|
| **T1** | メッセージ優先順位修正 | `process-line-event.ts` | S3(画像確認待ち)を最優先に。招待コードより前に評価。S3中は全入力ブロック |
| **T2** | 問診フロー簡素化 | `intake-flow.ts` | `startIntakeFlow` から「続けますか？」プロンプト除去。常に現在の質問を返す |
| **T3** | 招待コード再送応答統一 | `process-line-event.ts` | Pattern C: 問診未完了時は「途中の質問」を返す（Q1 固定ではなく） |
| **T4** | 画像確認中ブロック強化 | `process-line-event.ts` | S3 中は招待コード・モード切替・体重・食事テキスト全てブロック |
| **T5** | CONSULT_KEYWORDS 統合 | `process-line-event.ts` | 「相談」「教えて」等で自動的に consult モードに切替 |

### Phase 2（次回）

| # | タスク |
|---|--------|
| T6 | 画像解析結果 → food_master マッチング統合 |
| T7 | 相談プロンプトへのユーザーコンテキスト注入強化 |
| T8 | Rich Menu 設定 |
| T9 | RAG 実装 |
| T10 | 管理画面プロンプトエディタ |

---

## 15. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-12 | v1.0 | 初版 `docs/05_LINE会話フローSSOT.md` |
| 2026-03-12 | v2.0 | 本ドキュメント。非ブロッキング設計、5状態SSOT、完全入力分岐テーブル、画像確認ブロック強化、問診簡素化 |
