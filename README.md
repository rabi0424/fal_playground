# fal playground

[fal.ai](https://fal.ai) の画像生成 API を使う個人用プレイグラウンド。ビルド不要の静的フロントエンドのみで動作します。

## 起動

任意の静的サーバーで配信するだけです：

```sh
python3 -m http.server 8123
```

ブラウザで `http://localhost:8123` を開きます。同じ LAN 内の他デバイスからは `http://<この Mac の IP>:8123` でアクセスできます。

## 初期設定

1. [fal.ai ダッシュボード](https://fal.ai/dashboard/keys)で API キーを発行
2. 画面右上の「API キー」ボタンから貼り付けて保存

キーはブラウザの localStorage にのみ保存され、fal 以外には送信されません。

## 機能

- モデル選択（FLUX 系 / Recraft V3 / 任意のカスタムモデル ID）
- サイズ・枚数・シード・ステップ数・ガイダンスの指定
- 生成履歴（localStorage、直近 30 件）とプロンプトの再利用
- ダークモード（自動 / ライト / ダーク切替）
- Cmd/Ctrl + Enter で生成
- スマホ対応（iPhone 16 想定・下部固定の生成バー・ライトボックスのスワイプ切替）
- 端末間の同期（任意・Cloudflare Workers でホストしている場合。API キー / LoRA ライブラリ / 生成履歴）

## 端末間の同期（任意）

Cloudflare Workers（Git 連携デプロイ）でホストしている場合、API キー・LoRA ライブラリ・生成履歴を端末間で同期できます。データは Worker の Durable Object（無料枠内）に保存されます。

1. Cloudflare ダッシュボード → 対象の Worker → **Settings** → **Variables and Secrets** → **Add**
   - Type: **Secret**、Variable name: `SYNC_TOKEN`、Value: 推測されにくい長いランダム文字列（半角英数記号）
2. 各端末でアプリを開き、「API キー」ダイアログの**同期トークン**欄に同じ値を入力して保存

トークンを設定した端末は、起動時・タブ復帰時・変更の数秒後に自動で同期されます。トークン未設定なら従来どおりローカルのみで動作します。

## 注意

- 生成画像の URL は fal の CDN 上のもので、一定期間後に失効することがあります。残したい画像は「保存」でダウンロードしてください。
- API キーがブラウザに保存される構成のため、自分専用での利用を想定しています。公開サーバーには置かないでください。
