// プッシュ通知（Web Push）用の VAPID 鍵ペアを作る。
//   node scripts/generate-vapid-keys.mjs
// 出力された 2 つの値を Worker の Secret（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）に
// 設定する。鍵を作り直すと既存の購読は無効になり、各端末で通知をオンにし直す必要がある。
// 依存パッケージは不要（Node.js 標準の WebCrypto だけを使う）。

const { subtle } = globalThis.crypto;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await subtle.exportKey('raw', pair.publicKey));
// 秘密鍵は JWK の d（32 バイトの base64url）をそのまま使う（web-push と同じ形式）
const { d: privateKey } = await subtle.exportKey('jwk', pair.privateKey);

console.log('VAPID_PUBLIC_KEY  =', publicKey);
console.log('VAPID_PRIVATE_KEY =', privateKey);
