#!/usr/bin/env bash
# 把 MarginNote 笔记按"书"聚合，导出到 Obsidian Vault 的 MarginNote 子库。
# 路径里 "Mobile Documents" 含空格、且 iCloud 容器名是 "iCloud~md~obsidian"，
# 必须整段用双引号包起来，否则 shell 会按空格拆 token，argparse 会报
# `unrecognized arguments: Documents/...`。
set -euo pipefail

OUT_DIR="/Users/bytedance/Library/Mobile Documents/iCloud~md~obsidian/Documents/陈日伟/MarginNote"

python3 mn_export_tool.py --by-book --out "$OUT_DIR" "$@"
