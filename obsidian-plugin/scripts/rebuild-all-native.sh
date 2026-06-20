#!/usr/bin/env bash
# Obsidian 1.11.x → Electron 37 (NMV 136)；Obsidian 1.12.x → Electron 39 (NMV 140)
set -euo pipefail
cd "$(dirname "$0")"

ELECTRON_VERSION=37.6.0 NMV=136 bash rebuild-native.sh
ELECTRON_VERSION=39.6.0 NMV=140 bash rebuild-native.sh
