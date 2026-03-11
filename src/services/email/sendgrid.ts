/**
 * src/services/email/sendgrid.ts
 * SendGrid メール送信サービス
 */

import { fetchWithTimeout, TIMEOUT } from '../../utils/fetch-with-timeout'

export interface EmailOptions {
  to: string
  toName?: string
  subject: string
  html: string
  text?: string
}

export async function sendEmail(
  opts: EmailOptions,
  apiKey: string,
  fromEmail: string,
  fromName: string
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      'https://api.sendgrid.com/v3/mail/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [
            { to: [{ email: opts.to, name: opts.toName ?? opts.to }] },
          ],
          from: { email: fromEmail, name: fromName },
          subject: opts.subject,
          content: [
            { type: 'text/plain', value: opts.text ?? opts.subject },
            { type: 'text/html',  value: opts.html },
          ],
        }),
      },
      TIMEOUT.SENDGRID
    )
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error(`[SendGrid] send failed ${res.status}: ${err}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[SendGrid] error:', e)
    return false
  }
}

// ─── メールテンプレート ───────────────────────────────────────

export function buildInviteEmail(params: {
  inviteeEmail: string
  inviterName: string
  accountName: string
  role: string
  inviteUrl: string
  expiresHours: number
}): EmailOptions {
  const roleLabel = params.role === 'admin' ? '管理者' : 'スタッフ'
  return {
    to: params.inviteeEmail,
    subject: `【diet-bot】${params.accountName} への招待`,
    text: `${params.inviteeEmail} 様\n\n${params.inviterName}から ${params.accountName} (${roleLabel}) として招待されました。\n\n${params.inviteUrl}\n\n有効期限: ${params.expiresHours}時間`,
    html: `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
<h2 style="color:#2563eb;">diet-bot への招待</h2>
<p>${params.inviteeEmail} 様</p>
<p><strong>${params.inviterName}</strong> さんから <strong>${params.accountName}</strong> に
<span style="background:#dbeafe;padding:2px 8px;border-radius:4px;">${roleLabel}</span> として招待されました。</p>
<p style="margin:24px 0;">
  <a href="${params.inviteUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    招待を受け入れてパスワードを設定する
  </a>
</p>
<p style="color:#6b7280;font-size:13px;">このリンクの有効期限は ${params.expiresHours} 時間です。</p>
</body></html>`,
  }
}

export function buildPasswordResetEmail(params: {
  email: string
  resetUrl: string
  expiresMinutes: number
}): EmailOptions {
  return {
    to: params.email,
    subject: '【diet-bot】パスワード再設定',
    text: `パスワード再設定リンク:\n${params.resetUrl}\n\n有効期限: ${params.expiresMinutes}分`,
    html: `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
<h2 style="color:#2563eb;">パスワード再設定</h2>
<p>以下のボタンからパスワードを再設定してください。</p>
<p style="margin:24px 0;">
  <a href="${params.resetUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    パスワードを再設定する
  </a>
</p>
<p style="color:#6b7280;font-size:13px;">このリンクの有効期限は ${params.expiresMinutes} 分です。<br>
身に覚えがない場合は無視してください。</p>
</body></html>`,
  }
}

export function buildWelcomeAdminEmail(params: {
  email: string
  name: string
  loginUrl: string
}): EmailOptions {
  return {
    to: params.email,
    toName: params.name,
    subject: '【diet-bot】管理者アカウントが作成されました',
    text: `${params.name} 様\n\n管理者アカウントが作成されました。\nログイン: ${params.loginUrl}`,
    html: `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
<h2 style="color:#2563eb;">管理者アカウント作成完了</h2>
<p>${params.name} 様</p>
<p>diet-bot の管理者アカウントが作成されました。</p>
<p style="margin:24px 0;">
  <a href="${params.loginUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    管理画面にログイン
  </a>
</p>
</body></html>`,
  }
}
