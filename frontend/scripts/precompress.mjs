// Writes a `.br` and a `.gz` next to every compressible file in `dist/`.
//
// The Lean backend serves these assets itself and has no compressor available, so compression
// happens here, once, at build time; `serveStatic` just picks the best variant the client accepts
// (see `Taxis/Server/Serve.lean`). Uses only `node:zlib`, so this adds no dependency.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = new URL("../dist/", import.meta.url).pathname;
// Fonts and images are already compressed; running deflate over them costs build time and yields
// nothing (often a byte or two more than the original).
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".map", ".txt"]);
// Below roughly one TCP segment the framing overhead outweighs any saving.
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

let count = 0;
let rawTotal = 0;
let brTotal = 0;

for (const path of walk(DIST)) {
  if (!COMPRESSIBLE.has(extname(path))) continue;
  const raw = readFileSync(path);
  if (raw.length < MIN_BYTES) continue;

  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const gz = gzipSync(raw, { level: 9 });

  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.gz`, gz);

  count += 1;
  rawTotal += raw.length;
  brTotal += br.length;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`precompress: ${count} file(s), ${kb(rawTotal)} -> ${kb(brTotal)} brotli`);
