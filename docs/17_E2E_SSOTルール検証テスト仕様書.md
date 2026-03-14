# E2E SSOT ルール検証テスト仕様書

> **正本**: docs/15_実装前確定ルールSSOT.md の全ルール (R1〜R22) を実機で検証する  
> **最終更新**: 2026-03-14  
> **前提**: TC1〜TC9 (docs/08) は合格済み。本文書は SSOT v3.0 固有の 9 ケースを追加  
> **テストスクリプト**: `tests/e2e-ssot-rules.mjs`

---

## 0. テスト方針

| 項目 | 値 |
|------|-----|
| ローカルサーバー | `http://localhost:3000` |
| Webhook URL | `POST /api/webhooks/line` |
| テスト DB API | `POST /api/test/query`, `POST /api/test/exec` |
| LINE_CHANNEL_SECRET | `dummy_secret_for_local_dev` |
| CLIENT_ACCOUNT_ID | `acc_client_00000000000000000000000000000001` |
| テスト招待コード | `SST-0001` 〜 `SST-0009` |

### テストユーザー

| ユーザーID | 用途 | 招待コード |
|-----------|------|-----------|
| `U_ssot_user_001` | SSOT-1: 体重即時保存 58.5kg | `SST-0001` |
| `U_ssot_user_002` | SSOT-2: 昨日の夕食ラーメン（日付解決） | `SST-0002` |
| `U_ssot_user_003` | SSOT-3: ラーメン食べた（明確化トリガー） | `SST-0003` |
| `U_ssot_user_004` | SSOT-4: 相談中に体重72.1kg（副次記録保存） | `SST-0004` |
| `U_ssot_user_005` | SSOT-5: 朝食→夕食変更（correction_history） | `SST-0005` |
| `U_ssot_user_006` | SSOT-6: 同日同区分追記 | `SST-0006` |
| `U_ssot_user_007` | SSOT-7: pending中に画像→cancel | `SST-0007` |
| `U_ssot_user_008` | SSOT-8: pending中に相談モード→cancel | `SST-0008` |
| `U_ssot_user_009` | SSOT-9: 画像確認中テキスト修正（鮭→卵焼き） | `SST-0009` |

---

## 1. SSOT-1: 体重 58.5kg → 即時保存 (R2)

**対応ルール**: R2 (canSaveImmediately), R18 (phase_a_result 監査ログ), R19 (phase_c_result 監査ログ)

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `58.5kg`
3. 待機: 2000ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | body_metrics | weight_kg | 58.5 |
| 2 | daily_logs | log_date | 今日 (JST YYYY-MM-DD) |
| 3 | conversation_messages | sender_type='bot', raw_text LIKE '%58.5kg%' | 存在する |
| 4 | conversation_messages | sender_type='bot', raw_text LIKE '%記録しました%' | 存在する |

---

## 2. SSOT-2: 昨日の夕食ラーメン → 日付解決して保存 (R5)

**対応ルール**: R5 (日付解釈), R7 (食事区分解釈), R2 (即時保存の3要素確定)

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `昨日の夕食 ラーメン`
3. 待機: 2000ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | meal_entries | meal_type | `dinner` |
| 2 | meal_entries | meal_text LIKE '%ラーメン%' | 存在する |
| 3 | daily_logs | log_date | 昨日の日付 (JST) |
| 4 | conversation_messages | sender_type='bot', raw_text LIKE '%夕食%' | 存在する |

---

## 3. SSOT-3: ラーメン食べた → 明確化トリガー (R3, Phase B)

**対応ルール**: R3 (確認付き保存), R7 (meal_type=timestamp → needs_confirmation), Phase B 起動

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `ラーメン食べた`
3. 待機: 2000ms
4. 結果分岐:
   - **パターンA**: AI が timestamp で日付・区分を推定 → 確認付き保存 (R3)
   - **パターンB**: AI が日付/区分を不明と判定 → Phase B 明確化質問開始

**検証ポイント (パターンA: 確認付き保存)**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | meal_entries | meal_text LIKE '%ラーメン%' | 存在する |
| 2 | conversation_messages | sender_type='bot', raw_text LIKE '%推定しました%' | 存在する (timestamp 確認文) |

**検証ポイント (パターンB: 明確化)**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | pending_clarifications | status='asking' | 存在する |
| 2 | pending_clarifications | current_field | 'target_date' または 'meal_type' |
| 3 | meal_entries | ラーメン | 存在しない (未保存) |

---

## 4. SSOT-4: 相談中に「体重72.1kgです」→ 相談応答 + 副次記録保存 (R1-3)

**対応ルール**: R1-3/R1-6 (相談モード副次記録), CONSULT_SECONDARY_SAVE_THRESHOLD=0.8

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `相談モード`
3. 待機: 800ms
4. テキスト送信: `最近体重72.1kgなんだけど、どうすれば減りますか？`
5. 待機: 3000ms (AI応答を待つ)

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | conversation_threads | current_mode | 'consult' |
| 2 | body_metrics | weight_kg | 72.1 (副次意図として保存される場合) |
| 3 | conversation_messages | sender_type='bot', raw_text LIKE '%保存しました%' | 副次記録保存時に存在 |
| 4 | conversation_messages | sender_type='bot' (最新) | AI相談応答が存在する |

**注意**: AIの解釈に依存するため、体重が保存されない場合も正常。重要なのは:
- 相談応答が必ず返ること
- 保存された場合、BOT返信末尾に「📝 ※会話中の記録情報も保存しました」があること

---

## 5. SSOT-5: 朝食→夕食に変更 → correction_history 記録 (R8, R9)

**対応ルール**: R8 (修正対象特定), R9 (correction_history 必須項目)

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `今日の朝食 トースト`
3. 待機: 2000ms
4. テキスト送信: `朝食じゃなくて夕食だった`
5. 待機: 2000ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | meal_entries (Step 2後) | meal_type='breakfast', meal_text LIKE '%トースト%' | 存在する |
| 2 | meal_entries (Step 4後) | meal_type='dinner' | 存在する (変更後) |
| 3 | correction_history | correction_type='meal_type_change' | 存在する |
| 4 | correction_history | old_value_json LIKE '%breakfast%' | 存在する |
| 5 | correction_history | new_value_json LIKE '%dinner%' | 存在する |
| 6 | correction_history | target_table='meal_entries' | 存在する |

---

## 6. SSOT-6: 同日同区分に追記 → 既存/新規で追記 (R4)

**対応ルール**: R4 (同日同区分追記), R9 (correction_type='append')

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `今日の朝食 トースト`
3. 待機: 2000ms
4. テキスト送信: `今日の朝食 コーヒー`
5. 待機: 2000ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | meal_entries (Step 2後) | meal_text | 'トースト' (単独) |
| 2 | meal_entries (Step 4後) | meal_text | 'トースト / コーヒー' (追記) |
| 3 | meal_entries | 同日同区分の件数 | 1件 (上書きではなくテキスト追記) |
| 4 | correction_history | correction_type='append' | 存在する |
| 5 | correction_history | old_value_json LIKE '%トースト%' | 存在する |
| 6 | correction_history | new_value_json LIKE '%コーヒー%' | 存在する |

---

## 7. SSOT-7: pending 中に画像送信 → pending cancel (R16, R12)

**対応ルール**: R16 (画像受信で pending cancel), R12 (1ユーザー1pending)

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. テキスト送信: `ラーメン食べた` → Phase B 開始 (pending 作成)
3. 待機: 2000ms
4. DB確認: pending_clarifications に asking レコードが存在
5. 画像イベント送信 (mock)
6. 待機: 2000ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | pending_clarifications (Step 2後) | status='asking' | 存在する |
| 2 | pending_clarifications (Step 5後) | status='cancelled' | 変更されている |
| 3 | pending_clarifications | status='asking' の件数 | 0件 |

**代替検証** (Phase B が起動しなかった場合):
- pending を DB 直接挿入してテスト
- 画像送信後に cancelled になることを検証

---

## 8. SSOT-8: pending 中に相談モード切替 → pending cancel (R16)

**対応ルール**: R16 (モード切替で pending cancel)

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. pending_clarifications に asking レコードを DB 直接挿入
3. テキスト送信: `相談モード`
4. 待機: 1500ms

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | pending_clarifications | status='cancelled' | 変更されている |
| 2 | conversation_threads | current_mode | 'consult' |
| 3 | pending_clarifications | status='asking' の件数 | 0件 |

---

## 9. SSOT-9: 画像確認中にテキスト修正「鮭→卵焼き」→ 再解析・再確認 (S3 テキスト修正)

**対応ルール**: image-confirm-handler.ts の handleImageCorrection

**ステップ**:
1. セットアップ: follow + 招待コード + 問診完走
2. DB に pending_image_confirm 状態を挿入:
   - image_intake_results (image_category='meal_photo', proposed_action_json に meal_text='鮭の塩焼き')
   - bot_mode_sessions (current_step='pending_image_confirm')
3. テキスト送信: `鮭じゃなくて卵焼きだった`
4. 待機: 3000ms (AI再解析を待つ)

**検証ポイント**:

| # | テーブル | 条件 | 期待値 |
|---|---------|------|--------|
| 1 | image_intake_results | proposed_action_json LIKE '%卵焼き%' | 修正が反映されている |
| 2 | image_intake_results | applied_flag | 0 (まだ確定されていない) |
| 3 | bot_mode_sessions | current_step | 'pending_image_confirm' (確認待ち継続) |
| 4 | conversation_messages | sender_type='bot', raw_text LIKE '%修正を反映%' | 存在する |

---

## 追加テストケース（拡張）

### SSOT-10: 深夜ルール (R6) — 深夜2時の食事報告は前日扱い

**ステップ**: timestamp を 02:00 JST に設定して食事記録 → daily_logs.log_date が前日

### SSOT-11: 未来日付 (R5) — 「明後日の朝食 パン」は拒否

**ステップ**: 未来日付のメッセージ → needs_clarification に target_date が入る

### SSOT-12: 30日前の記録 (R5) — 「先月15日の夕食 寿司」は拒否 (30日超え)

**ステップ**: 31日以上前の日付 → 拒否される

### SSOT-13: Webhook idempotency — 同一 line_message_id の二重送信

**ステップ**: 同じ message.id で2回 webhook 送信 → 2回目はスキップ (UNIQUE制約)

---

## テスト実行手順

```bash
# 1. ビルド & 起動
cd /home/user/webapp && npm run build
pm2 restart all

# 2. テスト実行
node tests/e2e-ssot-rules.mjs

# 3. 既存テストも確認
node tests/e2e-line-flow.mjs
```

---

## 合格基準

- 9ケース全て PASS
- AI 依存ケース (SSOT-3, SSOT-4, SSOT-5) は DB 状態の代替検証も許容
- correction_history に正しいレコードが残ること (R9)
- pending_clarifications の状態遷移が一方向であること (R12)
