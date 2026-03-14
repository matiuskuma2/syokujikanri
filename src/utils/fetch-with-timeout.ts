/**
 * fetch-with-timeout.ts
 * AbortController を使ったタイムアウト付き fetch ラッパー
 *
 * Cloudflare Workers は CPU 制限（30s/request free, 50s paid）があるため、
 * 外部 API 呼び出しが無制限にハングすると Worker 自体がタイムアウトする。
 * 全ての外部 fetch に明示的なタイムアウトを設定し、
 * ユーザーにエラーメッセージを返せるようにする。
 */

/** タイムアウト定数（ミリ秒） */
export const TIMEOUT = {
  /** LINE Messaging API（reply, push, profile） */
  LINE_API: 10_000,
  /** LINE Content API（画像バイナリ取得） */
  LINE_CONTENT: 15_000,
  /** LINE ID Token 検証 */
  LINE_VERIFY: 5_000,
  /** OpenAI Chat Completions / Vision（重い処理用） */
  OPENAI_CHAT: 25_000,
  /** OpenAI Chat Completions（軽い分類用：maxTokens <= 100） */
  OPENAI_CHAT_LIGHT: 10_000,
  /** OpenAI Embeddings */
  OPENAI_EMBEDDINGS: 15_000,
  /** SendGrid メール送信 */
  SENDGRID: 10_000,
} as const

/**
 * タイムアウト付き fetch
 *
 * @param url     リクエスト URL
 * @param init    RequestInit オプション（headers, body, method 等）
 * @param timeoutMs タイムアウト（ミリ秒）
 * @returns Response
 * @throws AbortError（タイムアウト時）またはネットワークエラー
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
