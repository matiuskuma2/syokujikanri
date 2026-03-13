-- =============================================================
-- seed.sql
-- ローカル開発用テストデータ（--local フラグで投入）
-- 本番環境には絶対に投入しないこと！
--
-- 使用方法:
--   npx wrangler d1 execute diet-bot-production --local --file=./seed.sql
-- =============================================================

-- ===================================================================
-- 1. Accounts（契約アカウント）
-- ===================================================================

-- システムアカウント（内部管理用）
INSERT OR IGNORE INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
VALUES (
  'acc_system_00000000000000000000000000000001',
  'demo',
  '[SYSTEM] diet-bot Internal',
  'active',
  'Asia/Tokyo',
  'ja',
  datetime('now'),
  datetime('now')
);

-- クライアントアカウント（テスト用クリニック）
INSERT OR IGNORE INTO accounts (id, type, name, status, timezone, locale, created_at, updated_at)
VALUES (
  'acc_client_00000000000000000000000000000001',
  'clinic',
  'テストクリニック（ローカル開発用）',
  'active',
  'Asia/Tokyo',
  'ja',
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 2. Account Memberships（管理ユーザー）
-- ===================================================================

-- スーパー管理者
INSERT OR IGNORE INTO account_memberships (id, account_id, user_id, email, role, status, created_at)
VALUES (
  'mem_superadmin_0000000000000000000000000001',
  'acc_system_00000000000000000000000000000001',
  'usr_superadmin_000000000000000000000000001',
  'admin@diet-bot.local',
  'superadmin',
  'active',
  datetime('now')
);

-- クライアントアカウント管理者
INSERT OR IGNORE INTO account_memberships (id, account_id, user_id, email, role, status, created_at)
VALUES (
  'mem_admin_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'usr_admin_0000000000000000000000000000001',
  'clinic-admin@diet-bot.local',
  'admin',
  'active',
  datetime('now')
);

-- ===================================================================
-- 3. Subscriptions（プラン）
-- ===================================================================

INSERT OR IGNORE INTO subscriptions (
  id, account_id, plan, status, max_users,
  current_period_start, current_period_end, created_at, updated_at
)
VALUES (
  'sub_client_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'pro',
  'active',
  100,
  datetime('now'),
  datetime('now', '+365 days'),
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 4. LINE Channels（LINEチャンネル設定）
-- ===================================================================

-- LINE チャンネル（Messaging API: 食事指導BOT）
-- Messaging API Channel ID: 1656660870
-- LIFF Channel ID: 2009409790 (LINE Login), LIFF ID: 2009409790-DekZRh4t
--
-- WARNING: 'ch_default_replace_me' はプレースホルダー。
--          .dev.vars の LINE_CHANNEL_ID と必ず一致させること。
--          本番では実際の UUID に置き換えること。
--
-- NOTE: channel_secret / access_token はダミー値。
--       実際の値は .dev.vars (ローカル) または wrangler secret (本番) で管理する。
--       seed.sql は DB スキーマの初期レコード挿入のみを目的とする。
INSERT OR IGNORE INTO line_channels (
  id, account_id, channel_id, channel_secret, access_token,
  webhook_path, is_active, created_at, updated_at
)
VALUES (
  'ch_default_replace_me',
  'acc_client_00000000000000000000000000000001',
  '1656660870',
  'DUMMY_CHANNEL_SECRET_REPLACE_IN_DEV_VARS',
  'DUMMY_ACCESS_TOKEN_REPLACE_IN_DEV_VARS',
  '/api/webhooks/line',
  1,
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 4b. Intake Forms（問診フォーム定義）
-- intake_answers.intake_form_id FK のために必要
-- ===================================================================

INSERT OR IGNORE INTO intake_forms (id, account_id, name, description, is_active, order_index, created_at, updated_at)
VALUES (
  'default_intake',
  'acc_client_00000000000000000000000000000001',
  'デフォルト初回問診',
  'LINE BOT 初回ヒアリング（9問）',
  1,
  0,
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 5. BOT 設定
-- ===================================================================

-- クライアント用 BOT
INSERT OR IGNORE INTO bots (
  id, account_id, name, bot_key, type, is_active, current_version_id, created_at, updated_at
)
VALUES (
  'bot_client_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'ダイエットサポートBOT',
  'diet-support-bot-v1',
  'line',
  1,
  'bv_client_000000000000000000000000000001v1',
  datetime('now'),
  datetime('now')
);

-- BOT バージョン 1（運用レベル system_prompt）
INSERT OR IGNORE INTO bot_versions (
  id, bot_id, version_number, system_prompt, is_published, created_at
)
VALUES (
  'bv_client_000000000000000000000000000001v1',
  'bot_client_00000000000000000000000000000001',
  1,
  'あなたは「食事指導BOT」のAIアシスタントです。LINE上でユーザーのダイエット・食事管理をサポートします。

## 基本ルール
- 常に日本語で、丁寧かつ親しみやすい口調で応答（敬語＋絵文字OK）
- 回答は300文字以内で簡潔にまとめる
- 医療診断・処方は絶対に行わない。気になる症状は「専門医への相談をお勧めします」と促す
- サプリメント・特定商品の推奨はしない
- ユーザーのプロフィール情報（身長・体重・目標・活動レベル等）が提供された場合、それに基づいた個別アドバイスを行う
- 過去の体重推移・食事記録が提供された場合、トレンドを踏まえてコメントする

## 応答パターン
### 食事記録への反応
- 良い食事: 具体的に何が良いか1つ伝え、励ます
- 改善点がある食事: まず良い点を1つ褒め、改善提案を1つだけ（否定しない）
- PFCバランスが偏っている場合: 不足している栄養素と手軽な補い方を提案

### 体重記録への反応
- 減少傾向: 具体的な数値に触れて「順調ですね！」系コメント
- 増加傾向: 「体重は水分で1-2kg変動するので気にしすぎないで」と安心させつつ、食事内容を確認
- 横ばい: 「停滞期は体が調整中。続けることが大事」と励ます

### 相談モード
- ユーザーの質問に対して、科学的根拠に基づいた回答をする
- 参考ナレッジが提供された場合、その情報を活用して回答する
- 曖昧な質問には「具体的にはどんな点が気になりますか？」と掘り下げる

## 禁止事項
- 極端な食事制限（1日1食、断食等）を推奨しない
- 「痩せろ」「太っている」等のネガティブな表現を使わない
- 他のユーザーとの比較をしない
- 根拠のない情報を提供しない',
  1,
  datetime('now')
);

-- ===================================================================
-- 6. ナレッジベース
-- ===================================================================

-- 共通ナレッジベース（全アカウント共通）
INSERT OR IGNORE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_common_000000000000000000000000000001',
  NULL,  -- NULL = システム共通
  '栄養・ダイエット基礎知識',
  '一般的なダイエット・栄養に関する基礎知識',
  1,
  10,
  datetime('now'),
  datetime('now')
);

-- クライアント固有ナレッジベース
INSERT OR IGNORE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_client_000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'テストクリニック独自FAQ',
  'クリニック固有のFAQ・指導方針',
  1,
  20,
  datetime('now'),
  datetime('now')
);

-- BOT ↔ ナレッジ紐付け
INSERT OR IGNORE INTO bot_knowledge_links (
  id, bot_id, knowledge_base_id, priority, created_at
)
VALUES (
  'bkl_0000000000000000000000000000000001',
  'bot_client_00000000000000000000000000000001',
  'kb_common_000000000000000000000000000001',
  10,
  datetime('now')
);

INSERT OR IGNORE INTO bot_knowledge_links (
  id, bot_id, knowledge_base_id, priority, created_at
)
VALUES (
  'bkl_0000000000000000000000000000000002',
  'bot_client_00000000000000000000000000000001',
  'kb_client_000000000000000000000000000001',
  20,
  datetime('now')
);

-- ===================================================================
-- 6.5 ナレッジドキュメント（初期知識データ）
-- ===================================================================

-- 共通知識: PFCバランス基礎
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000001',
  'kb_common_000000000000000000000000000001',
  'PFCバランスの基礎',
  'PFCバランスとは、タンパク質(Protein)・脂質(Fat)・炭水化物(Carbohydrate)の摂取比率のこと。一般的なダイエットの推奨比率はP:F:C=30:20:50。タンパク質は体重×1.2〜2.0g/日（運動量により変動）。脂質は総カロリーの20〜25%。炭水化物は残りで調整。極端な糖質制限は長期的にリバウンドリスクが高い。',
  1, 10, datetime('now'), datetime('now')
);

-- 共通知識: 基礎代謝と消費カロリー
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000002',
  'kb_common_000000000000000000000000000001',
  '基礎代謝と消費カロリー計算',
  '基礎代謝(BMR)の計算式（Harris-Benedict改良版）: 男性=13.397×体重kg+4.799×身長cm-5.677×年齢+88.362。女性=9.247×体重kg+3.098×身長cm-4.330×年齢+447.593。活動代謝(TDEE)=BMR×活動係数。活動係数: 座り仕事中心=1.2、軽い運動=1.375、週3-5回運動=1.55、毎日激しく運動=1.725。減量には1日あたりTDEE-500kcal程度の摂取カロリーが目安（週0.5kg減ペース）。',
  1, 10, datetime('now'), datetime('now')
);

-- 共通知識: 食事タイミングと頻度
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000003',
  'kb_common_000000000000000000000000000001',
  '食事タイミングと頻度のポイント',
  '1日3食を基本とし規則正しい時間に食べる。朝食を抜くと昼食での過食リスクが上がる。夕食は就寝3時間前までに済ませるのが理想。間食は200kcal以内を目安にし、タンパク質を含むもの（ヨーグルト、ナッツ等）が望ましい。空腹時間が長すぎると筋肉分解が進むため、6時間以上空けないことを推奨。水分は1日2L以上を目安に（水・お茶が中心）。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 運動とダイエット
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000004',
  'kb_common_000000000000000000000000000001',
  '運動とダイエットの関係',
  '有酸素運動（ウォーキング、ジョギング、水泳等）は脂肪燃焼に効果的。週150分以上の中程度の有酸素運動が推奨。筋トレは基礎代謝の維持・向上に不可欠。食事制限のみでは筋肉量が減少し、リバウンドしやすくなる。NEAT（非運動性活動熱産生）の増加も重要：階段を使う、歩く距離を増やす等。運動後30分以内のタンパク質摂取が筋肉回復に効果的。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 体重の変動について
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000005',
  'kb_common_000000000000000000000000000001',
  '体重の日内変動と正しい測り方',
  '体重は1日で1〜2kg変動するのが正常。水分、食事、排泄、運動で変わる。毎日同じ条件（朝起きてトイレ後、食事前）で測定するのがベスト。週単位の平均値で推移を見ることが重要。生理周期（女性）では2〜3kg増えることもある。1日で1kg体重が増えても、それは脂肪ではなく水分の可能性が高い。1kgの脂肪を蓄えるには約7200kcalの過剰摂取が必要。',
  1, 9, datetime('now'), datetime('now')
);

-- 共通知識: 日本食のカロリー目安
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000006',
  'kb_common_000000000000000000000000000001',
  '日本食の一般的なカロリー目安',
  '白米1膳(150g)=234kcal。食パン1枚(6枚切り)=158kcal。味噌汁1杯=50kcal。焼き魚(鮭1切れ)=130kcal。鶏胸肉100g=120kcal。牛丼=700kcal前後。カレーライス=750kcal前後。ラーメン=500〜800kcal。サラダ(ドレッシング込み)=100〜200kcal。コンビニおにぎり1個=170〜250kcal。コンビニサンドイッチ=250〜350kcal。コンビニサラダ=70〜150kcal。',
  1, 9, datetime('now'), datetime('now')
);

-- 共通知識: 外食・コンビニメニューの選び方
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000007',
  'kb_common_000000000000000000000000000001',
  '外食・コンビニでのヘルシー選択',
  'コンビニ: サラダチキン(110kcal/高タンパク)、ゆで卵(80kcal)、豆腐(60kcal)がおすすめ。揚げ物・菓子パンは避ける。ファミレス: グリルチキン、魚定食を選択。ご飯は少なめに。ファストフード: セットよりも単品＋サラダ。ドリンクは水かお茶。居酒屋: 枝豆、冷奴、刺身、焼き鳥（塩）がダイエット向き。ビールは1杯140kcal、ハイボール70kcal。',
  1, 7, datetime('now'), datetime('now')
);

-- 共通知識: よくある質問
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000008',
  'kb_common_000000000000000000000000000001',
  'ダイエットFAQ',
  'Q:停滞期はどうすれば？ A:体重が2〜4週間変わらないのは正常。食事内容を見直し、運動の種類を変えてみる。チートデイ（週1回普通に食べる日）も有効。Q:お酒は飲んでいい？ A:週2日以下、1回2杯以内なら大きな影響は少ない。蒸留酒（ハイボール、焼酎）が低カロリー。Q:夜食は太る？ A:時間帯より総カロリーが重要。ただし就寝前の食事は消化不良の原因に。Q:サプリメントは必要？ A:バランスの良い食事が基本。不足しがちなのはビタミンD、鉄分、食物繊維。',
  1, 7, datetime('now'), datetime('now')
);

-- 共通知識: 睡眠とダイエット
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000009',
  'kb_common_000000000000000000000000000001',
  '睡眠とダイエットの関係',
  '睡眠不足はダイエットの大敵。睡眠が6時間未満だと食欲ホルモン（グレリン）が増加し、満腹ホルモン（レプチン）が減少する。結果的に翌日の食欲が20-30%増加。理想は7-8時間の睡眠。就寝前のスマホ使用はブルーライトでメラトニン分泌を抑制するため、就寝1時間前には控える。カフェインの影響は6-8時間続くため、午後3時以降のコーヒーは避ける。質の良い睡眠のためには：規則正しい就寝時間、寝室の温度18-22度、入浴は就寝90分前が最適。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: ストレスと過食
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000010',
  'kb_common_000000000000000000000000000001',
  'ストレスと過食の対処法',
  'ストレスを感じるとコルチゾール（ストレスホルモン）が増加し、高カロリー食への欲求が高まる。ストレス食いの対策：①感情と食欲を区別する（本当にお腹が空いているか自問する）②食べたい衝動が来たら5分間待つ（衝動は通常5-10分で収まる）③代替行動を用意する（散歩、深呼吸、ストレッチ等）④食べる場合は量を決めてから食べ始める。「食べてしまった」自己嫌悪は逆効果。1回の過食で太ることはない。長期的なトレンドが重要。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 女性特有のダイエット注意点
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000011',
  'kb_common_000000000000000000000000000001',
  '女性特有のダイエット注意点',
  '生理周期によって体重が2-3kg変動するのは正常。黄体期（生理前1-2週間）はむくみやすく体重が増加傾向。この時期の体重増加は脂肪ではなく水分。生理中は無理な食事制限を避け、鉄分豊富な食品（赤身肉、ほうれん草、レバー）を意識的に摂取。エストロゲン低下期（更年期）は基礎代謝が低下するため、筋トレによる筋量維持が特に重要。BMI18.5未満や体脂肪率17%以下は月経不順のリスクがあるため、これ以上の減量は医師に相談を。',
  1, 8, datetime('now'), datetime('now')
);

-- 共通知識: 筋トレ初心者ガイド
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_common_0000000000000000000000000012',
  'kb_common_000000000000000000000000000001',
  '筋トレ初心者ガイド',
  '筋トレはダイエットの強力な味方。筋肉1kgあたり1日13kcalの基礎代謝増加。初心者は週2-3回、各30分程度から開始。自宅でできる基本種目：スクワット（大腿四頭筋・臀筋）、プッシュアップ（大胸筋・三頭筋）、プランク（体幹）。各10回×3セット、セット間60秒休憩が目安。フォーム優先で回数は後から増やす。筋肉痛がある部位は48-72時間休ませる。体重が変わらなくても体組成が変わっている場合がある（筋肉増・脂肪減）ため、見た目やウエストサイズも記録するとよい。',
  1, 7, datetime('now'), datetime('now')
);

-- クライアント固有: 食事指導のガイドライン
INSERT OR IGNORE INTO knowledge_documents (
  id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at
) VALUES (
  'kd_client_0000000000000000000000000001',
  'kb_client_000000000000000000000000000001',
  '食事指導BOT 運用ガイドライン',
  'このBOTはクリニック・パーソナルジム等が顧客のダイエットサポートに利用するシステムです。【指導方針】①急激な減量（月4kg以上）は推奨しない。目安は月1-2kg。②食事写真から自動解析されたPFCは目安値であり、正確な栄養計算ではないことをユーザーに伝える。③継続が最も重要。完璧を求めず「昨日より少し良い選択」を促す。④問診で収集した情報（目標体重、運動習慣、悩み等）に基づき個別化したアドバイスを行う。⑤週次レポートでは1週間の平均値とトレンドで評価し、日々の変動を過度に気にしないよう指導。',
  1, 10, datetime('now'), datetime('now')
);

-- ===================================================================
-- 7. テスト用 LINE ユーザー・UserAccount
-- ===================================================================

-- テストユーザー 1（フォロー済み）
INSERT OR IGNORE INTO line_users (
  id, line_channel_id, line_user_id, display_name, picture_url,
  follow_status, first_seen_at, last_seen_at
)
VALUES (
  'lu_test_0000000000000000000000000000001',
  'ch_default_replace_me',
  'U_test_line_user_id_000001',
  'テストユーザー田中',
  NULL,
  'following',
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 1 の UserAccount
INSERT OR IGNORE INTO user_accounts (
  id, line_user_id, client_account_id, status, joined_at, created_at, updated_at
)
VALUES (
  'ua_test_0000000000000000000000000000001',
  'U_test_line_user_id_000001',
  'acc_client_00000000000000000000000000000001',
  'active',
  datetime('now', '-7 days'),
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 1 のサービスステータス
INSERT OR IGNORE INTO user_service_statuses (
  id, account_id, line_user_id,
  bot_enabled, record_enabled, consult_enabled, intake_completed,
  created_at, updated_at
)
VALUES (
  'uss_test_000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'U_test_line_user_id_000001',
  1, 1, 1, 1,
  datetime('now', '-7 days'),
  datetime('now')
);

-- テストユーザー 2（新規ユーザー）
INSERT OR IGNORE INTO line_users (
  id, line_channel_id, line_user_id, display_name, picture_url,
  follow_status, first_seen_at, last_seen_at
)
VALUES (
  'lu_test_0000000000000000000000000000002',
  'ch_default_replace_me',
  'U_test_line_user_id_000002',
  'テストユーザー鈴木',
  NULL,
  'following',
  datetime('now', '-1 days'),
  datetime('now')
);

-- テストユーザー 2 の UserAccount
INSERT OR IGNORE INTO user_accounts (
  id, line_user_id, client_account_id, status, joined_at, created_at, updated_at
)
VALUES (
  'ua_test_0000000000000000000000000000002',
  'U_test_line_user_id_000002',
  'acc_client_00000000000000000000000000000001',
  'active',
  datetime('now', '-1 days'),
  datetime('now', '-1 days'),
  datetime('now')
);

-- テストユーザー 2 のサービスステータス（未インテーク）
INSERT OR IGNORE INTO user_service_statuses (
  id, account_id, line_user_id,
  bot_enabled, record_enabled, consult_enabled, intake_completed,
  created_at, updated_at
)
VALUES (
  'uss_test_000000000000000000000000000002',
  'acc_client_00000000000000000000000000000001',
  'U_test_line_user_id_000002',
  1, 1, 1, 0,
  datetime('now', '-1 days'),
  datetime('now')
);

-- ===================================================================
-- 8. テスト用 DailyLog・BodyMetrics（過去7日分）
-- ===================================================================

-- テストユーザー1の今日の日次ログ
INSERT OR IGNORE INTO daily_logs (
  id, user_account_id, client_account_id, log_date, source, completion_status, created_at, updated_at
)
VALUES (
  'dl_test_00000000000000000000000000000001',
  'ua_test_0000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  date('now'),
  'line',
  'partial',
  datetime('now'),
  datetime('now')
);

-- 今日の体型測定（体重）
INSERT OR IGNORE INTO body_metrics (
  id, daily_log_id, weight_kg, created_at, updated_at
)
VALUES (
  'bm_test_00000000000000000000000000000001',
  'dl_test_00000000000000000000000000000001',
  65.2,
  datetime('now'),
  datetime('now')
);

-- 今日の食事記録（朝食）
INSERT OR IGNORE INTO meal_entries (
  id, daily_log_id, meal_type, meal_text, calories_kcal,
  protein_g, fat_g, carbs_g, confirmation_status, created_at, updated_at
)
VALUES (
  'me_test_00000000000000000000000000000001',
  'dl_test_00000000000000000000000000000001',
  'breakfast',
  '玄米ご飯、味噌汁、納豆',
  450,
  18.5,
  8.2,
  72.0,
  'confirmed',
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 確認クエリ（コメントアウト済み — 必要に応じて有効化）
-- ===================================================================
-- SELECT 'accounts:', count(*) FROM accounts;
-- SELECT 'line_channels:', count(*) FROM line_channels;
-- SELECT 'line_users:', count(*) FROM line_users;
-- SELECT 'user_accounts:', count(*) FROM user_accounts;
-- SELECT 'bots:', count(*) FROM bots;
-- SELECT 'knowledge_bases:', count(*) FROM knowledge_bases;
-- SELECT 'daily_logs:', count(*) FROM daily_logs;
-- SELECT 'body_metrics:', count(*) FROM body_metrics;
-- SELECT 'meal_entries:', count(*) FROM meal_entries;
