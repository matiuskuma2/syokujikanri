# 技術設計チェックリスト SSOT

> **最終更新**: 2026-03-13  
> **対象**: diet-bot v2.0 実装前チェック  
> **本ドキュメントが実装前チェックの正本**。

---

## 0. 概要

v2.0 会話駆動型記録フロー実装にあたり、設計段階で確認すべき技術的論点と決定事項を一覧化する。

---

## 1. 実装前チェック項目

### 1.1 pending_clarifications の運用ルール

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C1 | 1ユーザーあたりの pending 上限 | **1件** | 新しい記録メッセージ受信時に既存 asking を cancelled にする |
| C2 | 明確化中に新しい記録テキストが来た場合 | 既存 pending を **cancelled** にし、新規を Phase A から処理 | ユーザーの「やっぱりこっちを記録したい」を優先 |
| C3 | 明確化中にモード切替コマンドが来た場合 | 既存 pending を **cancelled** にし、モード切替を実行 | モード切替はユーザーの明示的意思 |
| C4 | 明確化のタイムアウト | 24時間で **expired**（Cron） | 30分以内は次メッセージ受信時に再質問 |
| C5 | expired/cancelled の pending は物理削除するか | **しない**（論理状態管理のみ） | 監査ログとして保持。定期的な物理削除は将来検討 |

### 1.2 相談モードでの記録順序

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C6 | 相談応答と記録保存の実行順序 | **並行実行**: 相談応答生成と記録保存を同時に行い、結果を結合して返信 | 応答速度を落とさない |
| C7 | 相談応答テキストに記録情報を含めるか | **末尾に付加**: 「{相談回答}\n\n📝 ...を記録しました」 | 相談回答の邪魔をせず、記録したことを明示 |
| C8 | 記録の確信度閾値 | **0.8** | 0.8以上: 即時保存+通知、0.8未満: 確認してから保存 |

### 1.3 1メッセージ複数記録

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C9 | 1メッセージに食事+体重の情報がある場合 | intent_primary に食事、intent_secondary に体重（または逆）。**両方を Phase C で保存** | ユーザーの報告を漏らさない |
| C10 | 1メッセージに複数の食事情報がある場合 | **最初の1件を intent_primary で処理**。他は無視（将来: record_candidates で複数対応） | MVP では複雑化を避ける |

### 1.4 削除型の修正

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C11 | 削除は物理削除か論理削除か | **物理削除** + correction_history に old_value_json を保存 | meal_entries は correction_history で復元可能。daily_logs は meal_count で自動調整 |
| C12 | 削除確認は必須か | **必須**: Quick Reply で「はい/いいえ」を提示 | 誤削除防止 |

### 1.5 パーソナルメモリの管理

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C13 | メモリの UPSERT vs 管理者編集 | **UPSERT が基本**。管理者編集は Phase 2 で検討 | MVP ではAI抽出+自動上書きのみ |
| C14 | メモリ抽出の頻度 | **Phase C 保存時に非同期実行**。短文（5文字以下）はスキップ | コスト最適化 |
| C15 | メモリのconflict解決（矛盾する情報） | 新しい方を採用。旧情報は is_active=0 | 最新の情報を優先 |

### 1.6 exercise スキーマ

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C16 | 運動記録の扱い | **Phase 2 以降**。Intent Schema には record_candidates.exercise を定義済み。Phase 1 では activity_logs テーブルに直接保存せず、meal_text に「ランニング30分」等として記録 | MVPスコープ外 |

### 1.7 AI フォールバック

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C17 | AI API 呼び出し失敗時のフォールバック | `intent_primary = 'unclear'` で返す。BOT返信: 「申し訳ありません、メッセージの理解に失敗しました。もう一度お試しください。」 | ユーザーにリトライを促す |
| C18 | AI JSON パース失敗時 | 同上 | 構造化できない場合は安全にフォールバック |
| C19 | AI レスポンスのバリデーション | intent_primary が enum に含まれるか、target_date.resolved が日付形式か等をチェック。不正値は `'unclear'` に変換 | AI出力の品質保証 |

### 1.8 監査ログ

| # | 論点 | 決定 | 理由 |
|---|------|------|------|
| C20 | correction_history で十分か | **十分**。既存の audit_logs テーブルも活用可能だが、記録修正は correction_history に集約 | 検索効率。audit_logs はアカウント管理操作用 |
| C21 | Intent JSON のログ保存先 | conversation_messages.normalized_text に JSON 文字列として保存 | 既存スキーマ変更不要 |

---

## 2. 実装タスク優先順位（確定）

### Phase 1: 基盤（マイグレーション + 型定義 + Repository）

```
1. src/types/intent.ts                    — Unified Intent Schema 型定義
2. migrations/0013_pending_clarifications.sql
3. migrations/0014_correction_history.sql
4. migrations/0015_user_memory_items.sql
5. src/repositories/pending-clarifications-repo.ts
6. src/repositories/correction-history-repo.ts
7. src/repositories/user-memory-repo.ts
```

### Phase 2: AI 解釈（record mode）

```
1. src/services/ai/interpretation.ts      — interpretMessage()
2. src/services/ai/interpret-image.ts     — interpretImageResult()
3. src/services/line/clarification-handler.ts — Phase B ハンドラ
4. src/services/line/record-persister.ts  — Phase C ハンドラ
5. src/services/line/process-line-event.ts — handleRecordText を Phase A/B/C に切替
```

### Phase 3: consult mode 拡張

```
1. src/services/line/process-line-event.ts — handleConsultText に Phase A 追加
2. 返信テンプレートに記録ステータス追加
```

### Phase 4: 修正フロー

```
1. src/services/line/correction-handler.ts — 修正対象検索・適用
2. correction_history 連携
```

### Phase 5: パーソナルメモリ

```
1. src/services/ai/memory-extractor.ts    — メモリ抽出
2. intake-flow.ts への初期メモリ生成追加
3. consult 応答へのメモリコンテキスト注入
```

---

## 3. テスト計画

### 3.1 Phase A テストケース

| # | 入力 | 期待される intent_primary | 期待される target_date.source |
|---|------|------------------------|------------------------------|
| T1 | 「昨日の昼にラーメン食べた」 | record_meal | explicit |
| T2 | 「58.5kg」 | record_weight | timestamp |
| T3 | 「カレー食べた」(20:00送信) | record_meal | timestamp |
| T4 | 「鮭じゃなくて卵焼き」 | correct_record | inferred |
| T5 | 「おやつにチョコ食べた」 | record_meal (snack) | inferred/timestamp |
| T6 | 「食べた」 | record_meal (unclear) | unknown |
| T7 | 「最近太ってきた。昨日58kgだった」(consult) | consult + record_weight | explicit |
| T8 | 「3/10の夕食を朝食に直して」 | correct_record | explicit |
| T9 | 「さっきの記録消して」 | delete_record | inferred |
| T10 | 「夜中にラーメン食べた」(03:00送信) | record_meal (other) | inferred(前日) |

### 3.2 Phase B テストケース

| # | 状況 | 期待される質問 |
|---|------|-------------|
| B1 | meal_type 不明 | 「何の食事ですか？」+ Quick Reply |
| B2 | target_date unknown | 「いつの記録ですか？」+ Quick Reply |
| B3 | content 不明 | 「何を食べましたか？」 |
| B4 | 明確化回答「昨日」 | target_date を解決 → 次の不足フィールドへ |
| B5 | 明確化中に新規テキスト | 既存 pending を cancelled → 新規処理 |

---

## 4. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。実装前チェック項目21件、実装タスク優先順位5フェーズ、テスト計画を文書化 |
