-- =============================================================
-- seed-production.sql  v2.0
-- 本番環境用 BOT・ナレッジデータ投入
--
-- 使用方法（本番DBへ直接投入）:
--   npx wrangler d1 execute diet-bot-production --file=./seed-production.sql
--
-- ローカル開発:
--   npx wrangler d1 execute diet-bot-production --local --file=./seed-production.sql
--
-- ※ accounts / memberships / subscriptions / line_channels は
--   admin画面から手動で作成済みであることを前提とする
-- ※ テストユーザーは含まない
-- =============================================================

-- ===================================================================
-- 1. BOT 設定
-- ===================================================================

INSERT OR REPLACE INTO bots (
  id, account_id, name, bot_key, type, is_active, current_version_id, created_at, updated_at
)
VALUES (
  'bot_client_00000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  'ダイエットサポートBOT',
  'diet-support-bot-v1',
  'line',
  1,
  'bv_client_000000000000000000000000000001v2',
  datetime('now'),
  datetime('now')
);

-- ===================================================================
-- 2. BOT バージョン v2（運用レベル system_prompt + config）
-- ===================================================================

-- v1 は残す（履歴として）
INSERT OR IGNORE INTO bot_versions (
  id, bot_id, version_number, system_prompt, config, is_published, created_at
)
VALUES (
  'bv_client_000000000000000000000000000001v1',
  'bot_client_00000000000000000000000000000001',
  1,
  'あなたは「食事指導BOT」のAIアシスタントです。LINE上でユーザーのダイエット・食事管理をサポートします。

## 基本ルール
- 常に日本語で、丁寧かつ親しみやすい口調で応答（敬語＋絵文字OK）
- 回答は300文字以内で簡潔にまとめる
- 医療診断・処方は絶対に行わない
- サプリメント・特定商品の推奨はしない',
  NULL,
  0,
  datetime('now')
);

-- v2: 本番用プロンプト（公開版）
INSERT OR REPLACE INTO bot_versions (
  id, bot_id, version_number, system_prompt, config, is_published, created_at
)
VALUES (
  'bv_client_000000000000000000000000000001v2',
  'bot_client_00000000000000000000000000000001',
  2,
  'あなたは「食事指導BOT」のAIアシスタントです。LINE上でユーザーのダイエット・食事管理をサポートします。

## 基本ルール
- 常に日本語で、丁寧かつ親しみやすい口調で応答（敬語＋絵文字OK）
- 回答は300文字以内で簡潔にまとめる（LINE表示に最適化）
- 医療診断・処方は絶対に行わない。気になる症状は「専門医への相談をお勧めします」と促す
- サプリメント・特定商品の推奨はしない
- ユーザーのプロフィール情報（身長・体重・目標・活動レベル等）が提供された場合、それに基づいた個別アドバイスを行う
- 過去の体重推移・食事記録が提供された場合、トレンドを踏まえてコメントする
- ユーザーの名前（ニックネーム）がわかる場合は呼びかけに使う

## 応答パターン

### 食事記録への反応
- 良い食事: 具体的に何が良いか1つ伝え、励ます
- 改善点がある食事: まず良い点を1つ褒め、改善提案を1つだけ（否定しない）
- PFCバランスが偏っている場合: 不足している栄養素と手軽な補い方を提案
- 写真解析結果が提供された場合: 解析結果のPFC値を参照しつつ「目安値です」と一言添える

### 食事写真の解析結果への反応
- AIによる自動解析結果（料理名・推定カロリー・PFC）が提示されることがある
- food_masterデータベースと照合済みの場合は「データベース参照値」と表示される
- 解析値はあくまで推定。「正確に測りたい場合はキッチンスケールの利用を」と案内可
- 品目が多い写真は見落としがあり得る旨を伝え、追加があれば教えてと促す

### 体重記録への反応
- 減少傾向: 具体的な数値に触れて「順調ですね！」系コメント
- 増加傾向: 「体重は水分で1-2kg変動するので気にしすぎないで」と安心させつつ、食事内容を確認
- 横ばい: 「停滞期は体が調整中。続けることが大事」と励ます
- 急激な変動（1日で2kg以上）: 「水分や食事内容の影響です。数日の平均で見ましょう」

### 相談モード
- ユーザーの質問に対して、科学的根拠に基づいた回答をする
- 参考ナレッジが提供された場合、その情報を優先的に活用して回答する
- 曖昧な質問には「具体的にはどんな点が気になりますか？」と掘り下げる
- 1つの相談に対して回答は1つに絞る。情報過多にならないよう注意

### Rich Menuボタンからの導線
- ユーザーは以下のボタンからアクセスすることがある
  - 「記録モード」: 記録の入力を促す
  - 「相談モード」: 相談開始
  - 「写真を送る」系: 画像送信の案内
  - 「体重記録」系: 体重入力の案内
- ボタン押下後の最初の応答は簡潔に。長い説明は不要

## 週次レポートでのコメント生成
- 1週間の平均体重・カロリー・記録日数をもとにコメント
- 良かった点を1つ、改善点を1つ（具体的に）
- 来週のミニ目標を1つ提案（「来週は朝食を5日記録してみましょう」等）

## 禁止事項
- 極端な食事制限（1日1食、断食等）を推奨しない
- 「痩せろ」「太っている」等のネガティブな表現を使わない
- 他のユーザーとの比較をしない
- 根拠のない情報を提供しない
- 同じアドバイスの繰り返しを避ける（バリエーションを持たせる）
- 長文を送らない（LINE上では読みにくい）',
  '{"model":"gpt-4o","temperature_record":0.3,"temperature_consult":0.7,"max_tokens":512,"image_model":"gpt-4o","image_max_tokens":2048}',
  1,
  datetime('now')
);

-- ===================================================================
-- 3. ナレッジベース
-- ===================================================================

-- 共通ナレッジベース（全アカウント共通）
INSERT OR REPLACE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_common_000000000000000000000000000001',
  NULL,
  '栄養・ダイエット基礎知識',
  '一般的なダイエット・栄養に関する基礎知識（共通12件＋実践8件 = 20件）',
  1,
  10,
  datetime('now'),
  datetime('now')
);

-- クライアント固有ナレッジベース
INSERT OR REPLACE INTO knowledge_bases (
  id, account_id, name, description, is_active, priority, created_at, updated_at
)
VALUES (
  'kb_client_000000000000000000000000000001',
  'acc_client_00000000000000000000000000000001',
  '食事指導BOT運用ナレッジ',
  'BOT運用ガイドライン・指導方針・FAQ（5件）',
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
-- 5. 共通ナレッジドキュメント（既存12件をUPSERT）
-- ===================================================================

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000001', 'kb_common_000000000000000000000000000001', 'PFCバランスの基礎', 'PFCバランスとは、タンパク質(Protein)・脂質(Fat)・炭水化物(Carbohydrate)の摂取比率のこと。一般的なダイエットの推奨比率はP:F:C=30:20:50。タンパク質は体重×1.2〜2.0g/日（運動量により変動）。脂質は総カロリーの20〜25%。炭水化物は残りで調整。極端な糖質制限は長期的にリバウンドリスクが高い。タンパク質が不足すると筋肉量低下→基礎代謝低下→太りやすくなるという悪循環に陥る。', 1, 10, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000002', 'kb_common_000000000000000000000000000001', '基礎代謝と消費カロリー計算', '基礎代謝(BMR)の計算式（Harris-Benedict改良版）: 男性=13.397×体重kg+4.799×身長cm-5.677×年齢+88.362。女性=9.247×体重kg+3.098×身長cm-4.330×年齢+447.593。活動代謝(TDEE)=BMR×活動係数。活動係数: 座り仕事中心=1.2、軽い運動=1.375、週3-5回運動=1.55、毎日激しく運動=1.725。減量には1日あたりTDEE-500kcal程度の摂取カロリーが目安（週0.5kg減ペース）。1000kcal以上のカロリー不足は筋肉分解と代謝低下を招くため非推奨。', 1, 10, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000003', 'kb_common_000000000000000000000000000001', '食事タイミングと頻度のポイント', '1日3食を基本とし規則正しい時間に食べる。朝食を抜くと昼食での過食リスクが上がる。夕食は就寝3時間前までに済ませるのが理想。間食は200kcal以内を目安にし、タンパク質を含むもの（ヨーグルト、ナッツ等）が望ましい。空腹時間が長すぎると筋肉分解が進むため、6時間以上空けないことを推奨。水分は1日2L以上を目安に（水・お茶が中心）。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000004', 'kb_common_000000000000000000000000000001', '運動とダイエットの関係', '有酸素運動（ウォーキング、ジョギング、水泳等）は脂肪燃焼に効果的。週150分以上の中程度の有酸素運動が推奨。筋トレは基礎代謝の維持・向上に不可欠。食事制限のみでは筋肉量が減少し、リバウンドしやすくなる。NEAT（非運動性活動熱産生）の増加も重要：階段を使う、歩く距離を増やす等。運動後30分以内のタンパク質摂取が筋肉回復に効果的。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000005', 'kb_common_000000000000000000000000000001', '体重の日内変動と正しい測り方', '体重は1日で1〜2kg変動するのが正常。水分、食事、排泄、運動で変わる。毎日同じ条件（朝起きてトイレ後、食事前）で測定するのがベスト。週単位の平均値で推移を見ることが重要。生理周期（女性）では2〜3kg増えることもある。1日で1kg体重が増えても、それは脂肪ではなく水分の可能性が高い。1kgの脂肪を蓄えるには約7200kcalの過剰摂取が必要。', 1, 9, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000006', 'kb_common_000000000000000000000000000001', '日本食の一般的なカロリー目安', '白米1膳(150g)=234kcal。食パン1枚(6枚切り)=158kcal。味噌汁1杯=50kcal。焼き魚(鮭1切れ)=130kcal。鶏胸肉100g=120kcal。牛丼=700kcal前後。カレーライス=750kcal前後。ラーメン=500〜800kcal。サラダ(ドレッシング込み)=100〜200kcal。コンビニおにぎり1個=170〜250kcal。コンビニサンドイッチ=250〜350kcal。コンビニサラダ=70〜150kcal。卵1個=80kcal。納豆1パック=100kcal。バナナ1本=86kcal。', 1, 9, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000007', 'kb_common_000000000000000000000000000001', '外食・コンビニでのヘルシー選択', 'コンビニ: サラダチキン(110kcal/高タンパク)、ゆで卵(80kcal)、豆腐(60kcal)がおすすめ。揚げ物・菓子パンは避ける。ファミレス: グリルチキン、魚定食を選択。ご飯は少なめに。ファストフード: セットよりも単品＋サラダ。ドリンクは水かお茶。居酒屋: 枝豆、冷奴、刺身、焼き鳥（塩）がダイエット向き。ビールは1杯140kcal、ハイボール70kcal。コンビニ弁当を選ぶなら「幕の内」より「鶏そぼろ弁当」等タンパク質比率が高いものを選ぶ。', 1, 7, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000008', 'kb_common_000000000000000000000000000001', 'ダイエットFAQ', 'Q:停滞期はどうすれば？ A:体重が2〜4週間変わらないのは正常。食事内容を見直し、運動の種類を変えてみる。チートデイ（週1回普通に食べる日）も有効。Q:お酒は飲んでいい？ A:週2日以下、1回2杯以内なら大きな影響は少ない。蒸留酒（ハイボール、焼酎）が低カロリー。Q:夜食は太る？ A:時間帯より総カロリーが重要。ただし就寝前の食事は消化不良の原因に。Q:サプリメントは必要？ A:バランスの良い食事が基本。不足しがちなのはビタミンD、鉄分、食物繊維。Q:リバウンドしない方法は？ A:月1-2kgペースの減量、筋トレ併用、極端な制限を避けること。', 1, 7, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000009', 'kb_common_000000000000000000000000000001', '睡眠とダイエットの関係', '睡眠不足はダイエットの大敵。睡眠が6時間未満だと食欲ホルモン（グレリン）が増加し、満腹ホルモン（レプチン）が減少する。結果的に翌日の食欲が20-30%増加。理想は7-8時間の睡眠。就寝前のスマホ使用はブルーライトでメラトニン分泌を抑制するため、就寝1時間前には控える。カフェインの影響は6-8時間続くため、午後3時以降のコーヒーは避ける。質の良い睡眠のためには：規則正しい就寝時間、寝室の温度18-22度、入浴は就寝90分前が最適。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000010', 'kb_common_000000000000000000000000000001', 'ストレスと過食の対処法', 'ストレスを感じるとコルチゾール（ストレスホルモン）が増加し、高カロリー食への欲求が高まる。ストレス食いの対策：感情と食欲を区別する（本当にお腹が空いているか自問する）。食べたい衝動が来たら5分間待つ（衝動は通常5-10分で収まる）。代替行動を用意する（散歩、深呼吸、ストレッチ等）。食べる場合は量を決めてから食べ始める。「食べてしまった」自己嫌悪は逆効果。1回の過食で太ることはない。長期的なトレンドが重要。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000011', 'kb_common_000000000000000000000000000001', '女性特有のダイエット注意点', '生理周期によって体重が2-3kg変動するのは正常。黄体期（生理前1-2週間）はむくみやすく体重が増加傾向。この時期の体重増加は脂肪ではなく水分。生理中は無理な食事制限を避け、鉄分豊富な食品（赤身肉、ほうれん草、レバー）を意識的に摂取。エストロゲン低下期（更年期）は基礎代謝が低下するため、筋トレによる筋量維持が特に重要。BMI18.5未満や体脂肪率17%以下は月経不順のリスクがあるため、これ以上の減量は医師に相談を。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000012', 'kb_common_000000000000000000000000000001', '筋トレ初心者ガイド', '筋トレはダイエットの強力な味方。筋肉1kgあたり1日13kcalの基礎代謝増加。初心者は週2-3回、各30分程度から開始。自宅でできる基本種目：スクワット（大腿四頭筋・臀筋）、プッシュアップ（大胸筋・三頭筋）、プランク（体幹）。各10回×3セット、セット間60秒休憩が目安。フォーム優先で回数は後から増やす。筋肉痛がある部位は48-72時間休ませる。体重が変わらなくても体組成が変わっている場合がある（筋肉増・脂肪減）ため、見た目やウエストサイズも記録するとよい。', 1, 7, datetime('now'), datetime('now'));

-- ===================================================================
-- 6. 共通ナレッジドキュメント（新規追加 8件: 実践的知識）
-- ===================================================================

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000013', 'kb_common_000000000000000000000000000001', '水分摂取とダイエット', '水は代謝のベース。1日2L（体重×30ml）を目標に。起床時コップ1杯が体を起こす。食前にコップ1杯飲むと食べ過ぎ防止。カフェイン飲料は利尿作用があるため水分補給としてはカウントしない。甘い飲料の隠れカロリーに注意：缶コーヒー(微糖)=50kcal、清涼飲料500ml=200kcal、スポーツドリンク500ml=130kcal、野菜ジュース200ml=80kcal。むくみが気になる場合はカリウム豊富な食品（バナナ、アボカド、ほうれん草）を。塩分過多もむくみの原因。1日の塩分目標は男性7.5g、女性6.5g未満。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000014', 'kb_common_000000000000000000000000000001', '食物繊維と腸活', '食物繊維は1日20g以上を目標に。水溶性食物繊維（海藻、オクラ、なめこ、大麦）は血糖値の急上昇を抑え、腸内善玉菌のエサになる。不溶性食物繊維（ごぼう、さつまいも、きのこ）は便のカサを増やし便通改善。食物繊維が多い食事は満腹感が持続しやすい。腸内環境改善には発酵食品（ヨーグルト、味噌、キムチ、納豆）も有効。腸内環境が整うと栄養吸収効率が上がり、食欲コントロールもしやすくなる。急に食物繊維を増やすとお腹が張ることがあるので、1週間かけて徐々に増やす。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000015', 'kb_common_000000000000000000000000000001', '飲酒とダイエットの実践ガイド', 'アルコールは1gあたり7kcal（脂質9kcal、タンパク質・炭水化物4kcal）。ビール中ジョッキ=200kcal、ワイングラス1杯=90kcal、日本酒1合=190kcal、ハイボール=70kcal、焼酎ロック=100kcal。アルコール摂取中は脂肪燃焼が一時停止するため、飲酒時のおつまみは特に注意。推奨おつまみ: 枝豆、冷奴、刺身、焼き鳥(塩)、サラダ。避けたいおつまみ: 唐揚げ、フライドポテト、ピザ、締めのラーメン。飲む前に水をしっかり飲み、飲酒中も水を交互に。完全禁酒よりも「週2日以下・1回2杯以内」が長続きする。', 1, 7, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000016', 'kb_common_000000000000000000000000000001', '血糖値コントロールと食べ順', '食後の血糖値急上昇はインスリンの大量分泌を招き、脂肪蓄積を促進する。GI値の低い食品を選ぶ（白米→玄米、食パン→ライ麦パン、うどん→そば）。食べ順ダイエット: 野菜・汁物→タンパク質→炭水化物の順で食べると血糖値の急上昇を防げる。食物繊維を最初に食べることで糖の吸収がゆるやかになる。よく噛むこと（1口30回）で満腹中枢が刺激され、食べ過ぎ防止。食事時間は20分以上かけるのが理想。早食いは過食の最大の原因の一つ。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000017', 'kb_common_000000000000000000000000000001', '高タンパク質食品ガイド', 'タンパク質はダイエット中最も重要な栄養素。筋肉維持・満腹感持続・食事誘発性熱産生（DIT）が高い。1食あたり20-30gのタンパク質を目標に。代表的な高タンパク食品(100gあたり): 鶏むね肉23g、ささみ24g、豚ヒレ22g、牛もも肉21g、鮭20g、マグロ赤身26g、卵(1個60g)7.4g、豆腐(木綿)7g、納豆16.5g、ギリシャヨーグルト10g。手軽なタンパク質補給: コンビニのサラダチキン、ゆで卵、プロテインバー、牛乳・豆乳。植物性と動物性をバランスよく。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000018', 'kb_common_000000000000000000000000000001', '間食・おやつの選び方', '間食は悪ではない。適切に摂れば血糖値の安定と過食防止に役立つ。1回200kcal以内が目安。おすすめ間食: ナッツ類（素焼きアーモンド20粒=120kcal、くるみ6粒=160kcal）、ギリシャヨーグルト、ゆで卵、チーズ1切れ、高カカオチョコ(70%以上)2-3粒、するめ、ドライフルーツ少量。避けたい間食: 菓子パン(300-500kcal)、ポテトチップス、チョコレート菓子、清涼飲料水。間食のタイミングは食事の3-4時間後が最適。空腹で食事を迎えると過食しやすい。「お腹が空いた」ではなく「お腹がちょうどよい」状態で食事を迎えるのが理想。', 1, 7, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000019', 'kb_common_000000000000000000000000000001', 'ダイエットの心理学とモチベーション維持', '行動変容ステージ: 無関心期→関心期→準備期→実行期→維持期。このBOTユーザーは実行期以降。リバウンドの最大原因は「完璧主義」。80点の食事を継続する方が100点を3日だけより効果的。目標設定のSMART原則: 具体的(Specific)、測定可能(Measurable)、達成可能(Achievable)、関連性(Relevant)、期限付き(Time-bound)。良い目標例「3ヶ月で3kg減量」、悪い目標例「とにかく痩せたい」。記録を続けること自体が行動変容の最大の武器。記録率が週5日以上の人は、週2日以下の人の3倍減量に成功する。', 1, 9, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_common_0000000000000000000000000020', 'kb_common_000000000000000000000000000001', '季節・気候とダイエット', '夏は発汗で体重が減りやすいが脱水に注意。冷たい飲み物の過剰摂取は内臓を冷やし代謝低下の原因に。冬は基礎代謝が上がる（体温維持にエネルギーが必要）ため、実はダイエットに向いている。ただし冬は日照時間短縮でセロトニンが減少し甘いもの欲求が増す。対策: 朝に日光を浴びる、規則正しい生活。年末年始・GW・お盆等のイベント時期は「体重維持」を目標に。増えた分は2週間で戻すイメージで。季節の食材を取り入れると栄養バランスが自然に整いやすい。旬の食材は栄養価が高く価格も安い。', 1, 6, datetime('now'), datetime('now'));

-- ===================================================================
-- 7. クライアント固有ナレッジドキュメント（既存1件 + 新規4件）
-- ===================================================================

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000001', 'kb_client_000000000000000000000000000001', '食事指導BOT 運用ガイドライン', 'このBOTはクリニック・パーソナルジム等が顧客のダイエットサポートに利用するシステムです。【指導方針】急激な減量（月4kg以上）は推奨しない。目安は月1-2kg。食事写真から自動解析されたPFCは目安値であり、正確な栄養計算ではないことをユーザーに伝える。継続が最も重要。完璧を求めず「昨日より少し良い選択」を促す。問診で収集した情報（目標体重、運動習慣、悩み等）に基づき個別化したアドバイスを行う。週次レポートでは1週間の平均値とトレンドで評価し、日々の変動を過度に気にしないよう指導。', 1, 10, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000002', 'kb_client_000000000000000000000000000001', '問診後フォローアップ手順', '問診完了後のフォローフロー: 1日目: 問診完了メッセージ + リッチメニューの使い方案内。初回は食事写真を1枚送ってもらう。2-3日目: 記録がなければリマインドメッセージ（自動配信）。1週間目: 初回の週次レポート配信。体重記録が3日以上あれば傾向コメント、なければ記録の重要性を説明。2週間目以降: 週次レポート継続。相談モードの利用促進。目標に対する進捗フィードバック。記録率が低下した場合のリエンゲージメントメッセージ: 「最近記録が少ないですが、お忙しいですか？体重だけでもOKです！」', 1, 9, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000003', 'kb_client_000000000000000000000000000001', '目標設定ガイド（指導者向け）', 'ユーザーの目標体重が現実的かチェック: BMI18.5未満は非推奨。月1-2kg以上の減量ペースは注意。目標体重までの期間を逆算して提示（例: 5kg減量なら3-5ヶ月）。短期目標（週単位）と長期目標（月単位）の両方を設定。短期目標例: 「今週は朝食を5日記録する」「1日1回体重を測る」「週3回は自炊する」。数値目標だけでなく行動目標も入れることで達成感を得やすくなる。「体重が減らなくても行動が変わっていればOK」というメッセージが重要。', 1, 8, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000004', 'kb_client_000000000000000000000000000001', 'よくある質問（指導者FAQ）', 'Q: ユーザーが「全然痩せない」と言ったら？ A: まず記録の継続を褒める。体重以外の変化（ウエスト、体調、肌質等）を聞く。食事内容にパターンがないか確認（夕食過多、間食過多等）。2週間以上体重が動かない場合は摂取カロリーの見直しを提案。Q: 食事写真を送ってこなくなったら？ A: 責めない。体重だけでもOKと伝える。テキストでの食事記録も可。「忙しいときは食べたものを一言だけ」でOK。Q: 極端な食事制限をしているユーザーは？ A: 危険性を伝えつつ否定はしない。「もう少し食べても大丈夫ですよ」と安心させる。1日1000kcal未満が3日以上続く場合は専門家への相談を推奨。', 1, 9, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO knowledge_documents (id, knowledge_base_id, title, content, is_active, priority, created_at, updated_at)
VALUES ('kd_client_0000000000000000000000000005', 'kb_client_000000000000000000000000000001', '食事写真解析の利用ガイド', 'BOTの食事写真解析はOpenAI Vision APIで実施。解析結果には推定料理名・カロリー・PFCが含まれる。food_masterデータベースと照合し、DBに該当食品があればDB値を優先表示する。ユーザーに伝えるべき点: 解析値は推定であり正確ではない。量の推定が最も誤差が大きい。複数品目が写る場合は見落としがあり得る。ドレッシング・調味料はAI解析では反映されにくい。ユーザーが「カロリーが低すぎる/高すぎる」と感じたらテキストで補足してもらう。「確定」を押すと記録に反映される。「取消」を押すとリセット。確定後の修正は現時点では管理者側で対応。', 1, 10, datetime('now'), datetime('now'));
