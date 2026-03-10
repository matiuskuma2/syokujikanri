/**
 * ユーティリティ: ID生成・時刻
 * Cloudflare Workers 環境対応（Web Crypto API使用）
 */

/** ULID風の32文字IDを生成（crypto.randomUUID ベース） */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/** UTC ISO文字列を D1 用の "YYYY-MM-DD HH:MM:SS" 形式に変換 */
export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

/** JST の今日の日付を "YYYY-MM-DD" で返す */
export function todayJst(): string {
  const now = new Date()
  // JST = UTC+9
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().substring(0, 10)
}

/** ISO文字列から YYYY-MM-DD を抽出 */
export function toDateStr(iso: string): string {
  return iso.substring(0, 10)
}
