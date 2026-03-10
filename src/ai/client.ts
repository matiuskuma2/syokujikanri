/**
 * OpenAI API クライアント
 * diet-bot - AI処理レイヤー
 */

import type { Bindings } from '../types/bindings'
import type {
  MealAnalysisResult,
  ScaleReadResult,
  NutritionLabelResult,
  UserProfile,
  DailyLog,
  MealEntry
} from '../types/models'
import {
  buildConsultSystemPrompt,
  buildDailyFeedbackPrompt,
  buildWeeklyReportPrompt,
  buildMealImageAnalysisPrompt,
  buildKnowledgePrompt,
  IMAGE_CLASSIFICATION_PROMPT,
  MEAL_IMAGE_ANALYSIS_SYSTEM,
  NUTRITION_LABEL_ANALYSIS_PROMPT,
  SCALE_IMAGE_ANALYSIS_PROMPT,
  PROGRESS_PHOTO_PROMPT,
  PROGRESS_PHOTO_SYSTEM
} from './prompts'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

// ===================================================================
// 基底クライアント
// ===================================================================

export class OpenAIClient {
  private apiKey: string
  private model: string
  private maxTokens: number
  private baseUrl = 'https://api.openai.com/v1'

  constructor(env: Bindings) {
    this.apiKey = env.OPENAI_API_KEY
    this.model = env.OPENAI_MODEL || 'gpt-4o'
    this.maxTokens = parseInt(env.OPENAI_MAX_TOKENS || '2048', 10)
  }

  async chat(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number; responseFormat?: 'json' } = {}
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? 0.7
    }
    if (options.responseFormat === 'json') {
      body.response_format = { type: 'json_object' }
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${error}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }
    return data.choices[0]?.message?.content || ''
  }

  async chatWithVision(
    systemPrompt: string,
    userText: string,
    imageUrl: string,
    options: { temperature?: number; responseFormat?: 'json' } = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
    return this.chat(messages, { ...options, maxTokens: 1024 })
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text
      })
    })
    if (!response.ok) {
      throw new Error(`OpenAI Embeddings error: ${response.status}`)
    }
    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data[0]?.embedding || []
  }
}

// ===================================================================
// ダイエットBOT専用AIサービス
// ===================================================================

export class DietAIService {
  private client: OpenAIClient
  private tempRecord: number
  private tempConsult: number

  constructor(env: Bindings) {
    this.client = new OpenAIClient(env)
    this.tempRecord = parseFloat(env.OPENAI_TEMPERATURE_RECORD || '0.3')
    this.tempConsult = parseFloat(env.OPENAI_TEMPERATURE_CONSULT || '0.7')
  }

  // 相談モード：AIチャット応答
  async consult(
    userMessage: string,
    profile: UserProfile | null,
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    const systemPrompt = buildConsultSystemPrompt(profile)
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ]
    return this.client.chat(messages, { temperature: this.tempConsult })
  }

  // 日次フィードバック生成
  async generateDailyFeedback(
    profile: UserProfile | null,
    dailyLog: DailyLog,
    meals: MealEntry[]
  ): Promise<string> {
    const prompt = buildDailyFeedbackPrompt(profile, dailyLog, meals)
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ]
    return this.client.chat(messages, { temperature: this.tempRecord })
  }

  // 週次レポート生成
  async generateWeeklyReport(
    profile: UserProfile | null,
    weekStart: string,
    weekEnd: string,
    logs: DailyLog[],
    allMeals: MealEntry[]
  ): Promise<string> {
    const prompt = buildWeeklyReportPrompt(profile, weekStart, weekEnd, logs, allMeals)
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ]
    return this.client.chat(messages, { temperature: this.tempRecord })
  }

  // 画像分類
  async classifyImage(imageUrl: string): Promise<{
    type: string
    confidence: number
    reason: string
  }> {
    const result = await this.client.chatWithVision(
      '画像分類AIです。',
      IMAGE_CLASSIFICATION_PROMPT,
      imageUrl,
      { temperature: 0.1, responseFormat: 'json' }
    )
    try {
      return JSON.parse(result)
    } catch {
      return { type: 'other', confidence: 0, reason: '分類失敗' }
    }
  }

  // 食事画像解析
  async analyzeMealImage(
    imageUrl: string,
    mealType: string
  ): Promise<MealAnalysisResult> {
    const prompt = buildMealImageAnalysisPrompt(mealType)
    const result = await this.client.chatWithVision(
      MEAL_IMAGE_ANALYSIS_SYSTEM,
      prompt,
      imageUrl,
      { temperature: 0.2, responseFormat: 'json' }
    )
    try {
      return JSON.parse(result) as MealAnalysisResult
    } catch {
      return {
        dishes: [],
        total_calories: 0,
        total_protein_g: 0,
        total_fat_g: 0,
        total_carbs_g: 0,
        nutrition_score: 50,
        ai_comment: '画像の解析に失敗しました。テキストで入力してください。'
      }
    }
  }

  // 栄養成分ラベル解析
  async analyzeNutritionLabel(imageUrl: string): Promise<NutritionLabelResult> {
    const result = await this.client.chatWithVision(
      '栄養成分表示ラベル読み取りAIです。',
      NUTRITION_LABEL_ANALYSIS_PROMPT,
      imageUrl,
      { temperature: 0.1, responseFormat: 'json' }
    )
    try {
      return JSON.parse(result) as NutritionLabelResult
    } catch {
      return {
        product_name: null,
        serving_size: null,
        calories_per_serving: null,
        protein_g: null,
        fat_g: null,
        carbs_g: null,
        sodium_mg: null,
        confidence: 0
      }
    }
  }

  // 体重計画像解析
  async analyzeScale(imageUrl: string): Promise<ScaleReadResult> {
    const result = await this.client.chatWithVision(
      '体重計読み取りAIです。',
      SCALE_IMAGE_ANALYSIS_PROMPT,
      imageUrl,
      { temperature: 0.1, responseFormat: 'json' }
    )
    try {
      return JSON.parse(result) as ScaleReadResult
    } catch {
      return { weight_kg: null, body_fat_pct: null, confidence: 0, raw_text: '' }
    }
  }

  // 進捗写真判定
  async judgeProgressPhoto(imageUrl: string): Promise<{
    is_body_photo: boolean
    confidence: number
    message: string
  }> {
    const result = await this.client.chatWithVision(
      PROGRESS_PHOTO_SYSTEM,
      PROGRESS_PHOTO_PROMPT,
      imageUrl,
      { temperature: 0.1, responseFormat: 'json' }
    )
    try {
      return JSON.parse(result)
    } catch {
      return { is_body_photo: false, confidence: 0, message: '写真を受け取りました。' }
    }
  }

  // ナレッジBOT回答
  async answerWithKnowledge(
    question: string,
    knowledgeContext: string,
    profile: UserProfile | null
  ): Promise<string> {
    const prompt = buildKnowledgePrompt(question, knowledgeContext, profile)
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt }
    ]
    return this.client.chat(messages, { temperature: this.tempConsult })
  }

  // テキストからの食事記録解析
  async parseMealText(text: string, mealType: string): Promise<Partial<MealAnalysisResult>> {
    const mealTypeJa: Record<string, string> = {
      breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食', drink: '飲み物'
    }
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: MEAL_IMAGE_ANALYSIS_SYSTEM
      },
      {
        role: 'user',
        content: `${mealTypeJa[mealType] || '食事'}の内容: "${text}"

上記のテキストから食事内容を解析してください。
以下のJSON形式で回答してください:
{
  "dishes": [{"name": "料理名", "quantity": "量", "estimated_calories": 数値, "protein_g": 数値, "fat_g": 数値, "carbs_g": 数値, "confidence": 数値}],
  "total_calories": 合計カロリー,
  "total_protein_g": 合計タンパク質,
  "total_fat_g": 合計脂質,
  "total_carbs_g": 合計炭水化物,
  "nutrition_score": 0-100,
  "ai_comment": "コメント（50文字以内）"
}`
      }
    ]
    try {
      const result = await this.client.chat(messages, {
        temperature: 0.2,
        responseFormat: 'json'
      })
      return JSON.parse(result)
    } catch {
      return {}
    }
  }

  // テキスト埋め込み（ナレッジ検索用）
  async embed(text: string): Promise<number[]> {
    return this.client.embed(text)
  }
}
