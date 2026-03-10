/**
 * APIレスポンスヘルパー
 */

import type { Context } from 'hono'
import type { ApiResponse } from '../types/models'

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json<ApiResponse<T>>({ success: true, data }, status)
}

export function created<T>(c: Context, data: T) {
  return ok(c, data, 201)
}

export function badRequest(c: Context, error: string) {
  return c.json<ApiResponse>({ success: false, error }, 400)
}

export function unauthorized(c: Context, error = 'Unauthorized') {
  return c.json<ApiResponse>({ success: false, error }, 401)
}

export function forbidden(c: Context, error = 'Forbidden') {
  return c.json<ApiResponse>({ success: false, error }, 403)
}

export function notFound(c: Context, error = 'Not Found') {
  return c.json<ApiResponse>({ success: false, error }, 404)
}

export function serverError(c: Context, error = 'Internal Server Error') {
  return c.json<ApiResponse>({ success: false, error }, 500)
}
