/**
 * src/services/ai/memory-extraction.ts
 * パーソナルメモリ抽出サービス
 *
 * ユーザーの会話から長期的に記憶すべき個人情報を
 * AIで抽出し、user_memory_items に保存する。
 *
 * 正本: docs/13_パーソナルメモリSSOT.md §2
 */

import type { Bindings } from '../../types/bindings'
import { createOpenAIClient } from './openai-client'
import { upsertMemoryItem, findActiveMemories } from '../../repositories/user-memory-repo'
import { MEMORY_EXTRACTION_MIN_LENGTH } from '../../types/intent'

// ===================================================================
// メモリ抽出プロンプト
// ===================================================================

const MEMORY_EXTRACTION_PROMPT = `あなたはダイエット支援BOTのメモリ抽出エンジンです。
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
- 食事の具体的内容（「ラーメン食べた」）は記録系で処理するためメモリとしては抽出しない
  ただし「毎日ラーメン食べてる」のようなパターン情報は favorite_food として抽出
- アレルギーと健康状態は confidence_score を高めに設定（0.9以上）
- 推測に基づく情報は confidence_score を低めに設定（0.5-0.7）
- 何も抽出すべきものがない場合は空配列 [] を返す
- memory_key は英語のスネークケース（例: likes_sweet, peanut_allergy）

## ユーザーの既存メモリ（重複回避用）
{existing_memories}

## 出力形式（JSON配列）
[
  {
    "category": "...",
    "memory_key": "...",
    "memory_value": "...",
    "confidence_score": 0.0-1.0
  }
]

何も抽出すべきものがない場合は [] を返してください。`

// ===================================================================
// メイン抽出関数
// ===================================================================

/**
 * ユーザーメッセージからメモリを抽出し、DB に保存する。
 * バックグラウンド（非同期）で実行される。
 *
 * @param messageText  ユーザーのテキスト
 * @param userAccountId ユーザーアカウントID
 * @param messageId    会話メッセージID（ソース追跡用）
 * @param env          Cloudflare Bindings
 */
export async function extractMemoryFromMessage(
  messageText: string,
  userAccountId: string,
  messageId: string | null,
  env: Bindings
): Promise<void> {
  // R1 関連: 短文はスキップ (MEMORY_EXTRACTION_MIN_LENGTH)
  if (messageText.length < MEMORY_EXTRACTION_MIN_LENGTH) return
  const skipPatterns = /^(はい|いいえ|確定|取消|ok|yes|no|スキップ|次へ|戻る)$/i
  if (skipPatterns.test(messageText.trim())) return

  try {
    // 既存メモリを取得（重複回避用）
    let existingMemories: Array<{ category: string; memory_value: string }> = []
    try {
      const memories = await findActiveMemories(env.DB, userAccountId)
      existingMemories = memories.map(m => ({
        category: m.category,
        memory_value: m.memory_value,
      }))
    } catch {
      // テーブルがなければ無視
    }

    const existingText = existingMemories.length > 0
      ? existingMemories.map(m => `- [${m.category}] ${m.memory_value}`).join('\n')
      : '（なし）'

    const prompt = MEMORY_EXTRACTION_PROMPT.replace('{existing_memories}', existingText)

    // gpt-4o-mini で抽出（低コスト・高速）
    const ai = createOpenAIClient({
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_MODEL: 'gpt-4o-mini',
    })

    const raw = await ai.createResponse(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: messageText },
      ],
      {
        temperature: 0.3,
        maxTokens: 512,
        responseFormat: 'json_object',
      }
    )

    // パース
    let candidates: Array<{
      category: string
      memory_key: string
      memory_value: string
      confidence_score: number
    }> = []

    try {
      const parsed = JSON.parse(raw)
      // レスポンスが { items: [...] } 形式の場合に対応
      candidates = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.memories ?? [])
    } catch {
      console.warn('[MemoryExtraction] JSON parse failed:', raw.substring(0, 100))
      return
    }

    if (!Array.isArray(candidates) || candidates.length === 0) return

    // DB に UPSERT
    for (const c of candidates) {
      if (!c.category || !c.memory_key || !c.memory_value) continue
      try {
        await upsertMemoryItem(env.DB, userAccountId, {
          category: c.category,
          memory_key: c.memory_key,
          memory_value: c.memory_value,
          confidence_score: c.confidence_score ?? 0.8,
          source_type: 'conversation',
          source_message_id: messageId,
        })
      } catch (err) {
        console.warn(`[MemoryExtraction] upsert failed for ${c.memory_key}:`, err)
      }
    }

    console.log(`[MemoryExtraction] extracted ${candidates.length} memories for user ${userAccountId}`)
  } catch (err) {
    console.error('[MemoryExtraction] error:', err)
    // メモリ抽出の失敗はユーザーには影響しない
  }
}
