#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-$ROOT_DIR/_site}"

if ! command -v wasm-pack >/dev/null 2>&1; then
  printf '%s\n' "wasm-pack is required to build the DJ Party Pages artifact." >&2
  exit 2
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/pkg"

wasm-pack build "$ROOT_DIR" \
  --target web \
  --release \
  --no-typescript \
  --out-dir "$OUTPUT_DIR/pkg" \
  --out-name dj_party

cp "$ROOT_DIR/web/index.html" "$OUTPUT_DIR/index.html"
cp "$ROOT_DIR/web/app.js" "$OUTPUT_DIR/app.js"
cp "$ROOT_DIR/web/styles.css" "$OUTPUT_DIR/styles.css"
touch "$OUTPUT_DIR/.nojekyll"

for required in \
  "$OUTPUT_DIR/index.html" \
  "$OUTPUT_DIR/app.js" \
  "$OUTPUT_DIR/styles.css" \
  "$OUTPUT_DIR/pkg/dj_party.js" \
  "$OUTPUT_DIR/pkg/dj_party_bg.wasm"
do
  if [[ ! -s "$required" ]]; then
    printf 'Missing or empty Pages asset: %s\n' "$required" >&2
    exit 3
  fi
done

printf 'Built DJ Party Pages artifact at %s\n' "$OUTPUT_DIR"
