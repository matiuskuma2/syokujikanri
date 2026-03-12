-- =============================================================
-- seed-production.sql
-- 本番環境用 BOT・ナレッジデータ投入
--
-- 使用方法（本番DBへ直接投入）:
--   npx wrangler d1 execute diet-bot-production --file=./seed-production.sql
--
-- ※ accounts / memberships / subscriptions / line_channels は
--   admin画面から手動で作成済みであることを前提とする
-- ※ テストユーザーは含まない
-- =============================================================

-- ===================================================================
-- 1. BOT 設定（既存レコードがなければ挿入）
-- ===================================================================

-- クライアント用 BOT
-- NOTE: account_id は admin 画面で作成した accounts.id に合わせて変更すること
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

-- ===================================================================
-- 2. BOT バージョン（運用レベル system_prompt）
-- ===================================================================

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
-- 3. ナレッジベース
-- ===================================================================

-- 共通ナレッジベース（全アカウント共通）
INSERT OR IGNORE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_common_000000000000000000000000000001',
  NULL,
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
  '食事指導BOT運用ナレッジ',
  'BOT運用ガイドライン・指導方針',
  1,
  20,
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 4. BOT ↔ ナレッジ紐付け
-- ===================================================================

INSERT OR IGNORE INTO bot_knowledge_links (id, bot_id, knowledge_base_id, priority, created_at)
VALUES ('bkl_0000000000000000000000000000000001', 'bot_client_00000000000000000000000000000001', 'kb_common_000000000000000000000000000001', 10, datetime('now'));

INSERT OR IGNORE INTO bot_knowledge_links (id, bot_id, knowledge_base_id, priority, created_at)
VALUES ('bkl_0000000000000000000000000000000002', 'bot_client_00000000000000000000000000000001', 'kb_client_000000000000000000000000000001', 20, datetime('now'));

-- ===================================================================
-- 5. ナレッジドキュメント（共通知識 12件 + クライアント固有 1件）
-- ===================================================================

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000001', 'kb_common_000000000000000000000000000001', 'PFCバランスの基礎', 'PFCバランスとは、タンパク質(Protein)・脂質(Fat)・炭水化物(Carbohydrate)の摂取比率のこと。一般的なダイエットの推奨比率はP:F:C=30:20:50。タンパク質は体重×1.2〜2.0g/日（運動量により変動）。脂質は総カロリーの20〜25%。炭水化物は残りで調整。極端な糖質制限は長期的にリバウンドリスクが高い。', 1, 10, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000002', 'kb_common_000000000000000000000000000001', '基礎代謝と消費カロリー計算', '基礎代謝(BMR)の計算式（Harris-Benedict改良版）: 男性=13.397×体重kg+4.799×身長cm-5.677×年齢+88.362。女性=9.247×体重kg+3.098×身長cm-4.330×年齢+447.593。活動代謝(TDEE)=BMR×活動係数。活動係数: 座り仕事中心=1.2、軽い運動=1.375、週3-5回運動=1.55、毎日激しく運動=1.725。減量には1日あたりTDEE-500kcal程度の摂取カロリーが目安（週0.5kg減ペース）。', 1, 10, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000003', 'kb_common_000000000000000000000000000001', '食事タイミングと頻度のポイント', '1日3食を基本とし規則正しい時間に食べる。朝食を抜くと昼食での過食リスクが上がる。夕食は就寝3時間前までに済ませるのが理想。間食は200kcal以内を目安にし、タンパク質を含むもの（ヨーグルト、ナッツ等）が望ましい。空腹時間が長すぎると筋肉分解が進むため、6時間以上空けないことを推奨。水分は1日2L以上を目安に（水・お茶が中心）。', 1, 8, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000004', 'kb_common_000000000000000000000000000001', '運動とダイエットの関係', '有酸素運動（ウォーキング、ジョギング、水泳等）は脂肪燃焼に効果的。週150分以上の中程度の有酸素運動が推奨。筋トレは基礎代謝の維持・向上に不可欠。食事制限のみでは筋肉量が減少し、リバウンドしやすくなる。NEAT（非運動性活動熱産生）の増加も重要：階段を使う、歩く距離を増やす等。運動後30分以内のタンパク質摂取が筋肉回復に効果的。', 1, 8, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000005', 'kb_common_000000000000000000000000000001', '体重の日内変動と正しい測り方', '体重は1日で1〜2kg変動するのが正常。水分、食事、排泄、運動で変わる。毎日同じ条件（朝起きてトイレ後、食事前）で測定するのがベスト。週単位の平均値で推移を見ることが重要。生理周期（女性）では2〜3kg増えることもある。1日で1kg体重が増えても、それは脂肪ではなく水分の可能性が高い。1kgの脂肪を蓄えるには約7200kcalの過剰摂取が必要。', 1, 9, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000006', 'kb_common_000000000000000000000000000001', '日本食の一般的なカロリー目安', '白米1膳(150g)=234kcal。食パン1枚(6枚切り)=158kcal。味噌汁1杯=50kcal。焼き魚(鮭1切れ)=130kcal。鶏胸肉100g=120kcal。牛丼=700kcal前後。カレーライス=750kcal前後。ラーメン=500〜800kcal。サラダ(ドレッシング込み)=100〜200kcal。コンビニおにぎり1個=170〜250kcal。コンビニサンドイッチ=250〜350kcal。コンビニサラダ=70〜150kcal。', 1, 9, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000007', 'kb_common_000000000000000000000000000001', '外食・コンビニでのヘルシー選択', 'コンビニ: サラダチキン(110kcal/高タンパク)、ゆで卵(80kcal)、豆腐(60kcal)がおすすめ。揚げ物・菓子パンは避ける。ファミレス: グリルチキン、魚定食を選択。ご飯は少なめに。ファストフード: セットよりも単品＋サラダ。ドリンクは水かお茶。居酒屋: 枝豆、冷奴、刺身、焼き鳥（塩）がダイエット向き。ビールは1杯140kcal、ハイボール70kcal。', 1, 7, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000008', 'kb_common_000000000000000000000000000001', 'ダイエットFAQ', 'Q:停滞期はどうすれば？ A:体重が2〜4週間変わらないのは正常。食事内容を見直し、運動の種類を変えてみる。チートデイ（週1回普通に食べる日）も有効。Q:お酒は飲んでいい？ A:週2日以下、1回2杯以内なら大きな影響は少ない。蒸留酒（ハイボール、焼酎）が低カロリー。Q:夜食は太る？ A:時間帯より総カロリーが重要。ただし就寝前の食事は消化不良の原因に。Q:サプリメントは必要？ A:バランスの良い食事が基本。不足しがちなのはビタミンD、鉄分、食物繊維。', 1, 7, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000009', 'kb_common_000000000000000000000000000001', '睡眠とダイエットの関係', '睡眠不足はダイエットの大敵。睡眠が6時間未満だと食欲ホルモン（グレリン）が増加し、満腹ホルモン（レプチン）が減少する。結果的に翌日の食欲が20-30%増加。理想は7-8時間の睡眠。就寝前のスマホ使用はブルーライトでメラトニン分泌を抑制するため、就寝1時間前には控える。カフェインの影響は6-8時間続くため、午後3時以降のコーヒーは避ける。質の良い睡眠のためには：規則正しい就寝時間、寝室の温度18-22度、入浴は就寝90分前が最適。', 1, 8, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000010', 'kb_common_000000000000000000000000000001', 'ストレスと過食の対処法', 'ストレスを感じるとコルチゾール（ストレスホルモン）が増加し、高カロリー食への欲求が高まる。ストレス食いの対策：感情と食欲を区別する（本当にお腹が空いているか自問する）。食べたい衝動が来たら5分間待つ（衝動は通常5-10分で収まる）。代替行動を用意する（散歩、深呼吸、ストレッチ等）。食べる場合は量を決めてから食べ始める。「食べてしまった」自己嫌悪は逆効果。1回の過食で太ることはない。長期的なトレンドが重要。', 1, 8, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000011', 'kb_common_000000000000000000000000000001', '女性特有のダイエット注意点', '生理周期によって体重が2-3kg変動するのは正常。黄体期（生理前1-2週間）はむくみやすく体重が増加傾向。この時期の体重増加は脂肪ではなく水分。生理中は無理な食事制限を避け、鉄分豊富な食品（赤身肉、ほうれん草、レバー）を意識的に摂取。エストロゲン低下期（更年期）は基礎代謝が低下するため、筋トレによる筋量維持が特に重要。BMI18.5未満や体脂肪率17%以下は月経不順のリスクがあるため、これ以上の減量は医師に相談を。', 1, 8, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000012', 'kb_common_000000000000000000000000000001', '筋トレ初心者ガイド', '筋トレはダイエットの強力な味方。筋肉1kgあたり1日13kcalの基礎代謝増加。初心者は週2-3回、各30分程度から開始。自宅でできる基本種目：スクワット（大腿四頭筋・臀筋）、プッシュアップ（大胸筋・三頭筋）、プランク（体幹）。各10回×3セット、セット間60秒休憩が目安。フォーム優先で回数は後から増やす。筋肉痛がある部位は48-72時間休ませる。体重が変わらなくても体組成が変わっている場合がある（筋肉増・脂肪減）ため、見た目やウエストサイズも記録するとよい。', 1, 7, datetime('now'), datetime('now'));

-- クライアント固有知識
INSERT OR IGNORE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000001', 'kb_client_000000000000000000000000000001', '食事指導BOT 運用ガイドライン', 'このBOTはクリニック・パーソナルジム等が顧客のダイエットサポートに利用するシステムです。【指導方針】急激な減量（月4kg以上）は推奨しない。目安は月1-2kg。食事写真から自動解析されたPFCは目安値であり、正確な栄養計算ではないことをユーザーに伝える。継続が最も重要。完璧を求めず「昨日より少し良い選択」を促す。問診で収集した情報（目標体重、運動習慣、悩み等）に基づき個別化したアドバイスを行う。週次レポートでは1週間の平均値とトレンドで評価し、日々の変動を過度に気にしないよう指導。', 1, 10, datetime('now'), datetime('now'));
