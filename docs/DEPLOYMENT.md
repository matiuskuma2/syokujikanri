# デプロイ手順

## 前提条件
- Node.js 20+
- npm 10+
- Cloudflare アカウント（Workers/Pages/D1/R2/Vectorize 有効化済み）
- LINE Developers アカウント（Messaging API チャンネル作成済み）
- OpenAI API キー

---

## ローカル開発環境セットアップ

### 1. リポジトリクローン
```bash
git clone https://github.com/your-repo/diet-bot.git
cd diet-bot
npm install
```

### 2. 環境変数設定
```bash
cp .dev.vars.example .dev.vars
# .dev.vars を編集して各キーを設定
```

### 3. Wrangler 認証
```bash
npx wrangler login
```

### 4. D1 データベース作成
```bash
# 本番 DB 作成
npx wrangler d1 create diet-bot-production
# → wrangler.jsonc の database_id に出力された ID を設定

# ローカル DB にマイグレーション適用
npx wrangler d1 migrations apply diet-bot-production --local
```

### 5. Vectorize インデックス作成
```bash
npx wrangler vectorize create diet-bot-knowledge \
  --dimensions=1536 \
  --metric=cosine
# → wrangler.jsonc の vectorize_indexes に ID を設定
```

### 6. R2 バケット作成
```bash
npx wrangler r2 bucket create diet-bot-media
```

### 7. Queue 作成
```bash
npx wrangler queues create diet-bot-line-events
```

### 8. ビルド & ローカル起動
```bash
npm run build
pm2 start ecosystem.config.cjs
# または
npm run dev:sandbox
```

### 9. 動作確認
```bash
curl http://localhost:3000/health
```

---

## 本番デプロイ

### 1. Cloudflare Pages プロジェクト作成（初回のみ）
```bash
npx wrangler pages project create diet-bot \
  --production-branch main
```

### 2. 本番 D1 マイグレーション適用
```bash
npx wrangler d1 migrations apply diet-bot-production
```

### 3. シークレット設定
```bash
npx wrangler pages secret put LINE_CHANNEL_SECRET --project-name diet-bot
npx wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name diet-bot
npx wrangler pages secret put OPENAI_API_KEY --project-name diet-bot
npx wrangler pages secret put JWT_SECRET --project-name diet-bot
npx wrangler pages secret put CRON_SECRET --project-name diet-bot
```

### 4. ビルド & デプロイ
```bash
npm run build
npx wrangler pages deploy dist --project-name diet-bot
```

### 5. LINE Webhook URL 設定
LINE Developers Console で以下を設定:
```
https://diet-bot.pages.dev/api/webhooks/line
```

---

## wrangler.jsonc 設定例

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "diet-bot",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "pages_build_output_dir": "./dist",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "diet-bot-production",
      "database_id": "YOUR_DATABASE_ID"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "diet-bot-media"
    }
  ],
  "queues": {
    "producers": [
      {
        "queue": "diet-bot-line-events",
        "binding": "LINE_EVENTS_QUEUE"
      }
    ],
    "consumers": [
      {
        "queue": "diet-bot-line-events",
        "max_batch_size": 10,
        "max_batch_timeout": 30
      }
    ]
  },
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "diet-bot-knowledge"
    }
  ],
  "triggers": {
    "crons": [
      "0 23 * * *",
      "0 0 * * 1"
    ]
  }
}
```

---

## .dev.vars.example

```ini
# LINE
LINE_CHANNEL_SECRET=your_line_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LINE_WEBHOOK_PATH=/api/webhooks/line

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
OPENAI_MAX_TOKENS=2048
OPENAI_TEMPERATURE_RECORD=0.3
OPENAI_TEMPERATURE_CONSULT=0.7

# JWT
JWT_SECRET=your_jwt_secret_min_32chars
JWT_EXPIRES_IN=24h

# App
APP_ENV=development
APP_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# BOT
BOT_SESSION_TTL_HOURS=4
CONSULT_MAX_TURNS=10

# Cron
CRON_SECRET=your_cron_secret

# R2
R2_BUCKET_URL=https://your-account.r2.cloudflarestorage.com/diet-bot-media
R2_MAX_FILE_SIZE_MB=10
R2_ALLOWED_CONTENT_TYPES=image/jpeg,image/png,image/webp,image/heic
```

---

## PM2 ecosystem.config.cjs

```javascript
module.exports = {
  apps: [
    {
      name: 'diet-bot',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=diet-bot-production --local --ip 0.0.0.0 --port 3000',
      env: { NODE_ENV: 'development', PORT: 3000 },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
```

---

## Cron スケジュール

| Cron 式 | JST 時刻 | 処理 |
|---|---|---|
| `0 23 * * *` | 毎日 08:00 JST | 日次リマインダー送信 |
| `0 0 * * 1` | 毎週月曜 09:00 JST | 週次レポート生成・送信 |

※ Cloudflare Cron は UTC で設定。JST = UTC + 9。

---

## トラブルシューティング

### ビルドエラー: routes is undefined
`tsconfig.json` に以下を追加:
```json
{ "compilerOptions": { "useDefineForClassFields": false } }
```

### Workers エントリーポイントが認識されない
`vite.config.ts` で `entry: 'src/index.ts'` を明示。
`pages({ entry: 'src/index.ts' })` を使用。

### D1 クエリエラー
`--local` フラグ付きで migrate を再実行:
```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply diet-bot-production --local
```

### LINE Webhook 署名検証失敗
Channel Secret が正しいか確認。
`.dev.vars` の `LINE_CHANNEL_SECRET` を再確認。
