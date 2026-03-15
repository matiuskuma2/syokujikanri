/**
 * trace.ts
 * LINE メッセージ処理の1メッセージ=1トレース追跡
 *
 * 各メッセージ処理の全ステップを1本のトレースで追跡し、
 * 最後に構造化ログとして出力する。
 * これにより、無応答の原因を即座に特定できる。
 */

export type TraceEntry = {
  /** 一意のトレースID */
  traceId: string
  /** LINE user ID */
  lineUserId: string
  /** LINE message ID */
  lineMessageId: string
  /** 受信テキスト（先頭50文字） */
  text: string
  /** 処理開始時刻 */
  startedAt: number
  /** 処理前の状態 */
  stateBefore: {
    currentMode: string | null
    currentStep: string | null
    hasPendingImageConfirm: boolean
    hasPendingClarification: boolean
  }
  /** AI解釈の結果 */
  intent: {
    primary: string | null
    secondary: string | null
    confidence: number | null
    fallbackUsed: string | null
  }
  /** 選択されたハンドラー */
  chosenHandler: string | null
  /** 送信結果 */
  replyResult: 'success' | 'failed' | 'skipped' | null
  pushResult: 'success' | 'failed' | 'skipped' | null
  /** 処理後の状態 */
  stateAfter: {
    currentMode: string | null
    currentStep: string | null
  }
  /** エラー情報 */
  error: string | null
  /** 応答が送られたか（最重要フラグ） */
  responseSent: boolean
}

/**
 * 新しいトレースを作成する
 */
export function createTrace(lineUserId: string, lineMessageId: string, text: string): TraceEntry {
  return {
    traceId: `t_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
    lineUserId,
    lineMessageId,
    text: text.substring(0, 50),
    startedAt: Date.now(),
    stateBefore: {
      currentMode: null,
      currentStep: null,
      hasPendingImageConfirm: false,
      hasPendingClarification: false,
    },
    intent: {
      primary: null,
      secondary: null,
      confidence: null,
      fallbackUsed: null,
    },
    chosenHandler: null,
    replyResult: null,
    pushResult: null,
    stateAfter: {
      currentMode: null,
      currentStep: null,
    },
    error: null,
    responseSent: false,
  }
}

/**
 * トレースを構造化ログとして出力する
 * 1メッセージの全処理結果が1行で見える
 */
export function flushTrace(trace: TraceEntry): void {
  const elapsed = Date.now() - trace.startedAt
  console.log(JSON.stringify({
    event: 'MESSAGE_TRACE',
    trace_id: trace.traceId,
    line_user_id: trace.lineUserId,
    line_message_id: trace.lineMessageId,
    text: trace.text,
    elapsed_ms: elapsed,
    state_before: trace.stateBefore,
    intent: trace.intent,
    chosen_handler: trace.chosenHandler,
    reply_result: trace.replyResult,
    push_result: trace.pushResult,
    state_after: trace.stateAfter,
    error: trace.error,
    response_sent: trace.responseSent,
  }))

  // ★ 無応答検知: responseSent が false のまま終わった場合は CRITICAL ログ
  if (!trace.responseSent) {
    console.error(JSON.stringify({
      event: 'NO_RESPONSE_DETECTED',
      trace_id: trace.traceId,
      line_user_id: trace.lineUserId,
      text: trace.text,
      chosen_handler: trace.chosenHandler,
      reply_result: trace.replyResult,
      push_result: trace.pushResult,
      error: trace.error,
    }))
  }
}

/**
 * 安全に応答を送信し、結果をトレースに記録する
 * reply → push のフォールバック付き
 * 
 * @param strategy 'reply_first' | 'push_first'
 *   - reply_first: replyToken が有効な場合（OpenAI呼び出し前）
 *   - push_first: replyToken が期限切れの可能性がある場合（OpenAI呼び出し後）
 */
export async function sendResponse(
  trace: TraceEntry,
  opts: {
    replyToken: string
    lineUserId: string
    accessToken: string
    strategy: 'reply_first' | 'push_first'
  },
  sendReply: () => Promise<void>,
  sendPush: () => Promise<void>,
): Promise<void> {
  if (opts.strategy === 'reply_first') {
    // reply 優先
    try {
      await sendReply()
      trace.replyResult = 'success'
      trace.responseSent = true
      return
    } catch (replyErr) {
      trace.replyResult = 'failed'
      console.warn(`[Trace ${trace.traceId}] reply failed, trying push:`, replyErr)
    }
    // push フォールバック
    try {
      await sendPush()
      trace.pushResult = 'success'
      trace.responseSent = true
    } catch (pushErr) {
      trace.pushResult = 'failed'
      console.error(`[Trace ${trace.traceId}] push fallback also failed:`, pushErr)
    }
  } else {
    // push 優先（OpenAI 後）
    try {
      await sendPush()
      trace.pushResult = 'success'
      trace.responseSent = true
      return
    } catch (pushErr) {
      trace.pushResult = 'failed'
      console.warn(`[Trace ${trace.traceId}] push failed, trying reply:`, pushErr)
    }
    // reply フォールバック
    try {
      await sendReply()
      trace.replyResult = 'success'
      trace.responseSent = true
    } catch (replyErr) {
      trace.replyResult = 'failed'
      console.error(`[Trace ${trace.traceId}] reply fallback also failed:`, replyErr)
    }
  }
}

/**
 * エラー時の最終手段: 何が何でもユーザーに通知する
 */
export async function emergencyRespond(
  trace: TraceEntry,
  lineUserId: string,
  accessToken: string,
  replyToken: string,
  pushTextFn: (userId: string, text: string, token: string) => Promise<void>,
  replyTextFn: (token: string, text: string, accessToken: string) => Promise<void>,
): Promise<void> {
  const msg = '⚠️ 処理中にエラーが発生しました。もう一度送り直してください。'
  try {
    await pushTextFn(lineUserId, msg, accessToken)
    trace.pushResult = 'success'
    trace.responseSent = true
  } catch {
    try {
      await replyTextFn(replyToken, msg, accessToken)
      trace.replyResult = 'success'
      trace.responseSent = true
    } catch {
      // 全滅
      trace.pushResult = 'failed'
      trace.replyResult = 'failed'
    }
  }
}
