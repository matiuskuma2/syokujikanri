# パーソナルメモリ SSOT（Single Source of Truth）

> **最終更新**: 2026-03-13  
> **対象**: diet-bot v2.0（設計段階）  
> **前提**: `11_会話解釈SSOT.md` §8 の3層データストア設計（Layer 3）  
> **本ドキュメントが user_memory_items 設計の正本**。

---

## 0. 概要

パーソナルメモリは、ユーザーとの会話から蓄積される**長期的な個人情報**を管理する仕組み。  
食事の好み、アレルギー、生活パターンなどを記録し、AI相談や記録解釈の精度向上に活用する。

### 0.1 3層データストアにおける位置づけ

```
Layer 1: 生会話ログ（conversation_messages）
  └── 全メッセージをそのまま保存。短期参照用。

Layer 2: 構造化記録（daily_logs / meal_entries / body_metrics）
  └── 日付×記録種別で整理。ダッシュボード・レポートのデータソース。

Layer 3: パーソナルナレッジ（user_memory_items）★本ドキュメント
  └── 長期的な個人情報。AI相談のコンテキスト。嗜好・習慣・制約。
```

### 0.2 設計方針

| 方針 | 説明 |
|------|------|
| **暗黙的抽出** | ユーザーが明示的に登録するのではなく、会話から自動抽出 |
| **AI解析で生成** | Phase A の解釈時、または相談応答生成時にメモリを抽出・更新 |
| **カテゴリ分類** | 食事嗜好・アレルギー・生活習慣・目標など構造化して管理 |
| **上書き可能** | 同一カテゴリ・同一キーの情報は新しいもので上書き |
| **有効期限なし** | 明示的に削除されない限り永続（ただしconfidence_score付き） |

---

## 1. user_memory_items テーブル設計

### 1.1 DDL

```sql
CREATE TABLE user_memory_items (
  id                TEXT PRIMARY KEY,
  user_account_id   TEXT NOT NULL REFERENCES user_accounts(id),

  -- 分類
  category          TEXT NOT NULL,           -- メモリのカテゴリ（§1.2）
  memory_key        TEXT NOT NULL,           -- カテゴリ内の一意キー
  
  -- 内容
  memory_value      TEXT NOT NULL,           -- メモリの値（テキスト）
  structured_json   TEXT,                    -- 構造化データ（JSON、任意）
  
  -- メタデータ
  source_type       TEXT NOT NULL DEFAULT 'conversation',  -- 'conversation' | 'intake' | 'admin' | 'system'
  source_message_id TEXT REFERENCES conversation_messages(id),  -- 抽出元メッセージ
  confidence_score  REAL NOT NULL DEFAULT 0.8,  -- AIの確信度 (0.0-1.0)
  
  -- 管理
  is_active         INTEGER NOT NULL DEFAULT 1,  -- 0=無効化（論理削除）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(user_account_id, category, memory_key)
);

CREATE INDEX idx_memory_items_user 
  ON user_memory_items(user_account_id, is_active);
CREATE INDEX idx_memory_items_category 
  ON user_memory_items(user_account_id, category, is_active);
```

### 1.2 カテゴリ定義

| カテゴリ | memory_key 例 | 説明 | 抽出タイミング |
|---------|-------------|------|-------------|
| `food_preference` | `likes_sweet`, `dislikes_fish` | 食べ物の好み・嫌い | 会話中に検出 |
| `allergy` | `egg_allergy`, `lactose_intolerant` | アレルギー・食事制限 | 会話中に検出 |
| `dietary_restriction` | `vegetarian`, `low_carb` | 食事制限・方針 | 会話 / 問診 |
| `eating_habit` | `skip_breakfast`, `late_dinner` | 食事習慣パターン | 記録パターンから推定 |
| `lifestyle` | `office_worker`, `night_shift` | 生活スタイル | 会話中に検出 |
| `exercise_habit` | `runs_3x_week`, `no_exercise` | 運動習慣 | 会話中に検出 |
| `health_condition` | `high_blood_pressure`, `diabetes` | 健康状態・持病 | 会話中に検出 |
| `goal_detail` | `wedding_in_3months`, `summer_body` | 具体的な目標・期限 | 会話中に検出 |
| `favorite_food` | `ramen_weekly`, `coffee_daily` | よく食べる物・飲む物 | 記録パターンから推定 |
| `context` | `busy_at_work`, `traveling` | 一時的な状況 | 会話中に検出 |

### 1.3 記録例

```json
// 食事の好み
{
  "id": "UM_001",
  "user_account_id": "UA_xyz",
  "category": "food_preference",
  "memory_key": "likes_sweet",
  "memory_value": "甘い物が好き。特にチョコレート。",
  "structured_json": "{\"preference\": \"like\", \"food\": \"甘い物\", \"specific\": \"チョコレート\"}",
  "source_type": "conversation",
  "source_message_id": "CM_123",
  "confidence_score": 0.9
}

// アレルギー
{
  "id": "UM_002",
  "user_account_id": "UA_xyz",
  "category": "allergy",
  "memory_key": "peanut_allergy",
  "memory_value": "ピーナッツアレルギーあり",
  "structured_json": "{\"allergen\": \"peanut\", \"severity\": \"moderate\"}",
  "source_type": "conversation",
  "confidence_score": 0.95
}

// 食事習慣（記録パターンから推定）
{
  "id": "UM_003",
  "user_account_id": "UA_xyz",
  "category": "eating_habit",
  "memory_key": "skip_breakfast",
  "memory_value": "朝食を抜くことが多い（直近2週間で朝食記録が2回のみ）",
  "structured_json": "{\"pattern\": \"skip\", \"meal_type\": \"breakfast\", \"frequency\": \"often\", \"data_period_days\": 14, \"count\": 2}",
  "source_type": "system",
  "confidence_score": 0.7
}
```

---

## 2. メモリ抽出フロー

### 2.1 会話からの抽出（リアルタイム）

```
ユーザーメッセージ受信
  │
  ├── Phase A: interpretMessage() 実行
  │     └── Intent JSON 生成
  │
  ├── Phase C: 記録保存（該当する場合）
  │
  └── メモリ抽出（非同期・バックグラウンド）
        │
        ▼
  extractMemoryFromMessage()
    │
    ├── 入力:
    │   - message_text
    │   - intent JSON
    │   - 既存 memory_items（重複チェック用）
    │
    ├── OpenAI 呼び出し（MEMORY_EXTRACTION_PROMPT）
    │   - temp=0.3
    │   - json_object
    │
    ├── 出力: 抽出されたメモリ候補の配列
    │   [
    │     { category, memory_key, memory_value, confidence_score }
    │   ]
    │
    └── UPSERT: user_memory_items
          - 同一 (user_account_id, category, memory_key) は上書き
          - confidence_score が既存より低い場合はスキップ
```

### 2.2 MEMORY_EXTRACTION_PROMPT

```
あなたはダイエット支援BOTのメモリ抽出エンジンです。
ユーザーの発言から、長期的に記憶すべき個人情報を抽出してください。

## 抽出対象カテゴリ
- food_preference: 食べ物の好み・嫌い
- allergy: アレルギー・食事制限（重要度高）
- dietary_restriction: 食事制限・方針（ベジタリアン等）
- eating_habit: 食事習慣パターン
- lifestyle: 生活スタイル（仕事、通勤等）
- exercise_habit: 運動習慣
- health_condition: 健康状態・持病（重要度高）
- goal_detail: 具体的な目標・期限
- favorite_food: よく食べる物
- context: 一時的な状況（出張中、旅行中等）

## ルール
- 一時的な情報（「今日は疲れた」等）は抽出しない
  ただし「今週出張中」のように複数日に影響する情報は context として抽出
- 食事の具体的内容（「ラーメン食べた」）は記録系（meal_entries）で処理するため
  メモリとしては抽出しない
  ただし「毎日ラーメン食べてる」のようなパターン情報は favorite_food として抽出
- アレルギーと健康状態は confidence_score を高めに設定（0.9以上）
- 推測に基づく情報は confidence_score を低めに設定（0.5-0.7）
- 何も抽出すべきものがない場合は空配列 [] を返す

## ユーザーの既存メモリ（重複回避用）
{existing_memories}

## 出力形式
[
  {
    "category": "...",
    "memory_key": "...",
    "memory_value": "...",
    "confidence_score": 0.0-1.0
  }
]

何も抽出すべきものがない場合は [] を返してください。
```

### 2.3 記録パターンからの推定（バッチ）

週次レポート生成時に、記録パターンから食事習慣を推定する。

```typescript
/**
 * 記録パターンからメモリを推定する
 * 週次レポートジョブで実行
 */
async function inferMemoryFromRecordPatterns(
  db: D1Database,
  userAccountId: string,
  periodDays: number = 14
): Promise<MemoryCandidate[]> {
  const memories: MemoryCandidate[] = []

  // 1. 朝食スキップパターン
  const breakfastCount = await countMealsByType(db, userAccountId, 'breakfast', periodDays)
  const totalDays = await countLogDays(db, userAccountId, periodDays)
  if (totalDays >= 7 && breakfastCount / totalDays < 0.3) {
    memories.push({
      category: 'eating_habit',
      memory_key: 'skip_breakfast',
      memory_value: `朝食を抜くことが多い（直近${periodDays}日間で朝食記録が${breakfastCount}回のみ）`,
      confidence_score: 0.7
    })
  }

  // 2. 間食パターン
  const snackCount = await countMealsByType(db, userAccountId, 'snack', periodDays)
  if (snackCount >= 5) {
    memories.push({
      category: 'eating_habit',
      memory_key: 'frequent_snacking',
      memory_value: `間食が多い（直近${periodDays}日間で${snackCount}回）`,
      confidence_score: 0.7
    })
  }

  // 3. よく食べる食品の特定
  const frequentFoods = await findFrequentFoods(db, userAccountId, periodDays)
  for (const food of frequentFoods) {
    memories.push({
      category: 'favorite_food',
      memory_key: `frequent_${food.normalized}`,
      memory_value: `${food.name}をよく食べる（直近${periodDays}日間で${food.count}回）`,
      confidence_score: 0.6
    })
  }

  return memories
}
```

---

## 3. メモリの活用

### 3.1 AI相談時のコンテキスト注入

```typescript
/**
 * 相談応答生成時にメモリを RAG コンテキストに追加する
 */
function buildConsultContextWithMemory(
  profile: UserProfile,
  memories: UserMemoryItem[],
  recentLogs: DailyLog[],
  knowledge: string[]
): string {
  const memorySection = memories
    .filter(m => m.is_active && m.confidence_score >= 0.6)
    .map(m => `- [${m.category}] ${m.memory_value}`)
    .join('\n')

  return `
## ユーザー情報
${buildProfileSummary(profile)}

## パーソナルメモリ（蓄積された個人情報）
${memorySection || '（まだ蓄積されていません）'}

## 直近の記録
${buildRecentLogSummary(recentLogs)}

## ナレッジ
${knowledge.join('\n\n')}
`
}
```

### 3.2 記録解釈時のコンテキスト活用

Phase A の INTERPRETATION_PROMPT にメモリ情報を含めることで、  
解釈精度を向上させる。

```
## ユーザーの既知情報（参考）
- アレルギー: ピーナッツアレルギーあり
- 食事の好み: 甘い物が好き（特にチョコレート）
- 食事習慣: 朝食を抜くことが多い
- 運動: 週3回ランニング

※上記を踏まえて、ユーザーの発言を解釈してください。
```

### 3.3 日次リマインダーのパーソナライズ

```
// メモリを基にリマインダー文面をパーソナライズ
例:
- memory: skip_breakfast → 「朝食を食べましたか？少しでもOKです」
- memory: likes_sweet + high snack count → 「おやつの代わりにフルーツはいかがですか？」
- memory: busy_at_work → 「お忙しいところお疲れ様です。簡単な記録でもOKです」
```

---

## 4. メモリの管理

### 4.1 上書きルール

| 条件 | 動作 |
|------|------|
| 同一 (category, memory_key) が既に存在 | 新しい情報で UPDATE（confidence_score も更新） |
| 新しい confidence_score が既存より低い | **スキップ**（既存を維持） |
| 矛盾する情報 | 新しい方を採用し、旧情報の is_active=0 に |

### 4.2 ユーザーによる管理（将来）

Phase 2 以降で、ダッシュボードからメモリの閲覧・削除を可能にする。

```
/api/users/me/memories          GET    メモリ一覧
/api/users/me/memories/:id      DELETE メモリ削除
```

### 4.3 プライバシー考慮

| 項目 | 対応 |
|------|------|
| 医療情報（health_condition） | 管理者には表示しない。AIコンテキストのみで使用 |
| アカウント削除時 | user_memory_items を物理削除 |
| メモリ抽出の同意 | 問診完了時に「会話内容からお好みを学習します」の通知を出す |

---

## 5. 問診（intake）からの初期メモリ生成

問診完了時に、回答内容からメモリを自動生成する。

| 問診項目 | メモリ変換 |
|---------|----------|
| Q5: 現在体重 | `eating_habit` / `initial_weight` |
| Q6: 目標体重 | `goal_detail` / `target_weight` |
| Q7: 目標・理由 | `goal_detail` / `goal_reason` |
| Q8: 気になること | 各タグ → 対応する category のメモリ |
| Q9: 活動レベル | `lifestyle` / `activity_level` |

```typescript
/**
 * 問診回答からメモリを生成
 * intake-flow.ts の問診完了ハンドラから呼び出す
 */
async function createMemoryFromIntake(
  db: D1Database,
  userAccountId: string,
  profile: UserProfile,
  answers: IntakeAnswer[]
): Promise<void> {
  const memories: MemoryCandidate[] = []

  if (profile.goal_summary) {
    memories.push({
      category: 'goal_detail',
      memory_key: 'goal_reason',
      memory_value: profile.goal_summary,
      confidence_score: 1.0,
      source_type: 'intake'
    })
  }

  if (profile.concern_tags) {
    const tags = JSON.parse(profile.concern_tags) as string[]
    for (const tag of tags) {
      const mapping = CONCERN_TAG_TO_MEMORY[tag]
      if (mapping) {
        memories.push({
          ...mapping,
          confidence_score: 1.0,
          source_type: 'intake'
        })
      }
    }
  }

  if (profile.activity_level) {
    memories.push({
      category: 'lifestyle',
      memory_key: 'activity_level',
      memory_value: `活動レベル: ${ACTIVITY_LEVEL_LABELS[profile.activity_level]}`,
      confidence_score: 1.0,
      source_type: 'intake'
    })
  }

  for (const mem of memories) {
    await upsertMemoryItem(db, userAccountId, mem)
  }
}
```

---

## 6. Repository 設計

### 6.1 主要関数

```typescript
// src/repositories/user-memory-repo.ts

/** メモリを UPSERT（同一カテゴリ・キーは上書き） */
async function upsertMemoryItem(
  db: D1Database,
  userAccountId: string,
  item: MemoryCandidate
): Promise<void>

/** ユーザーの有効なメモリを全取得 */
async function findActiveMemories(
  db: D1Database,
  userAccountId: string
): Promise<UserMemoryItem[]>

/** カテゴリ指定でメモリを取得 */
async function findMemoriesByCategory(
  db: D1Database,
  userAccountId: string,
  category: string
): Promise<UserMemoryItem[]>

/** メモリを無効化（論理削除） */
async function deactivateMemoryItem(
  db: D1Database,
  memoryId: string
): Promise<void>

/** ユーザーの全メモリを物理削除（アカウント削除時） */
async function deleteAllMemories(
  db: D1Database,
  userAccountId: string
): Promise<void>
```

---

## 7. AI使用パラメータ

| 用途 | モデル | temp | format | max_tokens | 備考 |
|------|--------|------|--------|-----------|------|
| メモリ抽出（リアルタイム） | gpt-4o-mini | 0.3 | json_object | 512 | 低コスト・高速 |
| メモリ抽出（バッチ） | gpt-4o-mini | 0.3 | json_object | 512 | 週次ジョブ |
| コンテキスト注入 | — | — | — | — | AI呼び出しなし（プロンプト構築のみ） |

**コスト最適化**: メモリ抽出はメッセージごとに実行するため、  
gpt-4o-mini を使用してコストを抑える。  
メモリ抽出が不要なメッセージ（「はい」「確定」等の短文）はスキップする。

---

## 8. 実装フェーズとの対応

| Phase | メモリ関連タスク | 優先度 |
|-------|---------------|--------|
| A（解釈レイヤー） | メモリをINTERPRETATION_PROMPTのコンテキストに含める | 中 |
| B（明確化フロー） | メモリ関連なし | — |
| C（永続化レイヤー） | 記録保存時にメモリ抽出を非同期実行 | 低 |
| 独立 | 問診完了時の初期メモリ生成 | 中 |
| 独立 | 週次バッチでの記録パターン推定 | 低 |
| 独立 | 相談応答へのメモリコンテキスト注入 | 中 |

> **注意**: メモリ機能は Phase A/B/C の基本機能が安定した後に段階的に導入する。  
> 初期実装では問診からの初期メモリ生成と、相談時のコンテキスト注入のみ。  
> リアルタイム抽出とバッチ推定は後続フェーズ。

---

## 9. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|----------|
| 2026-03-13 | v1.0 | 初版作成。user_memory_items テーブル設計、カテゴリ定義、抽出フロー（リアルタイム/バッチ）、活用方法（相談コンテキスト/記録解釈/リマインダー）、問診初期メモリ、Repository設計、AI使用パラメータ、実装フェーズ対応を文書化 |
