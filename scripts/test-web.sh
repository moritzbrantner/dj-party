#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.web-build"

rm -rf "$BUILD_DIR"
npm --prefix "$ROOT_DIR" run build:web
cp "$ROOT_DIR"/web/*.test.mjs "$BUILD_DIR"/
node --test "$BUILD_DIR"/*.test.mjs
