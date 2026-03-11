/**
 * src/utils/password.ts
 * Web Crypto API を使ったパスワードハッシュ（Cloudflare Workers 対応）
 * bcrypt は使えないため PBKDF2 で代替
 */

const ITERATIONS = 100_000
const KEY_LENGTH = 32
const ALGORITHM = 'PBKDF2'

/** パスワードをハッシュ化して "salt:hash" 形式の文字列を返す */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltHex = bufToHex(salt)

  const key = await deriveKey(password, salt)
  const hashHex = bufToHex(key)

  return `${saltHex}:${hashHex}`
}

/** "salt:hash" 文字列とパスワードを照合する */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, storedHash] = stored.split(':')
  if (!saltHex || !storedHash) return false

  const salt = hexToBuf(saltHex)
  const key = await deriveKey(password, salt)
  const hashHex = bufToHex(key)

  return hashHex === storedHash
}

async function deriveKey(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    ALGORITHM,
    false,
    ['deriveBits']
  )
  return crypto.subtle.deriveBits(
    { name: ALGORITHM, salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH * 8
  )
}

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuf(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return arr
}

/** ランダムなトークンを生成（URL safe base64） */
export function generateSecureToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
