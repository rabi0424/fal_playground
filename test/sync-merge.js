// Worker のテストは worker.js を test/ に書き出してから import するので、
// worker.js の `import './sync-merge.js'` はこのファイルに解決される。本体へ転送する
import '../sync-merge.js';
