/**
 * openai-client.ts
 * OpenAI API クライアント（Cloudflare Workers 対応）
 *
 * 3つのコアメソッドを提供:
 *   createResponse       - テキスト Chat Completions
 *   createVisionResponse - 画像付き Chat Completions
 *   createEmbedding      - text-embedding-3-small
 */

import { fetchWithTimeout, TIMEOUT } from '../../utils/fetch-with-timeout'

// ===================================================================
// 型定義
// ===================================================================

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
      >
}

export type OpenAIClientOptions = {
  apiKey: string
  model?: string
  maxTokens?: number
  baseUrl?: string
}

type ChatCompletionResponse = {
  choices: Array<{ message: { content: string | null } }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

type EmbeddingResponse = {
  data: Array<{ embedding: number[] }>
}

// ===================================================================
// コアクライアント
// ===================================================================

export class OpenAIClient {
  private apiKey: string
  private model: string
  private maxTokens: number
  private baseUrl: string

  constructor(opts: OpenAIClientOptions) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? 'gpt-4o'
    this.maxTokens = opts.maxTokens ?? 2048
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
  }

  // ------------------------------------------------------------------
  // createResponse — テキスト Chat Completions
  // ------------------------------------------------------------------

  async createResponse(
    messages: ChatMessage[],
    opts: {
      temperature?: number
      maxTokens?: number
      responseFormat?: 'text' | 'json_object'
      /** 軽量呼び出し用の短いタイムアウトを使う（分類タスク等） */
      lightTimeout?: boolean
    } = {}
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      temperature: opts.temperature ?? 0.7,
    }
    if (opts.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' }
    }

    const timeout = opts.lightTimeout ? TIMEOUT.OPENAI_CHAT_LIGHT : TIMEOUT.OPENAI_CHAT
    const startTime = Date.now()

    const res = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      timeout
    )

    const elapsed = Date.now() - startTime
    console.log(`[OpenAI] createResponse: ${res.status} (${elapsed}ms, timeout=${timeout}ms, maxTokens=${opts.maxTokens ?? this.maxTokens})`)

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`OpenAI createResponse failed: ${res.status} ${err}`)
    }

    const data = (await res.json()) as ChatCompletionResponse
    return data.choices[0]?.message?.content ?? ''
  }

  // ------------------------------------------------------------------
  // createVisionResponse — 画像付き Chat Completions
  // ------------------------------------------------------------------

  async createVisionResponse(
    systemPrompt: string,
    userText: string,
    imageUrl: string,
    opts: {
      temperature?: number
      maxTokens?: number
      responseFormat?: 'text' | 'json_object'
      imageDetail?: 'low' | 'high' | 'auto'
    } = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: opts.imageDetail ?? 'low',
            },
          },
        ],
      },
    ]
    return this.createResponse(messages, {
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens ?? 1024,
      responseFormat: opts.responseFormat,
    })
  }

  // ------------------------------------------------------------------
  // createEmbedding — text-embedding-3-small
  // ------------------------------------------------------------------

  async createEmbedding(
    text: string,
    model = 'text-embedding-3-small'
  ): Promise<number[]> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      },
      TIMEOUT.OPENAI_EMBEDDINGS
    )

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`OpenAI createEmbedding failed: ${res.status} ${err}`)
    }

    const data = (await res.json()) as EmbeddingResponse
    return data.data[0]?.embedding ?? []
  }
}

// ===================================================================
// ファクトリ（Bindings から生成）
// ===================================================================

type BindingsSubset = {
  OPENAI_API_KEY: string
  OPENAI_MODEL?: string
  OPENAI_MAX_TOKENS?: string
}

/** Cloudflare Bindings から OpenAIClient を生成するヘルパー */
export function createOpenAIClient(env: BindingsSubset): OpenAIClient {
  return new OpenAIClient({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL ?? 'gpt-4o',
    maxTokens: env.OPENAI_MAX_TOKENS ? parseInt(env.OPENAI_MAX_TOKENS, 10) : 2048,
  })
}
