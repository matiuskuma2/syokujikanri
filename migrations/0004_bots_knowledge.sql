-- =============================================================
-- Migration 0004: BOT・ナレッジ管理
-- =============================================================

-- BOT（チャンネルに紐づくBOT設定）
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bot_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('line','web')) DEFAULT 'line',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BOTバージョン（プロンプト・設定履歴）
CREATE TABLE IF NOT EXISTS bot_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT,
  config TEXT, -- JSON: mode settings
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, version_number)
);

-- ナレッジベース（Q&A・知識データ）
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_id TEXT, -- NULL = システム共通
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ナレッジドキュメント
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BOT↔ナレッジベース紐付け
CREATE TABLE IF NOT EXISTS bot_knowledge_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, knowledge_base_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_bots_account_id ON bots(account_id);
CREATE INDEX IF NOT EXISTS idx_bots_bot_key ON bots(bot_key);
CREATE INDEX IF NOT EXISTS idx_bot_versions_bot_id ON bot_versions(bot_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_account_id ON knowledge_bases(account_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb_id ON knowledge_documents(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_bot_knowledge_links_bot_id ON bot_knowledge_links(bot_id);
