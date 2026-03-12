/**
 * src/routes/admin/rich-menu.ts
 * LINE Rich Menu 管理 API（Superadmin / Admin）
 *
 * Rich Menu の作成・画像アップ・デフォルト設定を LINE Messaging API 経由で実行
 *
 * 参照:
 *   https://developers.line.biz/ja/reference/messaging-api/#rich-menu
 */

import { Hono } from 'hono'
import type { HonoEnv } from '../../middleware/auth'
import { ok, badRequest } from '../../utils/response'

const richMenuRouter = new Hono<HonoEnv>()

// ===================================================================
// Rich Menu テンプレート定義（2×3 グリッド, 2500×1686px）
// ===================================================================

type RichMenuAction = {
  type: 'message' | 'uri' | 'postback'
  label: string
  text?: string
  uri?: string
  data?: string
}

type RichMenuArea = {
  bounds: { x: number; y: number; width: number; height: number }
  action: RichMenuAction
}

/**
 * デフォルト Rich Menu テンプレート
 * 2列 × 3行 = 6エリア
 * 画像サイズ: 2500 × 1686
 * 各セル: 1250 × 562
 */
function buildDefaultRichMenuObject(liffUrl: string) {
  const cellW = 1250
  const cellH = 562

  const areas: RichMenuArea[] = [
    // Row 1
    {
      bounds: { x: 0, y: 0, width: cellW, height: cellH },
      action: { type: 'message', label: '記録する', text: '記録モード' },
    },
    {
      bounds: { x: cellW, y: 0, width: cellW, height: cellH },
      action: { type: 'message', label: '写真を送る', text: '写真を送る' },
    },
    // Row 2
    {
      bounds: { x: 0, y: cellH, width: cellW, height: cellH },
      action: { type: 'message', label: '体重記録', text: '体重記録' },
    },
    {
      bounds: { x: cellW, y: cellH, width: cellW, height: cellH },
      action: { type: 'message', label: '相談する', text: '相談モード' },
    },
    // Row 3
    {
      bounds: { x: 0, y: cellH * 2, width: cellW, height: cellH },
      action: { type: 'uri', label: 'ダッシュボード', uri: liffUrl },
    },
    {
      bounds: { x: cellW, y: cellH * 2, width: cellW, height: cellH },
      action: { type: 'message', label: '問診やり直し', text: '問診やり直し' },
    },
  ]

  return {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: '食事指導BOT メインメニュー',
    chatBarText: 'メニューを開く',
    areas,
  }
}

// ===================================================================
// LINE Messaging API ヘルパー
// ===================================================================

async function lineApiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
  contentType = 'application/json'
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  }
  if (contentType === 'application/json') {
    headers['Content-Type'] = 'application/json'
  } else {
    headers['Content-Type'] = contentType
  }

  const init: RequestInit = { method, headers }
  if (body) {
    init.body = contentType === 'application/json'
      ? JSON.stringify(body)
      : body as BodyInit
  }

  const res = await fetch(`https://api.line.me/v2/bot${path}`, init)
  let data: unknown = null
  try {
    const text = await res.text()
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { ok: res.ok, status: res.status, data }
}

// ===================================================================
// GET /api/admin/rich-menu/list — 現在の Rich Menu 一覧
// ===================================================================

richMenuRouter.get('/list', async (c) => {
  const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN
  const result = await lineApiRequest('GET', '/richmenu/list', accessToken)

  if (!result.ok) {
    return c.json({ success: false, error: 'Failed to list rich menus', detail: result.data }, 500)
  }

  // デフォルト Rich Menu ID も取得
  const defaultResult = await lineApiRequest('GET', '/user/all/richmenu', accessToken)
  const defaultRichMenuId = (defaultResult.data as any)?.richMenuId ?? null

  return ok(c, {
    richmenus: (result.data as any)?.richmenus ?? [],
    defaultRichMenuId,
  })
})

// ===================================================================
// POST /api/admin/rich-menu/create — Rich Menu 作成＋画像アップ＋デフォルト設定
// ===================================================================

richMenuRouter.post('/create', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin' && payload.role !== 'admin') {
    return c.json({ success: false, error: 'Admin access required' }, 403)
  }

  const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN
  const liffUrl = `https://liff.line.me/${c.env.LINE_LIFF_ID}`

  // 1. Rich Menu オブジェクト作成
  const menuObj = buildDefaultRichMenuObject(liffUrl)
  const createResult = await lineApiRequest('POST', '/richmenu', accessToken, menuObj)

  if (!createResult.ok) {
    return c.json({
      success: false,
      error: 'Failed to create rich menu',
      detail: createResult.data,
    }, 500)
  }

  const richMenuId = (createResult.data as any)?.richMenuId
  if (!richMenuId) {
    return c.json({ success: false, error: 'No richMenuId returned' }, 500)
  }

  // 2. Rich Menu 画像をアップロード
  //    リクエストボディ（multipart）→ R2 → なしの優先順で取得
  let imageBuffer: ArrayBuffer | null = null

  // まずリクエストボディから画像を取得（admin UI からのアップロード）
  try {
    const contentType = c.req.header('Content-Type') || ''
    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('image') as File | null
      if (file) {
        imageBuffer = await file.arrayBuffer()
        console.log(`[RichMenu] Image from request body: ${file.size} bytes`)
      }
    }
  } catch (e) {
    console.warn('[RichMenu] Failed to parse multipart image:', e)
  }

  // リクエストになければ R2 からフォールバック
  if (!imageBuffer) {
    try {
      const r2Obj = await c.env.R2.get('assets/richmenu.png')
      if (r2Obj) {
        imageBuffer = await r2Obj.arrayBuffer()
        console.log(`[RichMenu] Image from R2: ${imageBuffer.byteLength} bytes`)
      }
    } catch (e) {
      console.warn('[RichMenu] R2 richmenu.png not found:', e)
    }
  }

  if (!imageBuffer) {
    // 画像なし → Rich Menu は作成できたがイメージなし
    return ok(c, {
      richMenuId,
      imageUploaded: false,
      setAsDefault: false,
      message: 'Rich Menu created but no image available. Upload image separately via POST /api/admin/rich-menu/upload-image/:richMenuId',
    })
  }

  const uploadResult = await lineApiRequest(
    'POST',
    `/richmenu/${richMenuId}/content`,
    accessToken,
    imageBuffer,
    'image/png'
  )

  if (!uploadResult.ok) {
    // 画像アップ失敗 → 作成した Rich Menu を削除
    await lineApiRequest('DELETE', `/richmenu/${richMenuId}`, accessToken)
    return c.json({
      success: false,
      error: 'Failed to upload rich menu image',
      detail: uploadResult.data,
    }, 500)
  }

  // 3. デフォルトに設定
  const setDefaultResult = await lineApiRequest(
    'POST',
    `/user/all/richmenu/${richMenuId}`,
    accessToken
  )

  return ok(c, {
    richMenuId,
    imageUploaded: true,
    setAsDefault: setDefaultResult.ok,
    message: setDefaultResult.ok
      ? 'Rich Menu created and set as default'
      : 'Rich Menu created but failed to set as default',
  })
})

// ===================================================================
// POST /api/admin/rich-menu/set-default/:richMenuId
// ===================================================================

richMenuRouter.post('/set-default/:richMenuId', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin' && payload.role !== 'admin') {
    return c.json({ success: false, error: 'Admin access required' }, 403)
  }

  const richMenuId = c.req.param('richMenuId')
  const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN

  const result = await lineApiRequest(
    'POST',
    `/user/all/richmenu/${richMenuId}`,
    accessToken
  )

  if (!result.ok) {
    return c.json({ success: false, error: 'Failed to set default', detail: result.data }, 500)
  }

  return ok(c, { message: 'Default rich menu updated', richMenuId })
})

// ===================================================================
// POST /api/admin/rich-menu/upload-image/:richMenuId — 画像だけアップ
// ===================================================================

richMenuRouter.post('/upload-image/:richMenuId', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin' && payload.role !== 'admin') {
    return c.json({ success: false, error: 'Admin access required' }, 403)
  }

  const richMenuId = c.req.param('richMenuId')
  const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN

  // multipart/form-data から画像を取得
  const formData = await c.req.formData()
  const file = formData.get('image') as File | null
  if (!file) {
    return badRequest(c, 'Image file required (field name: image)')
  }

  const imageBuffer = await file.arrayBuffer()
  const contentType = file.type || 'image/png'

  const result = await lineApiRequest(
    'POST',
    `/richmenu/${richMenuId}/content`,
    accessToken,
    imageBuffer,
    contentType
  )

  if (!result.ok) {
    return c.json({
      success: false,
      error: 'Failed to upload image',
      detail: result.data,
    }, 500)
  }

  return ok(c, { message: 'Image uploaded', richMenuId })
})

// ===================================================================
// DELETE /api/admin/rich-menu/:richMenuId
// ===================================================================

richMenuRouter.delete('/:richMenuId', async (c) => {
  const payload = c.get('jwtPayload')
  if (payload.role !== 'superadmin') {
    return c.json({ success: false, error: 'Superadmin access required' }, 403)
  }

  const richMenuId = c.req.param('richMenuId')
  const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN

  const result = await lineApiRequest('DELETE', `/richmenu/${richMenuId}`, accessToken)

  if (!result.ok) {
    return c.json({ success: false, error: 'Failed to delete', detail: result.data }, 500)
  }

  return ok(c, { message: 'Rich menu deleted', richMenuId })
})

export default richMenuRouter
