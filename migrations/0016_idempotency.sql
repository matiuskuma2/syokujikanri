-- R5: Webhook Idempotency (docs/15_実装前確定ルールSSOT.md)
-- 同一 line_message_id の webhook 重複処理を防止するための UNIQUE インデックス
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_messages_line_msg_id
  ON conversation_messages(line_message_id)
  WHERE line_message_id IS NOT NULL;
