/**
 * verify-signature.ts
 * LINE Webhook の HMAC-SHA256 署名検証
 *
 * Web Crypto API 使用（Cloudflare Workers 対応）
 * 参照: https://developers.line.biz/ja/docs/messaging-api/receiving-messages/#verify-signature
 */

/**
 * X-Line-Signature ヘッダーを検証する
 *
 * @param rawBody   リクエストの生 body（テキスト）
 * @param signature X-Line-Signature ヘッダーの値（Base64）
 * @param channelSecret LINE Channel Secret
 * @returns 検証が通れば true
 */
export async function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string
): Promise<boolean> {
  if (!signature || !channelSecret) return false

  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(rawBody)
    )
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    return expected === signature
  } catch {
    return false
  }
}
