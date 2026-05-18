#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="./MarginNote_Exports"

python3 mn_export_tool.py --by-book --out "$OUT_DIR" "$@"