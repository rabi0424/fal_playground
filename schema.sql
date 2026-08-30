-- 生成履歴のカタログ（Cloudflare D1）
--
-- playground と、将来のアーカイブ（ComfyUI などの生成物を取り込む側）が
-- 同じ表を共有する。両者の違いは保管場所ではなく source 列の値だけで、
-- 「playground のギャラリー」も「アーカイブの横断検索」も同じ表への別クエリになる。
--
-- Worker は最初に履歴へ触れたときにこの内容を CREATE TABLE IF NOT EXISTS で
-- 流すので、通常はこのファイルを手で適用する必要はない（Git 連携デプロイでは
-- wrangler の migrations が走らないため、スキーマ適用をアプリ側に持たせている）。
-- 手で確かめたいときは:
--   npx wrangler d1 execute fal-playground --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS history (
  -- 並び順。大きいほど新しい。同じ id を保存し直すと振り直されて先頭に来る
  seq     INTEGER PRIMARY KEY,
  id      TEXT    NOT NULL UNIQUE,
  -- 何が作ったか。playground の生成物は 'playground'。
  -- アーカイブ側は 'comfy' / 'a1111' などを入れる
  source  TEXT    NOT NULL DEFAULT 'playground',
  -- '' | 'imgedit' | 'compare' | 'edit'（レコードの種類）
  type    TEXT    NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0, -- record.ts（ミリ秒）
  model   TEXT    NOT NULL DEFAULT '',
  prompt  TEXT    NOT NULL DEFAULT '',
  -- レコード全体の JSON。ただしマスクは除く（下記）
  record  TEXT    NOT NULL,
  -- 画像編集のマスク（塗った線の座標）。1 件で数十 KB になり、一覧では要らないので
  -- 列を分けてある。SELECT でこの列を選ばなければ、一覧の転送量に乗らない
  mask    TEXT
);

CREATE INDEX IF NOT EXISTS history_source_seq ON history (source, seq DESC);

-- 画像 → それを載せている履歴。1 枚が複数の記録に出ることがある
-- （編集の入力に使い回したときなど）ので、参照の数え上げに使う。
-- これが無いと、片方の記録を消しただけでもう片方の画像が消える。
-- /api/capture の「その URL は履歴に載っているか」もここを引く
CREATE TABLE IF NOT EXISTS history_images (
  url        TEXT NOT NULL,
  history_id TEXT NOT NULL,
  -- 自分が配信している画像（/api/image/<id>）のときだけ id が入る。外部 CDN は NULL。
  -- 回収はこの列だけを見るので、URL 文字列の形に振り回されずに済む
  image_id   TEXT,
  PRIMARY KEY (url, history_id)
);

CREATE INDEX IF NOT EXISTS history_images_owner ON history_images (history_id);
CREATE INDEX IF NOT EXISTS history_images_image ON history_images (image_id);

-- 既にこの表がある DB では、CREATE TABLE IF NOT EXISTS は何もしないので
-- image_id は ALTER でしか入らない。Worker は「表 → 列の追加 → 索引」の順に流す。
-- 手で流すときも、上の索引より先にこれを実行すること（列が無いと索引が作れない）:
--   ALTER TABLE history_images ADD COLUMN image_id TEXT;

-- 使われなかった画像の回収（マーク&スイープ）の印。
-- 画像編集は「画像を選んだ瞬間」に R2 へ上げ、履歴に載るのは編集が終わってから
-- なので、参照が無いだけでは消せない。まず印を付け、猶予（既定 1 週間）を越えて
-- なお参照が無いものだけを消す
CREATE TABLE IF NOT EXISTS image_gc (
  image_id  TEXT PRIMARY KEY,
  marked_at INTEGER NOT NULL
);

-- 移行済みフラグなど、単発の覚書
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
