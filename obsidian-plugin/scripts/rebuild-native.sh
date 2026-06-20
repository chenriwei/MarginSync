#!/usr/bin/env bash
# 为指定 Electron 版本编译 better-sqlite3 → prebuilds/<platform>/nmv-<N>/。
#
# 用法：
#   ELECTRON_VERSION=37.6.0 NMV=136 bash scripts/rebuild-native.sh
#   ELECTRON_VERSION=39.6.0 NMV=140 bash scripts/rebuild-native.sh
#   bash scripts/rebuild-all-native.sh   # 两个都编
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON_VERSION="${ELECTRON_VERSION:?set ELECTRON_VERSION, e.g. 37.6.0}"
NMV="${NMV:?set NMV, e.g. 136}"
PLATFORM="${PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"
OUT_DIR="prebuilds/${PLATFORM}/nmv-${NMV}"

echo "Rebuilding better-sqlite3 for Electron ${ELECTRON_VERSION} → NMV ${NMV} (${PLATFORM})…"
npm_config_runtime=electron \
  npm_config_target="${ELECTRON_VERSION}" \
  npm_config_disturl=https://electronjs.org/headers \
  npm rebuild better-sqlite3

mkdir -p "${OUT_DIR}"
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  "${OUT_DIR}/better_sqlite3.node"

node scripts/generate-native-embed.mjs
echo "Done — ${OUT_DIR}/better_sqlite3.node"
