# LINE 動き仕様書（LINEフロー完全定義）

> 最終更新: 2026-03-12  
> 対象: diet-bot v1.0.0 (Phase 1 MVP)

---

## 1. 概要

本システムは **1つのLINE公式アカウント**（食事指導BOT: @054eyzbj）で動作し、内部的にモード切り替えによって以下の機能を提供する。

| モード | 説明 | トリガー |
|--------|------|----------|
| **（認証前）** | 招待コード入力待ち | フォロー直後 |
| **intake** | 初回問診（9問） | 招待コード認証後 / 「問診」コマンド |
| **record** | 体重・食事テキスト記録 | 問診完了後のデフォルト |
| **consult** | AI栄養相談 | 「相談」「相談モード」等 |
| **pending_image_confirm** | 画像解析結果の確認待ち | 画像送信→AI解析完了後 |

---

## 2. イベント別フロー詳細

### 2.1 フォローイベント（友達追加 / 再フォロー）

```
[ユーザー] LINE友達追加（@054eyzbj）
    │
    ▼
[BOT] handleFollowEvent
    ├─ getUserProfile() → LINE APIからプロフィール取得
    ├─ upsertLineUser() → line_users テーブルに upsert
    ├─ ensureUserAccount() → user_accounts テーブルに作成（clientAccountId紐付け）
    ├─ upsertUserServiceStatus() → bot_enabled=1, record_enabled=1, consult_enabled=1, intake_completed=0
    ├─ ensureOpenThread() → conversation_threads テーブルに作成
    │
    ├─ [再フォロー判定] findInviteCodeUsageByLineUser()
    │   ├─ 既に招待コード使用済み → startIntakeFlow('follow')
    │   │   ├─ intake_completed=1 → 「おかえりなさい！」メッセージ
    │   │   └─ intake_completed=0 → 問診フロー再開/新規開始
    │   │
    │   └─ 未使用 → 初回フォローメッセージ送信
    │
    ▼
[BOT返信]
「🎉 友だち追加ありがとうございます！
 食事指導BOTへようこそ。
 📋 担当者から受け取った「招待コード」を送信してください。
 例: ABC-1234
 招待コードを入力すると、あなた専用のダイエットサポートが開始されます！」
```

**保存先テーブル:**
| テーブル | 操作 | データ |
|----------|------|--------|
| `line_users` | UPSERT | line_channel_id, line_user_id, display_name, picture_url, follow_status='following' |
| `user_accounts` | INSERT OR IGNORE | line_user_id → clientAccountId (デフォルト紐付け) |
| `user_service_statuses` | UPSERT | bot_enabled=1, record_enabled=1, consult_enabled=1, intake_completed=0 |
| `conversation_threads` | INSERT OR IGNORE | lineChannelId, lineUserId, userAccountId |

---

### 2.2 アンフォローイベント（ブロック）

```
[ユーザー] BOTをブロック
    │
    ▼
[BOT] handleUnfollowEvent
    └─ upsertLineUser(followStatus='blocked')
```

**保存先テーブル:**
| テーブル | 操作 | データ |
|----------|------|--------|
| `line_users` | UPDATE | follow_status='blocked' |

---

### 2.3 招待コード送信（テキストメッセージ — 最優先処理）

```
[ユーザー] 「FJJ-2964」(テキスト送信)
    │
    ├─ 正規表現マッチ: /^([A-Z]{3}-\d{4})$/i
    │
    ▼
[BOT] handleInviteCode (checkServiceAccess の前に実行)
    ├─ ensureUserInitialized() → フォローイベント未到達のフォールバック
    ├─ useInviteCode(db, code, lineUserId)
    │   ├─ INVALID_CODE → 「❌ この招待コードは無効です」
    │   ├─ CODE_EXPIRED → 「⏰ この招待コードは有効期限切れです」
    │   ├─ CODE_EXHAUSTED → 「⚠️ この招待コードは使用上限に達しています」
    │   ├─ ALREADY_USED → 「ℹ️ このコードは既に登録済みです」
    │   └─ success → 続行
    │
    ├─ targetAccountId = invite_codes.account_id（コード発行元のアカウント）
    ├─ user_accounts の client_account_id を targetAccountId に更新
    ├─ upsertUserServiceStatus(targetAccountId, bot_enabled=1, ...)
    │
    ▼
[BOT返信]
「✅ 招待コード「FJJ-2964」で登録が完了しました！
 これからダイエットサポートを開始します。
 まずは初回ヒアリングにお答えください 😊」
    │
    ▼
[BOT] startIntakeFlow() → 問診開始
「ようこそ！🌿 diet-bot へ！
 はじめに簡単なご登録（9問）をお願いします。
 ※いつでも「スキップ」と送れば省略できます。
 ━━━━━━━━━━━━━━━
 【質問 1/9】
 お名前（ニックネームでOK）を教えてください！」
```

**保存先テーブル:**
| テーブル | 操作 | データ |
|----------|------|--------|
| `invite_code_usages` | INSERT | invite_code_id, line_user_id, used_at |
| `invite_codes` | UPDATE | use_count += 1 |
| `user_accounts` | UPDATE | client_account_id = targetAccountId |
| `user_service_statuses` | UPSERT | targetAccountId 紐付け |
| `bot_mode_sessions` | UPSERT | current_mode='intake', current_step='intake_nickname' |

---

### 2.4 問診フロー（intake モード）

全9問、1問ごとにLINEメッセージのやりとり。

| # | ステップ | 質問 | 入力例 | Quick Reply | DB保存先 |
|---|----------|------|--------|-------------|----------|
| 1 | `intake_nickname` | お名前（ニックネーム） | 「たろう」 | なし | user_profiles.nickname, intake_answers |
| 2 | `intake_gender` | 性別 | 「男性」 | 男性/女性/答えない | user_profiles.gender, intake_answers |
| 3 | `intake_age_range` | 年代 | 「30s」 | 20代/30代/40代/50代/60代以上/スキップ | user_profiles.age_range, intake_answers |
| 4 | `intake_height` | 身長(cm) | 「170cm」 | なし | user_profiles.height_cm, intake_answers |
| 5 | `intake_current_weight` | 現在の体重(kg) | 「72.5kg」 | なし | user_profiles.current_weight_kg, intake_answers, body_metrics |
| 6 | `intake_target_weight` | 目標体重(kg) | 「65kg」 | なし | user_profiles.target_weight_kg, intake_answers |
| 7 | `intake_goal` | 目標・理由 | 「夏までに5kg痩せたい」 | なし | user_profiles.goal_summary, intake_answers |
| 8 | `intake_concerns` | 気になること（複数可） | 「お腹まわり」→「次へ」 | お腹まわり/体重が減らない/食べすぎ/むくみ/運動不足/次へ進む | user_profiles.concern_tags(JSON), intake_answers |
| 9 | `intake_activity` | 活動レベル | 「moderate」 | 座り仕事中心/軽い運動あり/週3〜5回運動/毎日激しく運動/スキップ | user_profiles.activity_level, intake_answers |

**問診完了時の処理:**
```
[BOT] processActivity (最後のステップ)
    ├─ user_service_statuses.intake_completed = 1
    ├─ bot_mode_sessions → current_mode='record', current_step='idle'
    │
    ▼
[BOT返信]
「✨ たろう さん、ご登録ありがとうございます！
 🎯 目標: 72.5kg → 65kg（7.5kg減）
 ━━━━━━━━━━━━━━━
 これから一緒に頑張りましょう！💪
 【使い方】
 📝 毎日の体重・食事を記録
 💬「相談」と送ると相談モードに切替
 📷 食事の写真を送ると自動解析
 ⚖️ 体重計の写真でも記録できます
 今日も記録をスタートしましょう！」
```

**問診の中断・再開:**
| コマンド | 動作 |
|----------|------|
| 「問診」「ヒアリング」「登録」「初期設定」 | intake_completed=1なら「完了済み」表示。途中セッションあれば再開確認。なければ新規開始。 |
| 「問診やり直し」 | intake_completed=0にリセット → 質問1から開始 |
| 「問診再開」 | 前回の途中ステップから再開 |
| すべてのステップで「スキップ」 | その項目をnullで保存し次の質問へ |

---

### 2.5 体重テキスト記録（record モード）

```
[ユーザー] 「72.5kg」
    │
    ├─ 正規表現マッチ: /(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|ｋｇ|キロ|Kg|KG)/i
    │
    ▼
[BOT] handleRecordText
    ├─ ensureDailyLog(userAccountId, today)
    ├─ upsertWeight(dailyLogId, 72.5)
    ├─ createConversationMessage(bot, 「体重 72.5kg を記録しました ✅」)
    │
    ▼
[BOT返信] (Quick Reply付き)
「体重 72.5kg を記録しました ✅
 他に記録することはありますか？」
 [🍽 食事を記録] [💬 相談する]
```

**保存先テーブル:**
| テーブル | 操作 | データ |
|----------|------|--------|
| `daily_logs` | INSERT OR IGNORE | user_account_id, client_account_id, log_date=今日(JST) |
| `body_metrics` | UPSERT | daily_log_id, weight_kg=72.5 |
| `conversation_messages` | INSERT | sender_type='bot', mode_at_send='record' |

---

### 2.6 食事テキスト記録（record モード）

```
[ユーザー] 「朝食 トースト・コーヒー・目玉焼き」
    │
    ├─ 食事区分判定: classifyMealType() → 'breakfast'
    │
    ▼
[BOT] handleRecordText
    ├─ ensureDailyLog()
    ├─ createMealEntry(mealType='breakfast', mealText='...', status='draft')
    │
    ▼
[BOT返信] (Quick Reply付き)
「食事を記録しました ✅
 写真も送ると栄養素を自動で計算できます 📷」
 [⚖️ 体重も記録] [💬 相談する]
```

**食事区分キーワード:**
| 区分 | キーワード |
|------|-----------|
| breakfast | 朝, 朝食, 朝ご飯, breakfast |
| lunch | 昼, 昼食, 昼ご飯, ランチ, lunch |
| dinner | 夜, 夕, 夕食, 夕ご飯, ディナー, dinner |
| snack | 間食, おやつ, snack |
| other | 上記以外 (8文字以上のテキスト) |

---

### 2.7 AI 相談モード（consult モード）

```
[ユーザー] 「相談」「相談モード」「相談する」
    │
    ▼
[BOT] モード切替
    ├─ updateThreadMode(thread, 'consult')
    ├─ upsertModeSession(currentMode='consult', currentStep='idle')
    │
    ▼
[BOT返信]
「💬 相談モードに切り替えました。
 お気軽にご相談ください！」
```

```
[ユーザー] 「最近体重が減らないんですが、どうすればいいですか？」
    │
    ▼
[BOT] handleConsultText
    ├─ listRecentMessages(最新10ターン) → 会話履歴
    ├─ OpenAI API 呼び出し (systemPrompt + history + user message)
    │   ├─ model: OPENAI_MODEL環境変数 (デフォルト: gpt-4o)
    │   ├─ temperature: 0.7
    │   ├─ max_tokens: 512
    │   └─ systemPrompt: ダイエット専門AIアシスタント（ハードコード）
    ├─ createConversationMessage(bot, response)
    │
    ▼
[BOT返信] (Quick Reply付き)
「体重が停滞する"プラトー"は正常な現象です。...（AI応答）」
 [📝 記録に戻る] [💬 続けて相談]
```

**システムプロンプト（ハードコード）:**
```
あなたはダイエット専門のAIアシスタントです。
ユーザーの食事・運動・体重管理をサポートし、科学的根拠に基づいたアドバイスを提供します。
- 常に励ましながら、具体的で実践的なアドバイスをしてください
- 医療診断は行わず、気になる症状は専門医への相談を促してください
- 日本語で、丁寧かつ親しみやすい口調で応答してください
- 回答は200文字以内で簡潔にまとめてください
```

**モード切替コマンド:**
| コマンド | 動作 |
|----------|------|
| 「記録モード」「記録にして」「記録する」「戻る」 | → record モードに切替 |
| 「相談モード」「相談にして」「相談する」 | → consult モードに切替 |

---

### 2.8 画像メッセージ（食事写真・体重計など）

```
[ユーザー] 画像送信（食事写真）
    │
    ▼
[BOT] handleImageMessageEvent
    ├─ ensureUserInitialized() → フォールバック初期化
    ├─ checkServiceAccess() → botEnabled確認
    ├─ getMessageContent() → LINE Content APIから画像バイナリ取得
    ├─ R2.put() → R2ストレージ保存 (key: intake/{userAccountId}/{date}-{messageId}.jpg)
    ├─ createConversationMessage(type='image')
    ├─ createMessageAttachment(storageKey, contentType, fileSize)
    ├─ createImageAnalysisJob(providerRoute='openai_vision')
    ├─ LINE_EVENTS_QUEUE.send({ type:'image_analysis', ... })
    │
    ▼
[BOT返信]
「📷 画像を受け取りました！
 解析中です。少しお待ちください...」
    │
    ▼ (Queue Consumer: 非同期処理)
[Worker] lineQueueConsumer
    ├─ R2.get() → 画像バイナリ取得
    ├─ Base64変換 → OpenAI Vision API (分類プロンプト)
    │   └─ 分類: meal_photo / nutrition_label / body_scale / progress_body_photo / other / unknown
    ├─ カテゴリに応じた詳細解析 (各専用プロンプト)
    ├─ image_intake_results に保存 (applied_flag=0: pending)
    ├─ bot_mode_sessions → current_step='pending_image_confirm'
    │
    ▼
[BOT Push通知]
「🍽️ 食事を記録しました！
 ・チキンカレー（約650kcal）
 ・サラダ（約80kcal）
 合計: 約730kcal
 P: 35g / F: 20g / C: 95g
 バランスの良い食事です。」
 [✅ 確定] [❌ 取消]
```

---

### 2.9 画像確認フロー（pending_image_confirm モード）

```
[ユーザー] 「確定」（= 記録保存）
    │
    ▼
[BOT] handleImageConfirm
    ├─ findIntakeResultById() → applied_flag=0 確認
    ├─ applyProposedAction()
    │   ├─ create_or_update_meal_entry → meal_entries テーブル
    │   ├─ upsert_weight → body_metrics テーブル
    │   └─ create_progress_photo → progress_photos テーブル
    ├─ markIntakeResultApplied(applied_flag=1)
    ├─ deleteModeSession()
    │
    ▼
[BOT返信]
「✅ 食事記録を保存しました！
 写真をもっと送ると、1日の栄養バランスが見えてきます 📊」
```

```
[ユーザー] 「取消」（= 記録破棄）
    │
    ▼
[BOT] handleImageDiscard
    ├─ markIntakeResultDiscarded(applied_flag=2)
    ├─ deleteModeSession()
    │
    ▼
[BOT返信]
「🗑 この記録を取り消しました。
 画像を再送していただくか、テキストで直接入力できます。」
```

**applied_flag の状態遷移:**
| 値 | 状態 | 説明 |
|----|------|------|
| 0 | pending | AI解析完了、ユーザー未確認 |
| 1 | confirmed | ユーザーが「確定」→メインテーブルに反映済み |
| 2 | discarded | ユーザーが「取消」 |
| 3 | expired | 24時間経過で自動破棄 (Cronジョブ) |

---

### 2.10 定期ジョブ

| ジョブ | スケジュール | 処理 |
|--------|-------------|------|
| **毎日リマインダー** | JST 21:00 (UTC 12:00) | record_enabled=1 で今日の daily_log がないユーザーに LINE Push |
| **週次レポート** | JST 20:00 日曜 (UTC 11:00) | 直近7日のログを集計 → OpenAIで要約 → LINE Push + weekly_reports保存 |
| **毎時クリーンアップ** | 毎時0分 | ①24h経過した pending 画像確認の自動破棄 ②期限切れセッション削除 ③期限切れ招待コードの失効 |

---

## 3. テキストメッセージ処理の優先順位（handleTextMessageEvent）

```
1. 招待コード検出 (/^[A-Z]{3}-\d{4}$/i) → handleInviteCode → return
2. ensureUserInitialized() → フォールバック初期化
3. checkServiceAccess() → access denied なら招待コード入力を促して return
4. ユーザー・スレッド確保 (ensureUserAccount, ensureOpenThread)
5. メッセージ保存 (createConversationMessage)
6. コマンド判定:
   a. 問診開始コマンド (問診/ヒアリング/登録/初期設定) → startIntakeFlow
   b. 問診やり直し → beginIntakeFromStart
   c. 問診再開 → resumeIntakeFlow
   d. 相談モード切替 (相談モード/相談にして/相談する) → updateThreadMode('consult')
   e. 記録モード切替 (記録モード/記録にして/記録する/戻る) → updateThreadMode('record')
7. モードセッション確認:
   a. pending_image_confirm → 確定/取消判定
   b. intake モード → handleIntakeStep
8. 最終分岐:
   a. consult → handleConsultText (OpenAI)
   b. record → handleRecordText (体重/食事テキスト)
```

---

## 4. DB テーブル関連図（LINE処理に関するもの）

```
line_channels (LINEチャンネル設定)
    │ id = 'ch_default_replace_me' (内部ID)
    │ channel_id = '1656660870' (LINE Channel ID)
    │
    ├─→ line_users (LINEユーザー)
    │     ├ line_channel_id FK → line_channels.id
    │     ├ line_user_id (LINE UserId)
    │     ├ display_name, picture_url, follow_status
    │     │
    │     ├─→ user_accounts (ユーザー↔アカウント紐付け)
    │     │     ├ line_user_id
    │     │     ├ client_account_id FK → accounts.id
    │     │     │   (招待コードで正しいadminアカウントに紐付け)
    │     │     │
    │     │     ├─→ user_profiles (問診結果)
    │     │     ├─→ intake_answers (問診回答)
    │     │     ├─→ daily_logs → body_metrics, meal_entries
    │     │     ├─→ progress_photos
    │     │     └─→ weekly_reports
    │     │
    │     ├─→ user_service_statuses (サービス制御)
    │     │     ├ account_id + line_user_id (UNIQUE)
    │     │     ├ bot_enabled, record_enabled, consult_enabled
    │     │     └ intake_completed
    │     │
    │     └─→ invite_code_usages (招待コード使用履歴)
    │
    └─→ conversation_threads → conversation_messages
         │                      → message_attachments
         │                        → image_analysis_jobs
         │                          → image_intake_results
         │
         └─→ bot_mode_sessions (intake/record/consult/pending_image_confirm)

accounts (アカウント: system / clinic)
    ├─→ account_memberships (superadmin / admin)
    └─→ invite_codes (招待コード)
```

---

## 5. Webhook 署名検証フロー

```
[LINE Platform] POST /api/webhooks/line
    │ Header: X-Line-Signature
    │ Body: JSON (events[])
    │
    ▼
[webhook.ts]
    ├─ rawBody = c.req.text()
    ├─ signature = header('x-line-signature')
    ├─ verifyLineSignature(rawBody, signature, LINE_CHANNEL_SECRET)
    │   └─ HMAC-SHA256 (Web Crypto API) → Base64比較
    │
    ├─ 失敗 → 401 { error: 'Invalid signature' }
    │
    ├─ JSON parse → events[]
    │
    ├─ line_channels テーブルから内部ID取得
    │   └─ SELECT id FROM line_channels WHERE channel_id = env.LINE_CHANNEL_ID
    │
    └─ events.map(event => processLineEvent(event, ctx))
       └─ ctx = { env, lineChannelId (内部ID), clientAccountId }
```
