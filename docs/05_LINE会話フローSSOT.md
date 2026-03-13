# LINE 会話フロー SSOT（Single Source of Truth）

> **最終更新**: 2026-03-13  
> **対象**: diet-bot v1.2.0  
> **ソースファイル**: `src/services/line/process-line-event.ts`, `src/services/line/intake-flow.ts`, `src/services/line/image-confirm-handler.ts`, `src/jobs/image-analysis.ts`  
> **本ドキュメントが会話設計の正本**。コード変更時は必ずここを先に更新する。

---

## 0. 設計原則

| # | 原則 | 説明 |
|---|------|------|
| P1 | **3レーン分離** | 接続(Connection) / 問診(Hearing) / 運用(Operation) を独立レーンで管理 |
| P2 | **決定論的ステートマシン** | 招待コード検証・問診進行・モード切替は**AI不使用**。正規表現・キーワード・DB状態のみで分岐 |
| P3 | **AI使用箇所の限定** | OpenAIは画像分類・栄養推定・**会話解釈（v2.0）**・相談応答・週次レポート要約・**メモリ抽出（v2.0）** |
| P4 | **1ユーザー=1アカウント不変** | 最初の招待コード使用でアカウント紐付け確定。以降変更不可 |
| P5 | **replyToken は1回限り** | 同一イベントでの reply は1回。追加送信は push を使用 |
| P6 | **問診は常に現在の質問を返す** | 「続けますか？」等の確認プロンプトを挟まない（招待コード再送時を除く） |
| P7 | **pending_image_confirm 中は他入力をブロック** | 確定/取消以外のテキストには再確認を促す |

---

## 1. 3レーン設計

### 1.1 レーン全体図

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANE 1: 接続 (Connection)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  友達追加 → 招待コード入力 → アカウント紐付け
  ※認証完了まで他機能は利用不可
  ※決定論的ロジックのみ（AI不使用）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANE 2: 問診 (Hearing / Intake)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  9問の問診 → user_profiles + intake_answers 保存
  ※決定論的ステートマシン（AI不使用）
  ※完了まで record/consult に遷移しない

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANE 3: 運用 (Operation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  record: 体重/食事テキスト記録
          v1.x: 決定論的（キーワード＋正規表現）
          v2.0: Phase A（AI解釈）→ Phase B（明確化）→ Phase C（保存）
          → 詳細は 11_会話解釈SSOT.md / 12_記録確認フローSSOT.md
  consult: AI相談（OpenAI使用）
           v2.0: 相談中の記録自動検出（intent_secondary）
  image:  画像送信→AI解析→確認（OpenAI使用）
  cron:   リマインダー/週次レポート（OpenAI使用:レポート要約のみ）
          v2.0: メモリ推定バッチ追加
```

### 1.2 レーン間の遷移条件

| 遷移元 | 遷移先 | 条件 | トリガー |
|--------|--------|------|----------|
| (未認証) | LANE 1 | 友達追加 or テキスト送信 | follow イベント / 招待コードパターン検出 |
| LANE 1 | LANE 2 | 招待コード認証成功 | `useInviteCode` → success |
| LANE 2 | LANE 3 | 問診9問完了 | `intake_completed=1` + `mode=record` |
| LANE 3 record | LANE 3 consult | 明示的コマンド | 「相談モード」「相談する」等 |
| LANE 3 consult | LANE 3 record | 明示的コマンド | 「記録モード」「記録する」「戻る」等 |
| LANE 3 record | LANE 3 pending_image_confirm | 画像解析完了 | `processImageDirectly` → push通知 |
| LANE 3 pending_image_confirm | LANE 3 record | 確定/取消/タイムアウト | ユーザー応答 or 24hクリーンアップ |
| LANE 3 | LANE 2 | 明示的コマンド | 「問診やり直し」 |

---

## 2. 状態遷移図（State Machine）

### 2.1 グローバル状態

```
┌──────────────────────────────────────────────────────────┐
│                   LINE EVENT RECEIVED                     │
│                                                           │
│  event.type = follow?  ──YES──→ handleFollowEvent         │
│       │                                                   │
│       NO                                                  │
│       │                                                   │
│  event.type = unfollow? ──YES──→ handleUnfollowEvent      │
│       │                                                   │
│       NO                                                  │
│       │                                                   │
│  event.type = message?                                    │
│       ├── message.type = text?  ──→ handleTextMessageEvent │
│       ├── message.type = image? ──→ handleImageMessageEvent│
│       └── other ──→ ignore                                │
└──────────────────────────────────────────────────────────┘
```

### 2.2 テキストメッセージの処理優先順位

```
handleTextMessageEvent(text)
  │
  │ ① 招待コード検出 /^[A-Z]{3}-\d{4}$/i
  │   └── YES → handleInviteCode() → RETURN
  │
  │ ② checkServiceAccess()
  │   └── access=null or botEnabled=false
  │       → 「招待コードを入力してください」→ RETURN
  │
  │ ③ ensureUserAccount + ensureOpenThread + メッセージ保存
  │
  │ ④ コマンド判定（exact match / regex）
  │   ├── 「問診」「ヒアリング」「登録」「初期設定」
  │   │     → startIntakeFlow() → RETURN
  │   ├── 「問診やり直し」
  │   │     → intake_completed=0 + beginIntakeFromStart() → RETURN
  │   ├── 「問診再開」
  │   │     → resumeIntakeFlow() → RETURN
  │   ├── 「相談モード」「相談にして」「相談する」
  │   │     → mode='consult' → RETURN
  │   └── 「記録モード」「記録にして」「記録する」「戻る」
  │         → mode='record' → RETURN
  │
  │ ⑤ セッション状態による分岐
  │   ├── session.step = 'pending_image_confirm'
  │   │     ├── 「確定」→ handleImageConfirm → RETURN
  │   │     ├── 「取消」→ handleImageDiscard → RETURN
  │   │     └── other → handleImageCorrection (AI再解析) → RETURN
  │   │
  │   ├── mode = 'intake'
  │   │     → handleIntakeStep() → RETURN (if handled)
  │   │
  │   ├── mode = 'consult'
  │   │     → handleConsultText() (OpenAI) → RETURN
  │   │
  │   └── mode = 'record' (default)
  │         → handleRecordText()
  │           ├── 体重パターン検出 → upsertWeight
  │           ├── 食事テキスト検出 → createMealEntry
  │           └── 判定不能 → 「体重・食事を入力してください」
```

### 2.3 問診ステートマシン（LANE 2）

```
 ┌────────────────┐
 │ intake_nickname │ Q1: ニックネーム (text)
 └───────┬────────┘
         │ 回答 or スキップ
         ▼
 ┌────────────────┐
 │ intake_gender   │ Q2: 性別 (quickReply: 男性/女性/答えない)
 └───────┬────────┘
         │
         ▼
 ┌──────────────────┐
 │ intake_age_range  │ Q3: 年代 (quickReply: 20s/30s/40s/50s/60s+)
 └───────┬──────────┘
         │
         ▼
 ┌────────────────┐
 │ intake_height   │ Q4: 身長cm (text, 100-250)
 └───────┬────────┘
         │
         ▼
 ┌──────────────────────┐
 │ intake_current_weight │ Q5: 現在体重kg (text, 20-300)
 └───────┬──────────────┘
         │ ※body_metricsにも保存
         ▼
 ┌──────────────────────┐
 │ intake_target_weight  │ Q6: 目標体重kg (text, 20-300)
 └───────┬──────────────┘
         │
         ▼
 ┌────────────────┐
 │ intake_goal     │ Q7: 目標・理由 (text, max200)
 └───────┬────────┘
         │
         ▼
 ┌──────────────────┐
 │ intake_concerns   │ Q8: 気になること (複数タップ→「次へ」)
 └───────┬──────────┘  ※タップごとに tags[] に追記、「次へ」で進行
         │
         ▼
 ┌──────────────────┐
 │ intake_activity   │ Q9: 活動レベル (quickReply: sedentary/light/moderate/active)
 └───────┬──────────┘
         │
         ▼
 ┌────────────────┐
 │ intake_done     │ intake_completed=1, mode → record
 └────────────────┘
```

**問診の中断・再開パターン:**

| 状況 | 動作 |
|------|------|
| セッションTTL切れ(24h) | 次回テキスト時、intake_answersから最終回答を復元 → 次の質問から再開 |
| 「問診再開」コマンド | 現在のセッションstepから質問を再送 |
| 「問診やり直し」コマンド | intake_completed=0, Q1から開始 |
| 再フォロー(ブロック解除) | findInviteCodeUsage → 登録済みならstartIntakeFlow('follow') |

### 2.4 画像処理ステートマシン

```
 ┌─────────────────────────┐
 │ 画像メッセージ受信        │
 └───────────┬─────────────┘
             │
             ▼
 ┌─────────────────────────┐
 │ handleImageMessageEvent  │
 │ ├─ checkServiceAccess    │
 │ ├─ replyText「解析中…」  │  ← replyToken消費（即時返信）
 │ ├─ getMessageContent     │
 │ ├─ R2.put                │
 │ ├─ createMessageAttachment│
 │ └─ processImageDirectly  │  ← waitUntilでバックグラウンド実行
 └───────────┬─────────────┘
             │
             ▼ (バックグラウンド)
 ┌─────────────────────────┐
 │ processImageAnalysis     │
 │ ├─ R2.get → base64変換   │
 │ ├─ OpenAI Vision: 分類   │  ★ AI使用箇所①
 │ ├─ カテゴリ別詳細解析     │  ★ AI使用箇所②
 │ ├─ saveImageIntakeResult │
 │ │   (applied_flag=0)     │
 │ ├─ upsertModeSession     │
 │ │   (pending_image_confirm)│
 │ └─ pushWithQuickReplies  │  ← push（確定/取消）
 └───────────┬─────────────┘
             │
             ▼
 ┌─────────────────────────┐
 │ pending_image_confirm    │  ← ここで次のテキスト入力を待つ
 │                          │
 │ 「確定」→ handleImageConfirm │
 │   ├─ applyProposedAction │
 │   │   ├─ meal_entries    │
 │   │   ├─ body_metrics    │
 │   │   └─ progress_photos │
 │   ├─ applied_flag=1      │
 │   └─ deleteModeSession   │
 │                          │
 │ 「取消」→ handleImageDiscard │
 │   ├─ applied_flag=2      │
 │   └─ deleteModeSession   │
 │                          │
 │ 24h経過 → Cron expire    │
 │   └─ applied_flag=3      │
 │                          │
 │ その他テキスト → 再確認促す │  ← P7: ブロック
 └─────────────────────────┘
```

---

## 3. OpenAI使用箇所 vs 決定論的ロジック — 境界定義

### 3.1 全処理の分類マトリクス

| # | 処理 | ロジック種別 | AI使用 | ソースファイル | 判定根拠 |
|---|------|-------------|--------|---------------|----------|
| 1 | 招待コード検出 | **決定論的** | ❌ | process-line-event.ts L58 | 正規表現 `/^[A-Z]{3}-\d{4}$/i` |
| 2 | 招待コード検証 | **決定論的** | ❌ | invite-codes-repo.ts | DB状態チェック (active/expired/exhausted) |
| 3 | アカウント紐付け | **決定論的** | ❌ | invite-codes-repo.ts + process-line-event.ts | DB INSERT/UPDATE |
| 4 | サービスアクセス判定 | **決定論的** | ❌ | subscriptions-repo.ts | `user_service_statuses` 参照 |
| 5 | 問診フロー進行 | **決定論的** | ❌ | intake-flow.ts | `bot_mode_sessions.current_step` によるステートマシン |
| 6 | 問診回答バリデーション | **決定論的** | ❌ | intake-flow.ts | 数値範囲チェック、選択肢一致 |
| 7 | モード切替コマンド | **決定論的** | ❌ | process-line-event.ts L350-399 | キーワード完全一致 |
| 8 | 体重テキスト検出 | **決定論的** | ❌ | process-line-event.ts L60 | 正規表現 `WEIGHT_PATTERN` |
| 9 | 食事区分判定 | **決定論的** | ❌ | process-line-event.ts L63-69 | キーワード正規表現 |
| 10 | 画像確認応答判定 | **決定論的** | ❌ | process-line-event.ts L408-439 | キーワード一致（確定/取消） |
| 11 | **画像カテゴリ分類** | **AI** | ✅ | jobs/image-analysis.ts | OpenAI Vision `CLASSIFY_PROMPT` |
| 12 | **食事写真 栄養推定** | **AI** | ✅ | jobs/image-analysis.ts | OpenAI Vision `MEAL_ANALYSIS_PROMPT` |
| 13 | **栄養ラベル読取** | **AI** | ✅ | jobs/image-analysis.ts | OpenAI Vision `NUTRITION_LABEL_PROMPT` |
| 14 | **体重計数値読取** | **AI** | ✅ | jobs/image-analysis.ts | OpenAI Vision `SCALE_PROMPT` |
| 15 | **画像解析テキスト修正** | **AI** | ✅ | image-confirm-handler.ts | OpenAI Chat `CORRECTION_PROMPT` + food_master再照合 |
| 16 | **AI相談応答** | **AI** | ✅ | process-line-event.ts L560-660 | OpenAI Chat + RAG + ナレッジ |
| 17 | **週次レポート要約** | **AI** | ✅ | jobs/weekly-report.ts (予定) | OpenAI Chat |
| 18 | **リマインダー文面** | **AI** | ✅ | jobs/daily-reminder.ts (予定) | OpenAI Chat (パーソナライズ) |
| 19 | **会話解釈（v2.0）** | **AI** | ✅ | services/ai/interpret.ts (予定) | OpenAI Chat `INTERPRETATION_PROMPT` temp=0.2, json_object → `11_会話解釈SSOT.md` §3 |
| 20 | **メモリ抽出（v2.0）** | **AI** | ✅ | services/ai/memory-extractor.ts (予定) | OpenAI Chat `MEMORY_EXTRACTION_PROMPT` temp=0.3, json_object → `13_パーソナルメモリSSOT.md` §2 |

### 3.2 境界ルール

```
┌─────────────────────────────────────────────────┐
│              決定論的ゾーン（AI不使用）            │
│                                                   │
│  招待コード検証 → アカウント紐付け                  │
│  問診ステートマシン（Q1〜Q9の進行・保存）           │
│  モード切替コマンド判定                             │
│  体重テキスト検出・食事区分判定                      │
│  画像確認（確定/取消）の応答判定                     │
│  サービスアクセス制御                               │
│                                                   │
│  ※これらは正規表現・キーワードマッチ・DB状態のみ    │
│  ※AIのレスポンスに依存してはならない               │
│  ※オフラインでも動作する設計                       │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              AI使用ゾーン（OpenAI）                │
│                                                   │
│  画像分類（7カテゴリ）    temp=0.2, json_object   │
│  食事写真解析（PFC推定）  temp=0.2, json_object   │
│  栄養ラベル読取           temp=0.2, json_object   │
│  体重計数値読取           temp=0.2, json_object   │
│  テキスト修正再解析       temp=0.3, json_object   │
│  AI相談（RAG+履歴）      temp=0.7, text          │
│  週次レポート要約         temp=0.7, text          │
│                                                   │
│  ※AI失敗時は必ずフォールバック（エラーメッセージ） │
│  ※AIの出力はJSON parse + バリデーション必須       │
│  ※AI応答はメインテーブルに直接書かない            │
│    （pending → ユーザー確認 → 反映 の3ステップ）  │
└─────────────────────────────────────────────────┘
```

---

## 4. 入力分岐テーブル（Input Branching Table）

### 4.1 テキストメッセージ入力分岐

| # | 入力パターン | 検出方法 | 前提条件 | 処理 | DB書込 | BOT返信 |
|---|-------------|----------|----------|------|--------|---------|
| T1 | `ABC-1234` (招待コード) | regex `/^[A-Z]{3}-\d{4}$/i` | なし（最優先） | handleInviteCode | invite_code_usages, user_accounts, user_service_statuses, bot_mode_sessions | 登録完了+問診Q1 or エラー |
| T2 | 「問診」「ヒアリング」「登録」「初期設定」 | 完全一致 / regex | access ✅ | startIntakeFlow | bot_mode_sessions | 問診開始 or 途中確認 or 完了済み |
| T3 | 「問診やり直し」 | 完全一致 | access ✅ | beginIntakeFromStart | user_service_statuses (reset), bot_mode_sessions | Q1から再開 |
| T4 | 「問診再開」 | 完全一致 | access ✅ | resumeIntakeFlow | なし | 途中のQから再開 |
| T5 | 「相談モード」「相談にして」「相談する」 | 部分一致 | access ✅ | updateThreadMode('consult') | conversation_threads, bot_mode_sessions | 「相談モードに切替」 |
| T6 | 「記録モード」「記録にして」「記録する」「戻る」 | 部分一致 | access ✅ | deleteModeSession | conversation_threads, bot_mode_sessions | 「記録モードに切替」 |
| T7 | 「確定」「はい」「yes」「ok」「記録」「保存」 | 部分一致 | step=pending_image_confirm | handleImageConfirm | daily_logs, meal_entries/body_metrics/progress_photos, image_intake_results | 「保存しました」 |
| T8 | 「取消」「キャンセル」「cancel」「いいえ」「no」「やめる」「削除」 | 部分一致 | step=pending_image_confirm | handleImageDiscard | image_intake_results (applied_flag=2) | 「取り消しました」 |
| T9 | (上記以外のテキスト) | — | step=pending_image_confirm | handleImageCorrection | image_intake_results (proposed_action_json更新) | AI再解析→修正後の内容を提示+確定/取消 |
| T10 | (問診中の回答テキスト) | — | mode=intake | handleIntakeStep | user_profiles, intake_answers, bot_mode_sessions, (body_metrics for Q5) | 次の質問 |
| T11 | `XX.Xkg` (体重パターン) | regex `WEIGHT_PATTERN` | mode=record | handleRecordText | daily_logs, body_metrics, conversation_messages | 「体重○○kg記録しました」 |
| T12 | 食事テキスト (朝食/昼食等 or 8文字以上) | classifyMealType + 文字数 | mode=record | handleRecordText | daily_logs, meal_entries, conversation_messages | 「食事を記録しました」 |
| T13 | (相談テキスト) | — | mode=consult | handleConsultText | conversation_messages | AI応答 |
| T14 | (判定不能テキスト) | — | mode=record | handleRecordText (fallback) | conversation_messages | 「体重・食事を入力してください」 |

### 4.2 画像メッセージ入力分岐

| # | 入力 | 前提条件 | 処理 | AI使用 | DB書込 | BOT返信 |
|---|------|----------|------|--------|--------|---------|
| I1 | 画像 | access ❌ | — | ❌ | なし | 「招待コードを入力してください」 |
| I2 | 画像 | access ✅ | handleImageMessageEvent | ✅ | conversation_messages, message_attachments, image_analysis_jobs, R2, image_intake_results, bot_mode_sessions | reply「解析中…」+ push「解析結果+確定/取消」 |

### 4.3 イベント入力分岐

| # | イベント | 処理 | DB書込 | BOT返信 |
|---|---------|------|--------|---------|
| E1 | follow (初回) | handleFollowEvent | line_users, user_accounts, user_service_statuses, conversation_threads | 「友達追加ありがとう+招待コード入力を促す」 |
| E2 | follow (再フォロー/コード使用済み/問診完了) | handleFollowEvent → startIntakeFlow('follow') | — | 「おかえりなさい」 |
| E3 | follow (再フォロー/コード使用済み/問診未完了) | handleFollowEvent → startIntakeFlow('follow') | bot_mode_sessions | 問診再開/新規開始 |
| E4 | unfollow | handleUnfollowEvent | line_users (follow_status='blocked') | なし |

---

## 5. DB操作リスト（全テーブル×操作マッピング）

### 5.1 テーブル別 書込操作一覧

| テーブル | INSERT | UPDATE | DELETE | 呼び出し元 |
|---------|--------|--------|--------|-----------|
| `line_users` | follow時 | unfollow時/プロフィール更新 | — | handleFollowEvent, handleUnfollowEvent, handleInviteCode |
| `user_accounts` | follow時 | 招待コード認証時(client_account_id変更) | — | handleFollowEvent, handleInviteCode |
| `user_service_statuses` | follow時/招待コード時 | 問診完了時/admin停止時 | — | handleFollowEvent, handleInviteCode, processActivity |
| `conversation_threads` | follow時/メッセージ受信時 | mode変更時 | — | handleFollowEvent, ensureOpenThread, updateThreadMode |
| `conversation_messages` | 全テキスト/画像受信時+bot返信時 | — | — | handleTextMessageEvent, handleImageMessageEvent, handleConsultText |
| `message_attachments` | 画像受信時 | — | — | handleImageMessageEvent |
| `image_analysis_jobs` | 画像受信時 | 解析開始/完了/失敗時 | — | handleImageMessageEvent, processImageAnalysis |
| `image_intake_results` | 解析完了時(applied_flag=0) | 確定(1)/取消(2)/期限切れ(3)/テキスト修正(proposed_action更新) | — | processImageAnalysis, handleImageConfirm/Discard/Correction, Cron |
| `bot_mode_sessions` | 問診開始時/モード切替時 | ステップ進行時 | モード終了時/問診完了時 | 多数 |
| `user_profiles` | 問診Q1回答時(INSERT OR IGNORE) | 問診各Q回答時 | — | intake-flow.ts saveProfileField |
| `intake_answers` | 問診各Q回答時 | 同一Q再回答時(ON CONFLICT UPDATE) | — | intake-flow.ts saveIntakeAnswer |
| `daily_logs` | 体重/食事記録時(INSERT OR IGNORE) | — | — | ensureDailyLog |
| `body_metrics` | 問診Q5/体重テキスト/画像確認確定時 | 同日再記録時(UPSERT) | — | upsertWeight, upsertBodyMetrics |
| `meal_entries` | 食事テキスト/画像確認確定時 | 同区分追記時/画像更新時 | — | createMealEntry, updateMealEntryFromEstimate |
| `progress_photos` | 画像確認確定時(体型写真) | — | — | createProgressPhoto |
| `invite_codes` | admin発行時 | use_count++/status変更 | — | handleInviteCode, useInviteCode |
| `invite_code_usages` | 初回コード使用時 | — | — | useInviteCode |
| `weekly_reports` | Cron週次レポート時 | — | — | weeklyReportJob |

### 5.2 主要なDB操作フロー

**招待コード認証成功時:**
```sql
-- 1. invite_code_usages に使用記録
INSERT INTO invite_code_usages (id, invite_code_id, line_user_id, used_at) ...

-- 2. invite_codes の use_count を +1
UPDATE invite_codes SET use_count = use_count + 1 WHERE id = ?

-- 3. user_accounts の client_account_id を変更（デフォルト→招待元admin）
UPDATE user_accounts SET client_account_id = ? WHERE line_user_id = ? AND client_account_id = ?

-- 4. user_service_statuses を正しいアカウントに紐付け
INSERT INTO user_service_statuses (...) ON CONFLICT DO UPDATE SET ...

-- 5. bot_mode_sessions を intake 開始
INSERT/UPDATE bot_mode_sessions SET current_mode='intake', current_step='intake_nickname'
```

**問診回答時（各ステップ共通）:**
```sql
-- 1. user_profiles の該当カラムを更新
UPDATE user_profiles SET {column} = ?, updated_at = ? WHERE user_account_id = ?

-- 2. intake_answers に回答を保存
INSERT INTO intake_answers (...) ON CONFLICT(user_account_id, intake_form_id, question_key) DO UPDATE SET answer_value = ?

-- 3. bot_mode_sessions のステップを進行
UPDATE bot_mode_sessions SET current_step = ?, updated_at = ? WHERE client_account_id = ? AND line_user_id = ?
```

---

## 6. 招待コード判定パターン（完全版）

> 参照: `docs/04_招待コード_ビジネスルール.md`

| パターン | 条件 | エラーコード | BOT返信 | DB操作 |
|---------|------|-------------|---------|--------|
| P1 | 既登録 + 問診完了 | — | 「既に登録済み。そのままご利用ください」 | なし |
| P2 | 既登録 + 問診未完了 | — | 「登録済み」+ Q1送信 | bot_mode_sessions upsert |
| P3 | コード不存在/無効 | INVALID_CODE | 「この招待コードは無効です」 | なし |
| P4 | コード期限切れ | CODE_EXPIRED | 「有効期限切れです」 | invite_codes.status='expired' |
| P5 | 使用上限到達 | CODE_EXHAUSTED | 「使用上限に達しています」 | なし |
| P6 | 同一ユーザーが同一コード再使用 | ALREADY_USED | → P1 or P2 に分岐 | なし |
| P7a | 同一ユーザーが同一アカウントの別コード | ALREADY_USED | → P1 or P2 に分岐 | なし |
| P7b | 登録済ユーザーが別アカウントのコード | ALREADY_BOUND | → P1 or P2 に分岐（紐付け変更せず） | なし |
| P8 | 別ユーザーが max_uses=1 の使用済みコード | CODE_EXHAUSTED | 「使用上限に達しています」 | なし |
| P9 | 新規ユーザー + 有効コード | SUCCESS | 「登録完了」+ Q1送信 | invite_code_usages INSERT, user_accounts UPDATE, user_service_statuses UPSERT, bot_mode_sessions UPSERT |

---

## 7. キーワード・正規表現 一覧（実装値）

### 7.1 正規表現

| 名前 | パターン | 用途 | ソース |
|------|---------|------|--------|
| INVITE_CODE_PATTERN | `/^([A-Z]{3}-\d{4})$/i` | 招待コード検出 | process-line-event.ts L58 |
| WEIGHT_PATTERN | `/(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg\|ｋｇ\|キロ\|Kg\|KG)/i` | 体重テキスト検出 | process-line-event.ts L60 |

### 7.2 キーワードリスト

| カテゴリ | キーワード | 用途 | マッチ方式 |
|---------|-----------|------|-----------|
| CONSULT_KEYWORDS | 相談, 質問, アドバイス, 教えて, どうすれば, 悩み, ヘルプ | ※現在未使用（暗黙分岐のみ） | — |
| RECORD_KEYWORDS | 記録, ログ, メモ | ※現在未使用（暗黙分岐のみ） | — |
| SWITCH_TO_CONSULT | 相談モード, 相談にして, 相談する | 相談モード切替 | 部分一致 (includes) |
| SWITCH_TO_RECORD | 記録モード, 記録にして, 記録する, 戻る | 記録モード切替 | 部分一致 (includes) |
| 問診コマンド | 問診, ヒアリング, 登録, 初期設定 | 問診開始 | 完全一致 + regex |
| 画像確定 | 確定, はい, yes, ok, OK, 記録, 保存 | 画像確認→記録 | 部分一致 |
| 画像取消 | 取消, キャンセル, cancel, いいえ, no, やめる, 削除 | 画像確認→破棄 | 部分一致 |
| 問診スキップ | スキップ, skip, 省略, とばす, 飛ばす | 問診項目スキップ | 部分一致 (lowercase) |
| concerns次へ | 次へ, next, 完了, done, スキップ | Q8 concern_tags → Q9 | 部分一致 |

### 7.3 食事区分判定

| 区分 | キーワード | 正規表現 |
|------|-----------|----------|
| breakfast | 朝, 朝食, 朝ご飯, breakfast | `/朝\|朝食\|朝ご飯\|breakfast/i` |
| lunch | 昼, 昼食, 昼ご飯, ランチ, lunch | `/昼\|昼食\|昼ご飯\|ランチ\|lunch/i` |
| dinner | 夜, 夕, 夕食, 夕ご飯, ディナー, dinner | `/夜\|夕\|夕食\|夕ご飯\|ディナー\|dinner/i` |
| snack | 間食, おやつ, snack | `/間食\|おやつ\|snack/i` |
| other | 上記以外(8文字以上) | — |

---

## 8. API・Webhook エンドポイント一覧

### 8.1 LINE Webhook

| パス | メソッド | 処理 |
|------|---------|------|
| `/api/webhooks/line` | POST | 署名検証 → イベントディスパッチ |

### 8.2 管理者API (JWT認証必須)

| パス | メソッド | 処理 |
|------|---------|------|
| `/api/admin/invite-codes` | GET | 招待コード一覧 |
| `/api/admin/invite-codes` | POST | 招待コード発行 |
| `/api/admin/invite-codes/:id/revoke` | PATCH | 招待コード無効化 |
| `/api/admin/users` | GET | LINEユーザー一覧 |
| `/api/admin/users/:id` | GET | ユーザー詳細 |
| `/api/admin/users/:id/toggle-service` | PATCH | サービスON/OFF |
| `/api/admin/auth/login` | POST | ログイン |
| `/api/admin/auth/change-password` | POST | パスワード変更 |

### 8.3 ユーザーAPI (LIFF JWT認証)

| パス | メソッド | 処理 |
|------|---------|------|
| `/api/auth/line` | POST | LIFF→JWT変換 |
| `/api/users/me/dashboard` | GET | ダッシュボードデータ |
| `/api/users/me/records` | GET | 記録一覧 |
| `/api/users/me/photos` | GET | 進捗写真一覧 |

---

## 9. Cronジョブ一覧

| ジョブ | スケジュール | 処理 | AI使用 |
|--------|-------------|------|--------|
| daily-reminder | JST 21:00 (UTC 12:00) | 未記録ユーザーにPush | ✅ (パーソナライズ文面) |
| weekly-report | 日曜 JST 20:00 (UTC 11:00) | 週次集計→AI要約→Push+DB保存 | ✅ (要約生成) |
| cleanup | 毎時0分 | ①pending画像24h破棄 ②期限切れセッション削除 ③期限切れ招待コード失効 | ❌ |

---

## 10. BOT文言正本（Rich Menu連動）

> **Rich Menu設定詳細は `docs/10_RichMenu設定ガイド.md` を参照**

### 10.1 Rich Menuボタン → BOT返信

| ボタン | 送信テキスト | BOT返信文 |
|--------|-------------|-----------|
| 記録する | `記録する` | `📝 記録モードです。\n記録したい内容を送ってください。食事写真・食事テキスト・体重の数字・体重計の写真、どれでもOKです。` |
| 相談する | `相談する` | `💬 相談モードです。食事・体重・外食・間食・続け方など、何でも送ってください 😊` |
| ダッシュボード | URI `https://liff.line.me/2009409790-DekZRh4t` | （BOT返信なし。LIFF直接遷移） |

### 10.2 画像確認待ち中のBOT返信

| ユーザー入力 | BOT返信文 |
|-------------|-----------|
| 確定 | `✅ 食事記録を保存しました！\n📊 食品DB照合済み（N/M品マッチ）\n\n写真をもっと送ると、1日の栄養バランスが見えてきます 📊` |
| 取消 | `🗑 この記録を取り消しました。\n\n画像を再送していただくか、テキストで直接入力できます。` |
| テキスト修正 | `✏️ 修正を反映しました！\n\n🍽 {食事区分}\n📝 {内容}\n🔥 推定カロリー: {cal} kcal\n💪 P: {p}g / F: {f}g / C: {c}g\n📊 食品DB照合: N/M品マッチ\n\n↓ この内容で記録しますか？` + Quick Reply（確定/取消） |

---

## 11. 既知の問題と改善計画

### 11.1 現在の問題点

| # | 問題 | 重要度 | 影響 | 対応案 |
|---|------|--------|------|--------|
| G1 | `CONSULT_KEYWORDS`/`RECORD_KEYWORDS` が定義されているが実際の分岐で未使用 | 中 | 「相談」とだけ入力してもconsultモードに切り替わらない（「相談モード」が必要） | CONSULT_KEYWORDS を分岐ロジックに組み込む |
| G2 | 問診中に体重パターンを送信すると record 処理に回る可能性 | 中 | Q5(現在体重)で「68kg」と送ると、intake_current_weight ハンドラとrecord体重検出が競合 | intake mode の優先度を再確認（現在は intake が先に処理される。intake中は intake_flow で処理して return するため問題なし） |
| G3 | image-analysis.ts と image-analyzer.ts のプロンプト重複 | 低 | メンテナンス性低下 | 統一 |
| G4 | food_master と画像解析結果のマッチング未統合 | 中 | 画像解析のPFC推定がAIのみで、マスター参照なし | Phase 2 で統合 |
| G5 | ~~Rich Menu 未設定~~ | ~~低~~ | ~~モード切替がテキストコマンドのみ~~ | ✅ 解決済み（3ボタンRich Menu設定完了） |
| G6 | 食事記録の日付が常に「今日」固定 | **高** | 「昨日の夕食」「おとといの焼肉」等の過去日付が反映されず、日々の正確な摂取カロリー・栄養素データが取れない | 記録モードのテキストをAIで解析し、日付・食事区分・内容を一括抽出する設計に変更が必要 |
| G7 | 食事区分がキーワード正規表現のみで文脈理解なし | **高** | 「3時にポテチ食べた」が間食と判定されない。時間帯推定もなし。「お菓子食べた」も食事記録として捉えられない | AI解析で文脈から食事区分を推定。不明な場合はBOTが「いつの食事ですか？」と確認するフローが必要 |
| G8 | 過去記録の修正ができない | 中 | 「昨日の朝食の写真、夕食の間違いだった」等に対応不可 | AI会話で修正意図を検出し、該当レコードを更新する機能が必要 |
| G9 | 相談モード中の体重・食事報告が記録されない | 中 | 相談中に「昨日58kgだった」と言っても記録に反映されない | AIが会話内容から記録すべき情報を検出し、自動記録する仕組みが必要 |

### 11.2 改善優先順位

1. ~~**【即時】** E2Eテスト（全フロー通し確認）~~ ✅ 79件全PASS
2. ~~**【即時】** 本番マイグレーション・seed投入~~ ✅ 完了
3. ~~**【短期】** CONSULT_KEYWORDS をモード自動切替に組み込み~~ ✅ 実装済み
4. ~~**【短期】** Rich Menu 設定（記録/相談/ダッシュボード）~~ ✅ 3ボタン設定完了
5. ~~**【短期】** 画像解析 × food_master マッチング統合~~ ✅ 実装済み
6. **【最優先】** 記録モードのAI解析化（G6/G7対応）→ **設計完了: `11_会話解釈SSOT.md`**
   - Phase A: 全メッセージをAIで解釈し Unified Intent JSON に変換
   - Phase B: 不足情報をユーザーに確認 → **設計完了: `12_記録確認フローSSOT.md`**
   - Phase C: 確定した記録を DB に保存
7. **【高】** 過去記録修正機能（G8対応）→ **設計完了: `11_会話解釈SSOT.md` §7**
   - correct_record intent で修正対象を特定 → 更新 → correction_history に記録
8. **【高】** 相談モード中の自動記録検出（G9対応）→ **設計完了: `11_会話解釈SSOT.md` §6.2**
   - intent_secondary で記録情報を検出し、相談応答と並行して記録
9. **【中期】** パーソナルメモリ導入 → **設計完了: `13_パーソナルメモリSSOT.md`**
   - user_memory_items テーブルで嗜好・習慣・アレルギーを蓄積
10. **【中期】** RAG実装（LIKE検索→ベクトル検索）
11. **【中期】** 管理画面プロンプトエディタ
12. **【中期】** user/admin/superadmin画面微調整

---

## 12. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-12 | v1.0 | 初版作成。コード実装ベースでSSOTを文書化 |
| 2026-03-13 | v1.1 | 画像テキスト修正機能(handleImageCorrection)追加。P7原則をブロック→AI再解析に変更。Rich Menu 3ボタン設定完了。BOT文言統一 |
| 2026-03-13 | v1.2 | G6-G9追加: 食事日付固定・食事区分キーワード限定・過去記録修正不可・相談中自動記録なし。改善優先順位を更新 |
| 2026-03-13 | v1.3 | v2.0設計ドキュメント参照を追加。P3原則にAI使用箇所追加（会話解釈・メモリ抽出）。LANE3運用レーンにv2.0アーキテクチャ記述追加。AI分類マトリクスに#19,#20追加。改善優先順位にドキュメントリンク追加。新ドキュメント: `11_会話解釈SSOT.md`, `12_記録確認フローSSOT.md`, `13_パーソナルメモリSSOT.md` |
