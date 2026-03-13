# E2E LINE 会話フロー テストケース仕様書

## 概要

diet-bot の LINE 会話フロー全体を End-to-End でテストする。
webhook エンドポイントに LINE 互換のペイロードを直接 POST し、
DB 状態遷移・LINE 応答メッセージ・モードセッション遷移を検証する。

## テスト方針

- **署名検証をバイパス**: テスト用リクエストでは `X-Line-Signature` を正しいHMAC-SHA256署名で生成
- **LINE API モック不要**: LINE reply/push API はダミートークンのため 4xx が返るが、
  webhook 処理自体は完走するため DB 状態を検証の主軸とする
- **テストデータの独立性**: 各テストケースで固有の `lineUserId` を使用し、相互干渉を防ぐ
- **DB クエリは HTTP 経由**: `/api/test/query` & `/api/test/exec` エンドポイントで高速化（wrangler spawn 不要）

---

## 前提条件

| 項目 | 値 |
|------|-----|
| ローカルサーバー | `http://localhost:3000` |
| Webhook URL | `POST /api/webhooks/line` |
| LINE_CHANNEL_SECRET | `.dev.vars` の値 (`dummy_secret_for_local_dev`) |
| LINE_CHANNEL_ID | `ch_default_replace_me` (line_channels テーブルの内部 ID) |
| CLIENT_ACCOUNT_ID | `acc_client_00000000000000000000000000000001` |
| テスト用招待コード | テスト前に DB に INSERT（`TST-0001` 〜 `TST-0009`） |
| intake_forms | `default_intake` レコードが必要（FK 制約） |
| APP_ENV | `development`（/api/test/* エンドポイントの有効化に必要） |

### 必須 seed レコード

テスト実行前に以下のレコードが DB に存在する必要がある:

| テーブル | ID | 説明 |
|---------|-----|------|
| `accounts` | `acc_client_00000000000000000000000000000001` | テストクリニック |
| `account_memberships` | `mem_admin_00000000000000000000000000000001` | クライアント管理者 |
| `line_channels` | `ch_default_replace_me` | LINE チャンネル設定 |
| `intake_forms` | `default_intake` | 初回問診フォーム定義 |
| `subscriptions` | `sub_client_...` | Pro プラン（任意） |

これらは `seed.sql` で投入される。E2E テスト固有のデータ（招待コード等）は `tests/e2e-seed.sql` で投入される。

---

## テストユーザー

| ユーザーID | 用途 |
|-----------|------|
| `U_e2e_user_001` | TC1: 新規ユーザー（問診完走）、TC3: 完了後コード再送 |
| `U_e2e_user_002` | TC2: 問診途中離脱→再開 |
| `U_e2e_user_004` | TC4: 別ユーザー使用済みコード |
| `U_e2e_user_005` | TC5: 体重記録 |
| `U_e2e_user_006` | TC6: 食事写真→確定 |
| `U_e2e_user_007` | TC7: 食事写真→取消 |
| `U_e2e_user_008` | TC8: 相談モード |
| `U_e2e_user_009` | TC9: Rich Menu 全ボタン |

---

## 招待コード（三文字プレフィックス `TST-`）

| コード | ID | max_uses | 用途 |
|--------|-----|----------|------|
| `TST-0001` | `ic_e2e_001` | 1 | TC1 新規登録用 / TC3 再送テスト / TC4 使用上限テスト |
| `TST-0002` | `ic_e2e_002` | 1 | TC2 途中離脱→再開 |
| `TST-0003` | `ic_e2e_003` | 1 | TC3 (予備) |
| `TST-0005` | `ic_e2e_005` | 1 | TC5 体重記録用 |
| `TST-0006` | `ic_e2e_006` | 1 | TC6 食事写真（確定）用 |
| `TST-0007` | `ic_e2e_007` | 1 | TC7 食事写真（取消）用 |
| `TST-0008` | `ic_e2e_008` | 1 | TC8 相談モード用 |
| `TST-0009` | `ic_e2e_009` | 1 | TC9 Rich Menu用 |

**正規表現パターン**: `/^([A-Z]{3}-\d{4})$/i`

---

## テストケース一覧

### TC1: 新規ユーザーが未使用コードを入力→問診完走

**目的**: フォロー→招待コード→問診 Q1〜Q9 が止まらず完走すること

**ステップ**:
1. follow イベント送信 → 招待コード入力を促すメッセージ
2. テキスト `TST-0001` 送信 → 登録完了 + Q1 送信
3. Q1: `テスト太郎` → Q2（性別）へ
4. Q2: `男性` → Q3（年代）へ
5. Q3: `30s` → Q4（身長）へ
6. Q4: `170` → Q5（現在体重）へ
7. Q5: `75` → Q6（目標体重）へ
8. Q6: `65` → Q7（目標・理由）へ
9. Q7: `夏までに痩せたい` → Q8（気になること）へ
10. Q8: `お腹まわり` → タグ追加（同じ Q8 に留まる）
11. Q8: `次へ` → Q9（活動レベル）へ
12. Q9: `moderate` → 完了メッセージ

**期待される DB 更新**:

| テーブル | カラム | 値 |
|---------|--------|-----|
| `line_users` | `line_user_id` | `U_e2e_user_001` |
| `invite_code_usages` | `line_user_id` | `U_e2e_user_001` (1件) |
| `invite_codes` (TST-0001) | `use_count` | `1` |
| `user_service_statuses` | `bot_enabled` | `1` |
| `user_service_statuses` | `intake_completed` | `1` |
| `bot_mode_sessions` | `current_mode` | `record` (問診完了後) |
| `user_profiles` | `nickname` | `テスト太郎` |
| `user_profiles` | `gender` | `male` |
| `user_profiles` | `height_cm` | `170` |
| `user_profiles` | `current_weight_kg` | `75` |
| `user_profiles` | `target_weight_kg` | `65` |
| `user_profiles` | `activity_level` | `moderate` |
| `intake_answers` | count | `≥ 9` |
| `body_metrics` | `weight_kg` | `75` (初期体重) |

**LINE 応答メッセージ** (DB 検証のみ、LINE API はダミー):
- follow → 「🎉 友だち追加ありがとうございます！」
- TST-0001 → 「✅ 招待コード「TST-0001」で登録が完了しました！」+ Q1 質問
- Q1〜Q8 → 各ステップの質問テキスト
- Q9 → 「🎉 ヒアリングが完了しました！...」

---

### TC2: 問診途中離脱→コード再送→途中から再開

**目的**: セッションが保持され、P6（常に現在の質問を返す）が機能すること

**ステップ**:
1. follow + コード `TST-0002` → Q1
2. Q1: `テスト花子` → Q2
3. Q2: `女性` → Q3
4. Q3: `20s` → Q4
5. （離脱: 何も送らない）
6. テキスト `TST-0002`（同じコードを再送）→ Q4（身長）の質問が直接返る
7. Q4〜Q9 を完走

**期待される DB 更新**:

| テーブル | 検証内容 |
|---------|---------|
| `bot_mode_sessions` | Q3回答後: `current_step = intake_height` |
| `bot_mode_sessions` | コード再送後: `current_step = intake_height` (変化なし) |
| `intake_answers` | 途中: nickname, gender, age_range の 3件 → 最終的に 9件 |
| `user_service_statuses` | 最終: `intake_completed = 1` |

**LINE 応答メッセージ**:
- コード再送 → Q4の質問テキスト「身長を教えてください（cm）」が直接返る
- 最終 → 完了メッセージ

---

### TC3: 問診完了後に同じコード再送→使い方ガイドのみ

**目的**: Pattern B（問診完了済み＋コード再送）で利用案内が返ること

**前提**: TC1 で `TST-0001` を使い問診完了した `U_e2e_user_001` がいる状態

**ステップ**:
1. `U_e2e_user_001` から再度 `TST-0001` を送信
2. → 「ℹ️ 既に登録済みです。そのままご利用いただけます！」のメッセージ

**期待される DB 更新**:

| テーブル | 検証内容 |
|---------|---------|
| `invite_code_usages` | レコード数は変化なし（新規 usage は作成されない） |
| `user_service_statuses` | `intake_completed = 1` のまま |
| `invite_codes` (TST-0001) | `use_count = 1` のまま |

---

### TC4: 別ユーザーが使用済みコードを入力→使用上限エラー

**目的**: `CODE_EXHAUSTED` が正しく返ること

**ステップ**:
1. `U_e2e_user_004` が follow → 招待コード入力を促される
2. `TST-0001`（TC1 で使用済み、max_uses=1）を送信
3. → 「⚠️ この招待コードは使用上限に達しています」メッセージ

**期待される DB 更新**:

| テーブル | 検証内容 |
|---------|---------|
| `invite_code_usages` | `U_e2e_user_004` のレコードなし |
| `user_service_statuses` | `intake_completed = 0` or レコードなし |

---

### TC5: 体重 65.5kg 送信→body_metrics / daily_logs 反映

**目的**: 体重パターン検出と DB 書き込みの正確性

**前提**: `U_e2e_user_005` が `TST-0005` で問診完了済み

**ステップ**:
1. 問診完了後の `U_e2e_user_005` からテキスト `65.5kg` を送信
2. → 「体重 65.5kg を記録しました ✅」メッセージ

**期待される DB 更新**:

| テーブル | カラム | 値 |
|---------|--------|-----|
| `daily_logs` | `user_account_id` | 今日の日付でレコードが存在 |
| `body_metrics` | `weight_kg` | `65.5` |
| `body_metrics` | `daily_log_id` | 今日の daily_logs に紐づく |

**WEIGHT_PATTERN**: `/(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|ｋｇ|キロ|Kg|KG)/i`

---

### TC6: 食事写真→解析→確定→meal_entries 登録

**目的**: 画像受信→解析→pending→確定フローの完走

**前提**: `U_e2e_user_006` が `TST-0006` で問診完了済み

**ステップ**:
1. DB に直接 pending 状態を作成:
   - `conversation_messages` にダミー画像メッセージ
   - `message_attachments` にダミー添付ファイル（FK 制約対応）
   - `image_intake_results` に pending レコード (`applied_flag = 0`)
   - `bot_mode_sessions` を `pending_image_confirm` に設定
2. テキスト `確定` 送信
3. → 「✅ 食事記録を保存しました！」メッセージ

**期待される DB 更新**:

| テーブル | カラム | 値 |
|---------|--------|-----|
| `image_intake_results` | `applied_flag` | `1` (confirmed) |
| `daily_logs` | | 今日分が作成 |
| `meal_entries` | `confirmation_status` | `confirmed` |
| `meal_entries` | `calories_kcal` | `550` |
| `meal_entries` | `protein_g` | `35` |
| `meal_entries` | `fat_g` | `12` |
| `meal_entries` | `carbs_g` | `65` |
| `bot_mode_sessions` | `current_step` | `pending_image_confirm` が削除 |

**注意**: ローカル環境では OpenAI API がダミーのため、画像解析自体は失敗する。
そのため DB に直接 `image_intake_results` と pending セッションを挿入し、確定フローのみテストする。
FK チェーン (`image_intake_results → message_attachments → conversation_messages → conversation_threads`) を正しく構築すること。

---

### TC7: 食事写真→解析→取消→pending 削除

**目的**: 画像取消フローの正確性

**前提**: `U_e2e_user_007` が `TST-0007` で問診完了済み

**ステップ**:
1. TC6 と同様に pending 状態を DB に作成
2. テキスト `取消` 送信
3. → 「🗑 この記録を取り消しました」メッセージ

**期待される DB 更新**:

| テーブル | カラム | 値 |
|---------|--------|-----|
| `image_intake_results` | `applied_flag` | `2` (discarded) |
| `meal_entries` | | 新規 confirmed レコードなし |
| `bot_mode_sessions` | | pending セッションがクリア |

**IMAGE_CANCEL_KEYWORDS**: `['取消', 'キャンセル', 'cancel', 'いいえ', 'no', 'やめる', '削除']`

---

### TC8: 相談モード入→質問→AI応答→記録モード戻り

**目的**: consult モード切替・AI 応答・record モード復帰の一連フロー

**前提**: `U_e2e_user_008` が `TST-0008` で問診完了済み

**ステップ**:
1. テキスト `相談モード` 送信 → 「💬 相談モードに切り替えました」
2. テキスト `ダイエット中に間食していいですか？` 送信
3. → AI 応答（OpenAI ダミーのため失敗する可能性あり。エラーメッセージでも可）
4. テキスト `記録モード` 送信 → 「📝 記録モードに切り替えました」

**期待される DB 更新**:

| テーブル | カラム | 検証内容 |
|---------|--------|---------|
| `conversation_threads` | `current_mode` | `consult` → `record` と遷移 |
| `conversation_messages` | `sender_type = 'user'` | 間食に関するメッセージが保存 |

**SWITCH_TO_CONSULT**: `['相談モード', '相談にして', '相談する']`
**SWITCH_TO_RECORD**: `['記録モード', '記録にして', '記録する', '戻る']`

---

### TC9: Rich Menu 6ボタン全操作フロー

**目的**: 各 Rich Menu ボタンのテキストトリガーが正しく処理されること

**前提**: `U_e2e_user_009` が `TST-0009` で問診完了済み

**ステップ**:
1. `記録モード` → 「📝 記録モードに切り替えました」
2. `写真を送る` → 「📷 食事の写真を送ってください！」
3. `体重記録` → 「⚖️ 体重を入力してください！」
4. `相談モード` → 「💬 相談モードに切り替えました」
5. `ダッシュボード` → URI action（webhook テスト対象外）
6. `記録モード` → record に戻す
7. `問診やり直し` → 問診 Q1 が送信される

**期待される DB 更新**:

| テーブル | カラム | 検証内容 |
|---------|--------|---------|
| `conversation_threads` | `current_mode` | `相談モード` 後: `consult` |
| `user_service_statuses` | `intake_completed` | `問診やり直し` 後: `0` にリセット |
| `bot_mode_sessions` | `current_mode` | `問診やり直し` 後: `intake` |
| `bot_mode_sessions` | `current_step` | `問診やり直し` 後: `intake_nickname` (Q1) |

---

## LIFF / admin / superadmin UI 反映

| 画面 | TC | 期待される反映 |
|------|-----|--------------|
| LIFF ダッシュボード | TC1 | ユーザープロファイル（ニックネーム、目標等）が表示 |
| LIFF ダッシュボード | TC5 | 体重グラフに 65.5kg がプロット |
| LIFF ダッシュボード | TC6 | 食事一覧に昼食（550kcal）が表示 |
| Admin ユーザー管理 | TC1 | 新規ユーザー（テスト太郎）がリストに表示 |
| Admin 招待コード | TC1 | TST-0001 の use_count が 1 に |
| Admin ユーザー管理 | TC8 | 会話履歴に相談メッセージが表示 |
| Superadmin | TC1-9 | 全アカウント横断でユーザー数が増加 |

---

## 期待される DB 更新一覧

| テストケース | テーブル | 検証内容 |
|-------------|---------|---------|
| TC1 | `invite_code_usages` | 1件作成 |
| TC1 | `user_profiles` | 全フィールド保存（nickname, gender, height_cm, etc.） |
| TC1 | `intake_answers` | 9件 |
| TC1 | `user_service_statuses` | `intake_completed = 1` |
| TC1 | `body_metrics` | 初期体重 75kg 記録 |
| TC1 | `invite_codes` | `use_count = 1` |
| TC2 | `bot_mode_sessions` | intake → 途中ステップ保持 → 完了 |
| TC2 | `intake_answers` | 途中まで保存→最終的に 9件 |
| TC3 | `invite_code_usages` | 変化なし |
| TC4 | `invite_code_usages` | 新規レコードなし |
| TC5 | `daily_logs` | 今日分作成 |
| TC5 | `body_metrics` | `weight_kg = 65.5` |
| TC6 | `image_intake_results` | `applied_flag = 1` |
| TC6 | `meal_entries` | confirmed, calories_kcal=550 |
| TC7 | `image_intake_results` | `applied_flag = 2` |
| TC7 | `meal_entries` | confirmed レコードなし |
| TC8 | `conversation_threads` | mode: consult → record |
| TC8 | `conversation_messages` | user + bot メッセージ |
| TC9 | `user_service_statuses` | `intake_completed → 0` |
| TC9 | `bot_mode_sessions` | intake モード、intake_nickname ステップ |

---

## 修正履歴

### 2026-03-13 修正

1. **招待コードプレフィックスを TST- に統一** (`TEST-XXXX` → `TST-XXXX`)
   - 正規表現 `[A-Z]{3}-\d{4}` に合致する3文字プレフィックスに変更
2. **intake_forms テーブルに `default_intake` レコードを追加**
   - `intake_answers.intake_form_id = 'default_intake'` の FK 制約を解消
   - `seed.sql` と `tests/e2e-seed.sql` の両方に追加
3. **TC6/TC7 の FK チェーン構築を修正**
   - `image_intake_results.message_attachment_id` → `message_attachments.id` → `conversation_messages.id` の完全な FK チェーンを構築
   - テスト用のダミー `conversation_messages` と `message_attachments` レコードを先に作成
4. **seedDatabase を HTTP 経由に完全移行**
   - wrangler プロセス spawn を廃止し、`/api/test/exec` 経由で全データを投入
   - タイムアウトリスクの排除
5. **テスト結果**: 全77テスト PASS（97.6秒）

---

## 実行方法

```bash
# 1. サーバー起動（PM2）
cd /home/user/webapp && npm run build && pm2 restart all

# 2. 基盤データ投入（初回のみ）
cd /home/user/webapp && npx wrangler d1 execute diet-bot-production --local --file=./seed.sql

# 3. テスト実行（seed + cleanup は自動）
cd /home/user/webapp && node tests/e2e-line-flow.mjs

# 4. テスト実行（PM2ログをクリアしてから）
cd /home/user/webapp && pm2 flush && node tests/e2e-line-flow.mjs
```

### ファイル構成

| ファイル | 説明 |
|---------|------|
| `tests/e2e-line-flow.mjs` | E2E テスト実行スクリプト |
| `tests/e2e-seed.sql` | E2E テスト用 seed データ |
| `seed.sql` | 基盤 seed データ（accounts, line_channels, intake_forms 等） |
| `docs/08_E2E_LINEテストケース.md` | 本ドキュメント |

---

## 判定基準

| 状態 | 判定 | アクション |
|------|------|---------|
| **全 TC PASS** | ✅ 本番デプロイ可 | `npm run deploy:prod` |
| **TC1-4 いずれか FAIL** | ❌ 接続・問診フロー | process-line-event.ts / intake-flow.ts を修正 |
| **TC5 FAIL** | ❌ 体重記録フロー | body-metrics-repo.ts / handleRecordText を修正 |
| **TC6-7 FAIL** | ❌ 画像確定/取消フロー | image-confirm-handler.ts を修正 |
| **TC8 FAIL (AI 関連)** | ⚠️ 条件付き OK | OpenAI 接続エラーは本番で別途確認。DB 遷移が正しければ OK |
| **TC9 FAIL** | ❌ Rich Menu | テキストトリガーのハンドリング漏れ → process-line-event.ts を修正 |
