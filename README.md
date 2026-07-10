# fal playground

[fal.ai](https://fal.ai) の画像生成 API を使う個人用プレイグラウンド。ビルド不要の静的フロントエンドのみで動作します。Cloudflare Workers でホストしている場合は、Modal 上の自前ホスト版 Krea 2 API（[modal_comfy](https://github.com/rabi0424/modal_comfy) の INTEGRATION.md 参照）でも生成できます。

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
- サイズ（約 1MP 基準のプリセット 6 種 + カスタム px 指定）・枚数・シード・ステップ数・ガイダンスの指定
- Hugging Face 公開リポジトリからの LoRA 一括登録（.safetensors を一覧表示して選択）
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

## Modal 自前ホスト版 Krea 2（任意）

モデル選択の「Krea 2 [turbo] 自前ホスト（Modal 実験版 / 本番）」は、fal ではなく Modal 上の [modal_comfy](https://github.com/rabi0424/modal_comfy) API で生成します。実験版（CPU スナップショット）と本番（安定版）はモデル選択で切り替えられ、標準は実験版です。Modal の Proxy Auth Token をブラウザに露出させないため、リクエストは Worker のプロキシ（`/api/krea2/generate`）経由で送られます。**Cloudflare Workers でホストしている場合のみ使えます**（ローカル静的サーバーでは不可）。

### 設定

1. [Modal ダッシュボード → Settings → Proxy Auth Tokens](https://modal.com/settings) でトークンを発行
2. Cloudflare ダッシュボード → 対象の Worker → **Settings** → **Variables and Secrets** に **Secret** として追加:
   - `MODAL_PROXY_KEY` = `wk-xxxx`
   - `MODAL_PROXY_SECRET` = `ws-xxxx`
3. 上記「端末間の同期」の `SYNC_TOKEN` も設定する（このプロキシの認証に同じトークンを使うため必須。同期自体を使うかは任意）
4. 各端末で「API キー」ダイアログの同期トークン欄に同じ値を入力

エンドポイントの URL 自体を変えたい場合は、Worker の環境変数で上書きできます（未設定なら modal_comfy の既定 URL）:

- `KREA2_ENDPOINT_EXP` = 実験版の URL
- `KREA2_ENDPOINT` = 本番の URL

### 使い方のメモ

- LoRA は名前指定です。LoRA 行で選んだ項目のファイル名（`.safetensors` 抜き）がそのまま送られるので、「Hugging Face から一括登録」で `tottie2215/temp_str` を読み込んで Krea-2 用 LoRA（`Shimizu_krea2_v1_000005000` など）を登録しておくと選ぶだけで使えます。URL 欄に名前を直接入力しても OK
- ステップ数のデフォルトは 8（変更非推奨）、ガイダンス（cfg）は 0〜1 の範囲
- アイドル状態からの初回生成（コールドスタート）は 1 分ほどかかります。ウォーム時は 10〜20 秒程度
- 複数枚指定時は 1 枚ずつ順番に生成されます（2 枚目以降はウォームなので速い）
- 生成画像は Worker の Durable Object に保存され、直近 60 枚を超えた古いものから自動削除されます。残したい画像は「保存」でダウンロードしてください
- 比較モードは fal のキュー API 専用のため、Modal 版では使えません

## 注意

- 生成画像の URL は fal の CDN 上のもので、一定期間後に失効することがあります。残したい画像は「保存」でダウンロードしてください。
- API キーがブラウザに保存される構成のため、自分専用での利用を想定しています。公開サーバーには置かないでください。
