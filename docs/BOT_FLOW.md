# BOT フロー・ステップコード定義

## 概要
LINE ユーザーが送信したメッセージを処理する BOT のフローと、
セッション管理に使用するステップコードを定義する。

---

## BOT モード一覧

| モード | 説明 | トリガー |
|---|---|---|
| `intake` | 初回ヒアリングフロー | 初回 follow イベント |
| `record` | 記録受付モード | 「記録」「体重」「食事」等のキーワード |
| `consult` | 相談モード | 「相談」「聞きたい」等のキーワード |
| `knowledge` | ナレッジ Q&A | その他の質問文 |

---

## モード切り替えロジック

```
ユーザーメッセージ受信
  │
  ├── bot_mode_sessions に有効セッションあり？
  │       YES → 現在のモードのステップを継続
  │       NO  → キーワードマッチング
  │
  └── キーワードマッチング
          ├── 「記録」「体重」「食事」「今日」→ record モード
          ├── 「相談」「聞きたい」「アドバイス」→ consult モード
          ├── 「終わり」「やめる」→ セッション終了
          └── その他 → knowledge モード（RAG 検索）
```

---

## ステップコード定義

### intake（初回ヒアリング）モード

| ステップコード | 内容 | 次のステップ |
|---|---|---|
| `intake_start` | ようこそメッセージ + 最初の質問 | `intake_waiting_nickname` |
| `intake_waiting_nickname` | ニックネーム入力待ち | `intake_waiting_gender` |
| `intake_waiting_gender` | 性別選択待ち | `intake_waiting_age_range` |
| `intake_waiting_age_range` | 年代選択待ち | `intake_waiting_height` |
| `intake_waiting_height` | 身長入力待ち | `intake_waiting_current_weight` |
| `intake_waiting_current_weight` | 現在の体重入力待ち | `intake_waiting_target_weight` |
| `intake_waiting_target_weight` | 目標体重入力待ち | `intake_waiting_goal_summary` |
| `intake_waiting_goal_summary` | 目標・動機入力待ち | `intake_waiting_concern_tags` |
| `intake_waiting_concern_tags` | 悩みタグ選択待ち | `intake_waiting_activity_level` |
| `intake_waiting_activity_level` | 活動レベル選択待ち | `intake_complete` |
| `intake_complete` | ヒアリング完了・プロフィール保存 | → record モードへ移行 |

### record（記録受付）モード

| ステップコード | 内容 | 次のステップ |
|---|---|---|
| `record_start` | 「何を記録しますか？」メニュー表示 | `record_waiting_input` |
| `record_waiting_input` | 入力待ち（テキスト or 画像） | 入力内容で分岐 |
| `record_waiting_meal_confirm` | 食事解析結果の確認待ち | `record_meal_confirmed` or `record_meal_edit` |
| `record_meal_confirmed` | 食事記録保存完了 | `record_waiting_more` |
| `record_meal_edit` | 食事内容の手動修正待ち | `record_meal_confirmed` |
| `record_waiting_weight_input` | 体重入力待ち | `record_weight_saved` |
| `record_weight_saved` | 体重保存完了 | `record_waiting_more` |
| `record_waiting_steps_input` | 歩数入力待ち | `record_steps_saved` |
| `record_steps_saved` | 歩数保存完了 | `record_waiting_more` |
| `record_waiting_water_input` | 水分量入力待ち | `record_water_saved` |
| `record_waiting_more` | 「他に記録しますか？」 | `record_start` or `record_daily_feedback` |
| `record_daily_feedback` | AI 日次フィードバック生成・送信 | セッション終了 |

### consult（相談）モード

| ステップコード | 内容 | 次のステップ |
|---|---|---|
| `consult_start` | 「何でもご相談ください」 | `consult_waiting_question` |
| `consult_waiting_question` | 質問入力待ち | `consult_answering` |
| `consult_answering` | RAG 検索 + AI 回答生成 | `consult_waiting_followup` |
| `consult_waiting_followup` | 追加質問待ち（max_turns まで） | `consult_answering` or `consult_end` |
| `consult_end` | 「お役に立てましたか？」 | セッション終了 |

---

## 質問定義マスタ（question_definitions）

| code | 質問テキスト | input_type | options |
|---|---|---|---|
| `nickname` | お名前（ニックネーム）を教えてください | text | - |
| `gender` | 性別を選んでください | select | `["女性", "男性", "その他"]` |
| `age_range` | 年代を選んでください | select | `["20代", "30代", "40代", "50代以上"]` |
| `height_cm` | 身長を入力してください（例: 160） | number | - |
| `current_weight_kg` | 現在の体重を入力してください（例: 62.5） | number | - |
| `target_weight_kg` | 目標体重を入力してください（例: 58） | number | - |
| `goal_summary` | ダイエットの目標・動機を教えてください | text | - |
| `concern_tags` | 気になること・悩みを選んでください（複数可） | select | `["食べすぎ", "運動不足", "むくみ", "便秘", "睡眠不足", "ストレス", "リバウンド"]` |
| `activity_level` | 普段の活動レベルは？ | select | `["ほぼ動かない（デスクワーク中心）", "軽く動く（週1-2回運動）", "よく動く（週3-4回運動）", "かなり動く（毎日運動・立ち仕事）"]` |

---

## キーワードトリガー定義

### record モード起動キーワード
```
体重、体重計、食事、朝食、昼食、夕食、夜ご飯、おやつ、記録、
今日、ログ、歩数、万歩、水、水分、睡眠、寝た、排便、便
```

### consult モード起動キーワード
```
相談、聞きたい、アドバイス、教えて、どうすれば、
なぜ、どうして、方法、コツ、おすすめ
```

### セッション終了キーワード
```
終わり、終了、おわり、やめる、キャンセル、ありがとう、OK、了解
```

---

## 画像分類フロー

```
画像受信
  │
  ├── OpenAI Vision で分類
  │   └── 判定: meal_photo / nutrition_label / body_scale / progress_photo / unknown
  │
  ├── meal_photo
  │   ├── 料理名候補抽出
  │   ├── 分量推定
  │   ├── PFC 推定
  │   └── 確認メッセージ送信 → record_waiting_meal_confirm
  │
  ├── nutrition_label
  │   ├── 栄養成分表テキスト抽出
  │   └── meal_entries に保存
  │
  ├── body_scale
  │   ├── 体重数値抽出
  │   └── daily_logs.weight_kg に保存
  │
  ├── progress_photo
  │   ├── R2 に保存（progress_photos テーブル）
  │   └── 「進捗写真を保存しました」返信
  │
  └── unknown
      └── 「画像の内容を確認できませんでした。テキストで教えてください」
```

---

## リマインダー・週次レポートフロー

### 日次リマインダー（毎日 08:00 JST）
```
1. active ユーザー一覧取得
2. 前日のログ未記録ユーザーを抽出
3. パーソナライズされたリマインダーメッセージ送信
```

### 週次レポート（毎週月曜 09:00 JST）
```
1. active ユーザー一覧取得
2. 先週（月〜日）のデータ集計:
   - 体重: 平均・最小・最大・前週比
   - 歩数: 合計・平均
   - 睡眠: 平均時間
   - 水分: 平均
   - 食事: 記録日数
3. AI サマリー文章生成
4. weekly_reports テーブルに保存
5. LINE で週次レポート送信
```
