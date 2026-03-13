-- E2E テスト用シードデータ
-- 実行: npx wrangler d1 execute diet-bot-production --local --file=./tests/e2e-seed.sql
--
-- 注意: このファイルは seed.sql（基盤データ）の投入後に実行すること。
-- seed.sql が accounts, line_channels, intake_forms, account_memberships 等を作成する。

-- E2E テスト用招待コードの削除＆再作成
DELETE FROM invite_code_usages WHERE invite_code_id IN (SELECT id FROM invite_codes WHERE code LIKE 'TST-%');
DELETE FROM invite_codes WHERE code LIKE 'TST-%';

-- 招待コード作成 (TC1-TC9 用) - 個別 INSERT 文
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_001', 'TST-0001', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC1', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_002', 'TST-0002', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC2', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_003', 'TST-0003', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC3', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_005', 'TST-0005', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC5', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_006', 'TST-0006', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC6', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_007', 'TST-0007', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC7', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_008', 'TST-0008', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC8', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
INSERT INTO invite_codes (id, code, account_id, created_by, label, max_uses, use_count, status, expires_at, created_at, updated_at) VALUES
  ('ic_e2e_009', 'TST-0009', 'acc_client_00000000000000000000000000000001', 'mem_admin_00000000000000000000000000000001', 'E2E TC9', 1, 0, 'active', NULL, datetime('now'), datetime('now'));
