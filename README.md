# fal playground

[fal.ai](https://fal.ai) と Modal 自前ホスト版 Krea 2（[modal_comfy](https://github.com/rabi0424/modal_comfy)）の画像生成 API を使う個人用プレイグラウンド。Cloudflare Workers（Git 連携デプロイ）でのホストを前提に、認証は Cloudflare Access（メール認証）、API キー類はすべて Worker の Secret に置きます。ブラウザ側でのキー入力・保存はありません。

## 初期設定

### 1. Cloudflare Access で保護する（必須）

> **重要**: この設定をせずにデプロイすると、fal プロキシなどの API が URL を知っている全員に開放された状態になります（fal キーの無断利用につながる）。必ず最初に設定してください。

1. Cloudflare ダッシュボード → **Workers & Pages** → 対象の Worker → **Settings** → **Domains & Routes**
2. workers.dev の行の **Enable Cloudflare Access**（Cloudflare Access を有効化）をオン
3. 自動作成された Zero Trust アプリケーションのポリシーを編集し、**自分のメールアドレスのみ許可**（ログイン方法: One-time PIN）にする
4. セッション期間は好みで（例: 1 か月。切れたら再度メール認証するだけ）

以後、どの端末からでも「URL を開く → メールに届く PIN を入力」だけで使えます。

### 2. Secret を設定する

Cloudflare ダッシュボード → 対象の Worker → **Settings** → **Variables and Secrets** に、Type: **Secret** で追加:

| Variable name | 値 | 用途 |
|---|---|---|
| `FAL_KEY` | [fal.ai ダッシュボード](https://fal.ai/dashboard/keys)で発行した API キー（`key_id:key_secret`） | fal での生成 |
| `MODAL_PROXY_KEY` | Modal の Proxy Auth Token（`wk-…`） | Modal 版 Krea 2 での生成 |
| `MODAL_PROXY_SECRET` | 同上（`ws-…`）。[Modal ダッシュボード → Settings → Proxy Auth Tokens](https://modal.com/settings) で発行 | 同上 |

旧バージョンで使っていた `SYNC_TOKEN` は不要になったので削除して構いません。

## 機能

- モデル選択（FLUX 系 / Recraft V3 / Modal 自前ホスト版 Krea 2 / 任意のカスタムモデル ID）
- サイズ（約 1MP 基準のプリセット 6 種 + カスタム px 指定）・枚数・シード・ステップ数・ガイダンスの指定
- Hugging Face 公開リポジトリからの LoRA 一括登録（.safetensors を一覧表示して選択）
- 生成履歴とプロンプトの再利用（サーバー保存・全端末で共通）
- ダークモード（自動 / ライト / ダーク切替）
- Cmd/Ctrl + Enter で生成
- スマホ対応（iPhone 16 想定・下部固定の生成バー・ライトボックスのスワイプ切替）

## データの保管先

| データ | 保管先 | 備考 |
|---|---|---|
| fal API キー / Modal トークン | Worker の Secret | ブラウザには一切渡らない |
| 生成履歴（プロンプト・設定・結果） | サーバー（Durable Object） | 直近 150 件。超過分は画像ごと古い順に自動削除。全端末で共通 |
| 生成画像 | サーバー（Durable Object） | fal の CDN からも取り込むため**失効しない**。履歴の削除と連動して削除 |
| LoRA ライブラリ | サーバー（自動同期） + localStorage | 全端末で共通 |
| フォームの下書き・テーマ | localStorage | 端末ごと（意図的に同期しない） |

### 生成設定の画像への焼き込み

保存される PNG には、生成設定（プロンプト・モデル・LoRA・seed・サイズなど）の JSON が **iTXt チャンク（キーワード `playground`）** として埋め込まれます。ComfyUI がワークフローを画像に埋め込むのと同じ発想で、「保存」でダウンロードした画像ファイルだけから後で設定を確認できます（画質への影響はありません）。fal のモデルが JPEG を返した場合は焼き込みされませんが、履歴レコード側に設定が残ります。

## Modal 自前ホスト版 Krea 2

モデル選択の「Krea 2 [turbo] 自前ホスト（Modal 実験版 / 本番）」は、fal ではなく Modal 上の [modal_comfy](https://github.com/rabi0424/modal_comfy) API で生成します。実験版（CPU スナップショット）と本番（安定版）はモデル選択で切り替えられ、標準は実験版です。エンドポイントの URL 自体を変えたい場合は、Worker の環境変数で上書きできます（未設定なら modal_comfy の既定 URL）:

- `KREA2_ENDPOINT_EXP` = 実験版の URL
- `KREA2_ENDPOINT` = 本番の URL

### 使い方のメモ

- LoRA は名前指定です。LoRA 行で選んだ項目のファイル名（`.safetensors` 抜き）がそのまま送られるので、「Hugging Face から一括登録」で `tottie2215/temp_str` を読み込んで Krea-2 用 LoRA（`Shimizu_krea2_v1_000005000` など）を登録しておくと選ぶだけで使えます。URL 欄に名前を直接入力しても OK
- ステップ数のデフォルトは 8（変更非推奨）、ガイダンス（cfg）は 0〜1 の範囲
- アイドル状態からの初回生成（コールドスタート）は 1 分ほどかかります。ウォーム時は 10〜20 秒程度
- 複数枚指定時は 1 枚ずつ順番に生成されます（2 枚目以降はウォームなので速い）
- 生成はサーバー側（Worker のジョブ）で完結します。生成中にタブを閉じたり通信が切れたりしても結果は失われず、ページを開き直せば途中から再開されます
- 「キャンセル」は結果の受け取りをやめるだけで、Modal 側で開始済みの生成処理は止まりません
- 比較モードは fal のキュー API 専用のため、Modal 版では使えません

## 開発メモ

- ローカルの静的サーバー（`python3 -m http.server`）でも UI の確認はできますが、生成・履歴・同期はすべて Worker の API（`/api/*`）に依存するため動きません。実際の動作確認は Cloudflare へのデプロイで行ってください
- Access のセッションが切れると API がログインページへのリダイレクトになります。アプリはこれを検出して「再読み込みしてサインインし直してください」と表示します
