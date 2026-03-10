/**
 * JWT ユーティリティ（Web Crypto API使用）
 * Cloudflare Workers環境対応
 */

import type { JwtPayload } from '../types/db'

function base64urlEncode(str: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    str.length + (4 - (str.length % 4)) % 4, '='
  )
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, expiresIn = '7d'): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat = Math.floor(Date.now() / 1000)

  let seconds = 7 * 24 * 60 * 60 // default 7d
  const match = expiresIn.match(/^(\d+)([smhd])$/)
  if (match) {
    const value = parseInt(match[1], 10)
    const unit = match[2]
    if (unit === 's') seconds = value
    else if (unit === 'm') seconds = value * 60
    else if (unit === 'h') seconds = value * 3600
    else if (unit === 'd') seconds = value * 86400
  }

  const fullPayload: JwtPayload = { ...payload, iat, exp: iat + seconds }

  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const payloadB64 = btoa(JSON.stringify(fullPayload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await getKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))

  return `${signingInput}.${base64urlEncode(signature)}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, sigB64] = parts
    const signingInput = `${headerB64}.${payloadB64}`

    const key = await getKey(secret)
    const sigBytes = base64urlDecode(sigB64)
    const valid = await crypto.subtle.verify(
      'HMAC', key,
      sigBytes,
      new TextEncoder().encode(signingInput)
    )
    if (!valid) return null

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload

    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
  } catch {
    return null
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.substring(7)
}
