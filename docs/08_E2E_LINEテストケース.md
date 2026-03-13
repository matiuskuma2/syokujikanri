# E2E LINE 会話フロー テストケース仕様書

## 概要

diet-bot の LINE 会話フロー全体を End-to-End でテストする。
webhook エンドポイントに LINE 互換のペイロードを直接 POST し、
DB 状態遷移・LINE 応答メッセージ・モードセッション遷移を検証する。

## テスト方針

- **署名検証**: テスト用リクエストでは `X-Line-Signature` を正しいHMAC-SHA256署名で生成
- **LINE API モック不要**: LINE reply/push API はダミートークンのため 4xx が返るが、
  webhook 処理自体は完走するため DB 状態を検証の主軸とする
- **テストデータの独立性**: 各テストケースで固有の `lineUserId` (`U_e2e_*`) を使用し、相互干渉を防ぐ
- **DB アクセス高速化**: `/api/test/query` (HTTP) 経由でクエリを実行し、wrangler プロセス起動を回避

## 前提条件

| 項目 | 値 |
|------|-----|
| ローカルサーバー | `http://localhost:3000` |
| Webhook URL | `POST /api/webhooks/line` |
| テスト用DB API | `POST /api/test/query`, `POST /api/test/exec` |
| LINE_CHANNEL_SECRET | `.dev.vars` の値 (`dummy_secret_for_local_dev`) |
| LINE_CHANNEL_ID | `.dev.vars` の値 (`ch_default_replace_me`) |
| CLIENT_ACCOUNT_ID | `acc_client_00000000000000000000000000000001` |
| テスト用招待コード | `TST-0001` 〜 `TST-0009`（E2E seed で自動投入） |
| 基盤データ | `seed.sql` から自動投入（accounts, line_channels, intake_forms 等） |

### 環境セットアップ

テストスクリプトが自動的に以下を行う:

1. **基盤データ確認**: `accounts` テーブルにクライアントアカウントが無ければ `seed.sql` を投入
2. **line_channels 整合性修正**: `channel_id` を `.dev.vars` の `LINE_CHANNEL_ID` と一致させる
3. **E2E データクリーンアップ**: `U_e2e_*` パターンの全テストデータを削除
4. **招待コード投入**: `TST-0001`〜`TST-0009` を HTTP 経由で INSERT

## テストユーザー

| ユーザーID | 用途 |
|-----------|------|
| `U_e2e_user_001` | TC1: 新規ユーザー（問診完走）/ TC3: コード再送テスト |
| `U_e2e_user_002` | TC2: 問診途中離脱→再開 |
| `U_e2e_user_004` | TC4: 別ユーザー使用済みコード |
| `U_e2e_user_005` | TC5: 体重記録 |
| `U_e2e_user_006` | TC6: 食事写真→確定 |
| `U_e2e_user_007` | TC7: 食事写真→取消 |
| `U_e2e_user_008` | TC8: 相談モード |
| `U_e2e_user_009` | TC9: Rich Menu 全ボタン |

## 招待コード

| コード | ID | max_uses | 用途 |
|--------|-----|----------|------|
| `TST-0001` | `ic_e2e_001` | 1 | TC1 新規登録用（TC4 で使用上限テスト） |
| `TST-0002` | `ic_e2e_002` | 1 | TC2 途中離脱→再開 |
| `TST-0003` | `ic_e2e_003` | 1 | TC3 （未使用、予備） |
| `TST-0005` | `ic_e2e_005` | 1 | TC5 体重記録用 |
| `TST-0006` | `ic_e2e_006` | 1 | TC6 食事写真（確定）用 |
| `TST-0007` | `ic_e2e_007` | 1 | TC7 食事写真（取消）用 |
| `TST-0008` | `ic_e2e_008` | 1 | TC8 相談モード用 |
| `TST-0009` | `ic_e2e_009` | 1 | TC9 Rich Menu用 |

> **注意**: コードは3文字プレフィックス `TST-` + 4桁数字。`INVITE_CODE_PATTERN = /^([A-Z]{3}-\d{4})$/i` にマッチ。

---

## テストケース一覧

### TC1: 新規ユーザーが未使用コードを入力→問診完走

**目的**: フォロー→招待コード→問診 Q1〜Q9 が止まらず完走すること

**ステップ**:
1. follow イベント送信 → 招待コード入力を促すメッセージ
2. テキスト `TST-0001` 送信 → 登録完了 + Q1 送信
3. Q1: `テスト太郎` → Q2 へ (intake_gender)
4. Q2: `男性` → Q3 へ (intake_age_range)
5. Q3: `30s` → Q4 へ (intake_height)
6. Q4: `170` → Q5 へ (intake_current_weight)
7. Q5: `75` → Q6 へ (intake_target_weight)
8. Q6: `65` → Q7 へ (intake_goal)
9. Q7: `夏までに痩せたい` → Q8 へ (intake_concerns)
10. Q8: `お腹まわり` → タグ追加（同じ Q8 intake_concerns に留まる）
11. Q8: `次へ` → Q9 へ (intake_activity)
12. Q9: `moderate` → 完了メッセージ (mode = record)

**検証ポイント** (32項目):

| テーブル | 検証内容 |
|---------|---------|
| `line_users` | レコード作成（line_user_id = U_e2e_user_001） |
| `invite_code_usages` | レコード 1件作成 |
| `user_service_statuses` | `bot_enabled = 1`, 最終的に `intake_completed = 1` |
| `bot_mode_sessions` | 各ステップで `current_step` が正しく遷移 |
| `user_profiles` | nickname=テスト太郎, gender=male, height_cm=170, current_weight_kg=75, target_weight_kg=65, activity_level=moderate |
| `intake_answers` | 9件の回答 |
| `invite_codes` | `use_count = 1` |

**LINE 応答メッセージ**:
- follow: 「🎉 友だち追加ありがとうございます！」
- 招待コード: 「✅ 招待コード「TST-0001」で登録が完了しました！」+ Q1
- 各Q: 次の質問テキスト + Quick Reply
- Q9回答後: 「登録が完了しました！...テスト太郎さん...10kg 減量...」

---

### TC2: 問診途中離脱→コード再送→途中から再開

**目的**: セッションが保持され、P6（常に現在の質問を返す）が機能すること

**ステップ**:
1. follow + コード `TST-0002` → Q1
2. Q1: `テスト花子` → Q2
3. Q2: `女性` → Q3
4. Q3: `20s` → Q4 (intake_height)
5. （離脱: 何も送らない）
6. テキスト `TST-0002`（同じコードを再送）→ Q4 の質問がそのまま返る
7. Q4: `160` → Q5 へ
8. Q5〜Q9: `55`, `50`, `健康になりたい`, `次へ`, `light` で完走

**検証ポイント** (3項目):

| テーブル | 検証内容 |
|---------|---------|
| `bot_mode_sessions` | 離脱前: `current_step = intake_height` |
| `bot_mode_sessions` | コード再送後: `current_step = intake_height`（変化なし） |
| `user_service_statuses` | 最終: `intake_completed = 1` |

**LINE 応答メッセージ**:
- コード再送: P6 により Q4 の質問テキスト「身長を教えてください（cm）」が直接返る
- 「続けますか？」のプロンプトは表示されない（SSOT §6.1 準拠）

---

### TC3: 問診完了後に同じコード再送→使い方ガイドのみ

**目的**: Pattern B（問診完了済み＋コード再送）で利用案内が返ること

**ステップ**:
1. TC1 で `TST-0001` を使い問診完了した `U_e2e_user_001` がいる状態
2. `U_e2e_user_001` から再度 `TST-0001` を送信
3. → 利用案内メッセージが返る

**検証ポイント** (3項目):

| テーブル | 検証内容 |
|---------|---------|
| HTTP | 200 OK |
| `invite_code_usages` | レコード数は変化なし（新規 usage は作成されない） |
| `user_service_statuses` | `intake_completed = 1` のまま |

**LINE 応答メッセージ**:
- 「ℹ️ 既に登録済みです。そのままご利用いただけます！...」

---

### TC4: 別ユーザーが使用済みコードを入力→使用上限エラー

**目的**: `CODE_EXHAUSTED` が正しく返ること

**ステップ**:
1. `U_e2e_user_004` が follow → 招待コード入力を促される
2. `TST-0001`（TC1 で使用済み、max_uses=1, use_count=1）を送信
3. → 「この招待コードは使用上限に達しています」メッセージ

**検証ポイント** (3項目):

| テーブル | 検証内容 |
|---------|---------|
| HTTP | 200 OK |
| `invite_code_usages` | `U_e2e_user_004` のレコードなし |
| `user_service_statuses` | `intake_completed = 0` または レコードなし |

**LINE 応答メッセージ**:
- 「⚠️ この招待コードは使用上限に達しています。担当者にお問い合わせください。」

---

### TC5: 体重 65.5kg 送信→body_metrics / daily_logs 反映

**目的**: 体重パターン検出と DB 書き込みの正確性

**前提**: `setupCompletedUser()` で follow + `TST-0005` + 問診9問完走済み

**ステップ**:
1. テキスト `65.5kg` を送信
2. → 「体重 65.5kg を記録しました ✅」メッセージ

**検証ポイント** (4項目):

| テーブル | 検証内容 |
|---------|---------|
| セットアップ | `intake_completed = 1` |
| HTTP | 200 OK |
| `body_metrics` | `weight_kg = 65.5`（JOIN daily_logs で user_account_id 紐付き） |
| `daily_logs` | 今日の日付でレコードが存在 |

**LINE 応答メッセージ**:
- 「体重 65.5kg を記録しました ✅ 他に記録することはありますか？」+ Quick Reply

**LIFF/管理画面での反映**:
- ユーザーダッシュボード: 体重チャートに 65.5kg が反映
- 管理画面: ユーザー詳細で最新体重が 65.5kg

---

### TC6: 食事写真→解析→確定→meal_entries 登録

**目的**: 画像受信→解析→pending→確定フローの完走

**前提**: `setupCompletedUser()` で問診完走済み

**ステップ**:
1. DB に直接テストデータを作成:
   - `conversation_messages` (image タイプ)
   - `message_attachments` (FK チェーン)
   - `image_intake_results` (applied_flag=0, proposed_action: lunch 550kcal)
   - `bot_mode_sessions` (current_step=pending_image_confirm)
2. テキスト `確定` 送信
3. → 「✅ 食事記録を保存しました！」メッセージ

**検証ポイント** (5項目):

| テーブル | 検証内容 |
|---------|---------|
| HTTP | 200 OK |
| `image_intake_results` | `applied_flag = 1` (confirmed) |
| `meal_entries` | 新規レコード作成（`confirmation_status = 'confirmed'`） |
| `meal_entries` | `calories_kcal = 550` |
| `bot_mode_sessions` | `pending_image_confirm` セッションがクリア済み |

**DB テストデータ構造**:
```json
{
  "action": "create_or_update_meal_entry",
  "meal_type": "lunch",
  "meal_text": "テスト昼食（サラダチキン、白米、味噌汁）",
  "calories_kcal": 550,
  "protein_g": 35,
  "fat_g": 12,
  "carbs_g": 65
}
```

**注意**: ローカル環境では OpenAI API がダミーのため、画像解析は実行できない。
TC6 は DB に直接 `image_intake_results` を作成し、確定フローのみをテストする。

**LIFF/管理画面での反映**:
- ユーザーダッシュボード: 食事一覧に昼食 550kcal が表示
- 管理画面: ユーザー詳細の本日の食事に反映

---

### TC7: 食事写真→解析→取消→pending 削除

**目的**: 画像取消フローの正確性

**前提**: `setupCompletedUser()` で問診完走済み

**ステップ**:
1. TC6 と同様に pending 状態をDB直接作成（`U_e2e_user_007`, dinner 700kcal）
2. テキスト `取消` 送信
3. → 「🗑 この記録を取り消しました。」メッセージ

**検証ポイント** (4項目):

| テーブル | 検証内容 |
|---------|---------|
| HTTP | 200 OK |
| `image_intake_results` | `applied_flag = 2` (discarded) |
| `meal_entries` | `confirmed` なレコードは作成されていない |
| `bot_mode_sessions` | セッションクリア |

---

### TC8: 相談モード入→質問→AI応答→記録モード戻り

**目的**: consult モード切替・AI 応答・record モード復帰の一連フロー

**前提**: `setupCompletedUser()` で問診完走済み

**ステップ**:
1. テキスト `相談モード` 送信 → 「💬 相談モードに切り替えました。」
2. テキスト `ダイエット中に間食していいですか？` 送信
3. → AI 応答（OpenAI ダミーのためエラー応答の可能性あり。DB 遷移を主に検証）
4. テキスト `記録モード` 送信 → 「📝 記録モードに切り替えました。」

**検証ポイント** (7項目):

| テーブル | 検証内容 |
|---------|---------|
| セットアップ | `intake_completed = 1` |
| HTTP | 各イベント 200 OK |
| `conversation_threads` | `current_mode = 'consult'`（切替後） |
| `conversation_messages` | ユーザー発言「間食」を含むメッセージが保存 |
| `conversation_threads` | `current_mode = 'record'`（戻り後） |

**LINE 応答メッセージ**:
- 「💬 相談モードに切り替えました。お気軽にご相談ください！」
- AI 応答テキスト（またはエラーメッセージ）
- 「📝 記録モードに切り替えました。体重・食事・運動などを記録しましょう！」

**LIFF/管理画面での反映**:
- 管理画面: 会話ログに consult モードの質問・回答が表示

---

### TC9: Rich Menu 6ボタン全操作フロー

**目的**: 各 Rich Menu ボタンのテキストトリガーが正しく処理されること

**前提**: `setupCompletedUser()` で問診完走済み

**ステップ**:
1. `記録モード` → 200 OK
2. `写真を送る` → 200 OK（「📷 食事の写真を送ってください！」）
3. `体重記録` → 200 OK（「⚖️ 体重を入力してください！」）
4. `相談モード` → 200 OK（「💬 相談モードに切り替えました」）
5. `ダッシュボード` → URI action のためスキップ（webhook テスト対象外）
6. `記録モード` → record に戻す
7. `問診やり直し` → intake_completed=0 にリセット、Q1 送信

**検証ポイント** (10項目):

| テーブル | 検証内容 |
|---------|---------|
| セットアップ | `intake_completed = 1` |
| HTTP | 各ボタン 200 OK |
| `conversation_threads` | btn4 後: `current_mode = 'consult'` |
| `user_service_statuses` | 問診やり直し後: `intake_completed = 0` |
| `bot_mode_sessions` | 問診やり直し後: `current_mode = 'intake'` |
| `bot_mode_sessions` | 問診やり直し後: `current_step = 'intake_nickname'` |

**Rich Menu ボタンマッピング**:

| ボタン | 送信テキスト | アクション |
|--------|-------------|-----------|
| 1 | `記録モード` | record モードに切替 |
| 2 | `写真を送る` | 画像送信案内を返信 |
| 3 | `体重記録` | 体重入力案内を返信 |
| 4 | `相談モード` | consult モードに切替 |
| 5 | (URI) | LIFF ダッシュボードを開く |
| 6 | `問診やり直し` | intake_completed リセット + Q1 送信 |

---

## 期待される DB 更新一覧

| テストケース | テーブル | 検証内容 |
|-------------|---------|---------|
| TC1 | `line_users` | 新規レコード作成 |
| TC1 | `invite_code_usages` | 1件作成 |
| TC1 | `invite_codes` | `use_count = 1` |
| TC1 | `user_service_statuses` | `bot_enabled=1`, `intake_completed=1` |
| TC1 | `user_accounts` | 新規レコード（line_user_id → client_account_id 紐付け） |
| TC1 | `user_profiles` | 全9フィールド保存 |
| TC1 | `intake_answers` | 9件（nickname〜activity_level） |
| TC1 | `bot_mode_sessions` | 各ステップで遷移、最後にクリア |
| TC2 | `bot_mode_sessions` | intake → 途中ステップ保持 → 再開 |
| TC2 | `intake_answers` | 途中まで保存→最終的に9件 |
| TC2 | `user_service_statuses` | 最終: `intake_completed=1` |
| TC3 | `invite_code_usages` | 変化なし |
| TC4 | `invite_code_usages` | 新規なし |
| TC4 | `invite_codes` | `use_count` 変化なし |
| TC5 | `daily_logs` | 今日分作成 |
| TC5 | `body_metrics` | `weight_kg=65.5` |
| TC6 | `image_intake_results` | `applied_flag=1` |
| TC6 | `meal_entries` | confirmed レコード（550kcal） |
| TC7 | `image_intake_results` | `applied_flag=2` |
| TC7 | `meal_entries` | confirmed なし |
| TC8 | `conversation_threads` | `current_mode`: consult → record 遷移 |
| TC8 | `conversation_messages` | user 発言保存 |
| TC9 | `user_service_statuses` | `intake_completed=0`（問診やり直し後） |
| TC9 | `bot_mode_sessions` | `current_mode=intake`, `current_step=intake_nickname` |

---

## LIFF / 管理画面 / SuperAdmin での反映

| テストケース | 画面 | 反映内容 |
|-------------|------|---------|
| TC1 | 管理画面: ユーザー一覧 | テスト太郎が新規ユーザーとして表示 |
| TC1 | 管理画面: ユーザー詳細 | プロフィール情報（性別、身長、体重、目標等） |
| TC1 | LIFF: ダッシュボード | プロフィール欄にニックネーム表示 |
| TC5 | LIFF: 体重チャート | 65.5kg がプロット |
| TC5 | 管理画面: ユーザー詳細 | 最新体重 65.5kg |
| TC6 | LIFF: 食事一覧 | 昼食 550kcal が表示 |
| TC6 | 管理画面: ユーザー詳細 | 本日の食事に反映 |
| TC8 | 管理画面: 会話ログ | consult モードの Q&A が表示 |

> **注意**: LIFF/管理画面の検証はブラウザ手動テスト。E2E スクリプトでは DB 状態のみ検証。

---

## 実行方法

```bash
# 1. サーバー起動（PM2）
cd /home/user/webapp && npm run build && pm2 restart all

# 2. テスト実行（seed は自動で行われる）
cd /home/user/webapp && node tests/e2e-line-flow.mjs

# ※ 基盤データ (seed.sql) + E2E 招待コードはテストスクリプト内で自動投入される
# ※ DB リセットが必要な場合:
cd /home/user/webapp && rm -rf .wrangler/state/v3/d1
cd /home/user/webapp && npx wrangler d1 migrations apply diet-bot-production --local
```

## テスト結果（最新実行: 2026-03-13）

```
  合計: 79
  ✅ PASS: 79
  ❌ FAIL: 0
  ⏱  所要時間: 100.7s

🎉 全テスト PASS！本番デプロイ可能
```

## 判定基準

| カテゴリ | 判定 |
|---------|------|
| **全 TC PASS** | ✅ 本番デプロイ可 |
| **TC1-4 のいずれか FAIL** | 🔴 接続・問診フローにバグあり → 修正必須 |
| **TC5 FAIL** | 🔴 体重記録フローにバグあり → 修正必須 |
| **TC6-7 のいずれか FAIL** | 🔴 画像確認/取消フローにバグあり → 修正必須 |
| **TC8 FAIL (AI 応答のみ)** | 🟡 OpenAI 接続エラーは本番で別途確認。DB 遷移が正しければ OK |
| **TC9 FAIL** | 🔴 Rich Menu テキストトリガーのハンドリング漏れ → process-line-event.ts を修正 |

## 修正履歴

| 日付 | 修正内容 |
|------|---------|
| 2026-03-13 | 招待コードを `TEST-XXXX` → `TST-XXXX`（3文字プレフィックス）に変更 |
| 2026-03-13 | E2E seed で `seed.sql`（基盤データ）を自動投入するよう改善 |
| 2026-03-13 | `line_channels.channel_id` を `.dev.vars` の `LINE_CHANNEL_ID` と自動同期 |
| 2026-03-13 | TC6/TC7 の FK チェーン対応（conversation_messages → message_attachments → image_intake_results） |
| 2026-03-13 | TC5-TC9 共通セットアップ関数 `setupCompletedUser()` を導入 |
| 2026-03-13 | 全79テスト PASS 達成 |
