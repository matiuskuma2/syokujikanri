# 10 Rich Menu 設定ガイド（3 ボタン版）

## 概要

LINE 公式アカウントに 3 ボタンの Rich Menu を接続する手順。

**ボタン構成:**

| 位置 | ラベル | アクション | 送信テキスト / URL |
|------|--------|------------|---------------------|
| 左 | 記録する | message | `記録する` |
| 中央 | 相談する | message | `相談する` |
| 右 | ダッシュボード | URI | `https://liff.line.me/2009409790-DekZRh4t` |

**画像サイズ:** 2500 × 843 px（LINE compact サイズ）

---

## 方法 A: 管理画面 API 経由（推奨）

### 1. 管理画面にログイン

Superadmin でログインし、Rich Menu 管理ページ (`/admin/rich-menu`) を開く。

### 2. API 経由で作成

管理画面の「Rich Menu 作成」ボタンを押すと、以下の処理が自動実行されます:

1. Rich Menu オブジェクト作成（3 ボタンテンプレート）
2. 画像アップロード（`richmenu-3btn.png`）
3. 全ユーザーのデフォルトに設定

### 3. curl での直接実行

管理画面を使わない場合、curl で直接 API を呼ぶことも可能:

```bash
# JWT トークンを取得（管理画面ログイン API）
TOKEN="取得したJWTトークン"

# Rich Menu 作成＋デフォルト設定
curl -X POST https://diet-bot.pages.dev/api/admin/rich-menu/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: multipart/form-data" \
  -F "image=@public/static/richmenu-3btn.png"
```

---

## 方法 B: LINE Official Account Manager 経由

### 1. LINE Official Account Manager にログイン

https://manager.line.biz/ にアクセス

### 2. リッチメニュー作成

1. 左メニュー → 「トーク画面」→「リッチメニュー」
2. 「作成」ボタンをクリック
3. 以下を設定:

**基本設定:**
- タイトル: `食事指導BOT メニュー`
- 表示期間: 開始日〜長期間（例: 2030年末）
- メニューバーのテキスト: `メニュー`
- デフォルト表示: ON

**テンプレート:**
- 「小」サイズ（1 行）を選択
- 3 分割テンプレートを選択

**アクション設定:**

| エリア | タイプ | 設定値 |
|--------|--------|--------|
| 左 | テキスト | `記録する` |
| 中央 | テキスト | `相談する` |
| 右 | リンク | `https://liff.line.me/2009409790-DekZRh4t` ラベル: `ダッシュボード` |

**画像:**
- `public/static/richmenu-3btn.png` をアップロード

### 3. 保存して公開

「保存」→ 全ユーザーに自動適用

---

## 方法 C: LINE Messaging API 直接呼び出し

### 1. Rich Menu オブジェクト作成

```bash
CHANNEL_ACCESS_TOKEN="本番チャンネルアクセストークン"

# Rich Menu 作成
RICH_MENU_ID=$(curl -s -X POST https://api.line.me/v2/bot/richmenu \
  -H "Authorization: Bearer $CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "size": {"width": 2500, "height": 843},
    "selected": true,
    "name": "食事指導BOT メニュー",
    "chatBarText": "メニュー",
    "areas": [
      {
        "bounds": {"x": 0, "y": 0, "width": 833, "height": 843},
        "action": {"type": "message", "label": "記録する", "text": "記録する"}
      },
      {
        "bounds": {"x": 833, "y": 0, "width": 833, "height": 843},
        "action": {"type": "message", "label": "相談する", "text": "相談する"}
      },
      {
        "bounds": {"x": 1666, "y": 0, "width": 834, "height": 843},
        "action": {"type": "uri", "label": "ダッシュボード", "uri": "https://liff.line.me/2009409790-DekZRh4t"}
      }
    ]
  }' | jq -r '.richMenuId')

echo "Created Rich Menu: $RICH_MENU_ID"
```

### 2. 画像アップロード

```bash
curl -X POST "https://api-data.line.me/v2/bot/richmenu/$RICH_MENU_ID/content" \
  -H "Authorization: Bearer $CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @public/static/richmenu-3btn.png
```

### 3. デフォルトに設定

```bash
curl -X POST "https://api.line.me/v2/bot/user/all/richmenu/$RICH_MENU_ID" \
  -H "Authorization: Bearer $CHANNEL_ACCESS_TOKEN"
```

---

## BOT 応答文言一覧

| トリガー | BOT 応答 |
|----------|----------|
| 「記録する」タップ | 📝 記録モードです。記録したい内容を送ってください（食事写真・テキスト・体重数値・体重計の写真、どれでもOK） |
| 「相談する」タップ | 💬 相談モードです。食事・体重・外食・間食・続け方など何でも送ってください 😊 |
| 「ダッシュボード」タップ | LIFF アプリが直接開く（BOT応答なし） |

---

## 注意事項

- Rich Menu 画像は `2500 × 843` px（compact サイズ）を使用
- ダッシュボードボタンは **URI アクション** のため、Webhook には飛ばずに LIFF が直接開く
- 「記録する」「相談する」は **message アクション** で BOT に送信される
- 既存の 6 ボタン Rich Menu が設定されている場合は、先に削除してから新しいものを作成
- Rich Menu 画像ファイル: `public/static/richmenu-3btn.png`
