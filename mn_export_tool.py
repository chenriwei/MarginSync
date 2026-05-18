"""MarginNote → Obsidian 导出工具。

把 MarginNote 3/4 本地数据库里的笔记本（书籍 / 思维导图）导出为
Obsidian 友好的 Markdown 文件，输出风格参考 obsidian-weread-plugin。

使用：
    python mn_export_tool.py                  # 交互式选择
    python mn_export_tool.py --all            # 全量导出（按 Topic）
    python mn_export_tool.py --books-only     # 只导出书籍类 Topic
    python mn_export_tool.py --mindmaps-only  # 只导出思维导图 Topic
    python mn_export_tool.py --by-book        # 按"书"聚合：把同一本 PDF 在所有 Topic
                                              # 中产生的笔记合并到一份 markdown
    python mn_export_tool.py --id <topicid>   # 按 ZTOPICID 导出单个 Topic
    python mn_export_tool.py --keep-ai        # 保留 AI 节点（默认过滤）
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import os
import plistlib
import re
import sqlite3
import sys
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Candidate database paths. The first one that exists wins. MN4 优先。
DB_CANDIDATES = [
    (
        "MarginNote 4",
        "marginnote4app",
        os.path.expanduser(
            "~/Library/Containers/QReader.MarginStudy.easy/Data/Library/"
            "Private Documents/MN4NotebookDatabase/0/MarginNotes.sqlite"
        ),
    ),
    (
        "MarginNote 3",
        "marginnote3app",
        os.path.expanduser(
            "~/Library/Containers/QReader.MarginStudy.RealPro/Data/Library/"
            "MarginNote Extensions/marginnote.extension.notedatabase/"
            "MarginNotes_default_3.0.sqlite"
        ),
    ),
]

OUTPUT_DIR = "MarginNote_Exports"

# macOS NSDate 起始（2001-01-01）距离 unix epoch 的秒数。
NSDATE_EPOCH_OFFSET = 978307200


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


@dataclass
class DBContext:
    conn: sqlite3.Connection
    app_name: str          # MarginNote 3 / MarginNote 4
    url_scheme: str        # marginnote3app / marginnote4app
    db_path: str


def open_database() -> DBContext | None:
    for app_name, url_scheme, path in DB_CANDIDATES:
        if os.path.exists(path):
            try:
                conn = sqlite3.connect(path)
                conn.row_factory = sqlite3.Row
                return DBContext(conn, app_name, url_scheme, path)
            except Exception as exc:  # noqa: BLE001
                print(f"⚠️  无法打开 {app_name} 数据库: {exc}")
    print("❌ 没有找到 MarginNote 数据库，请确认 MarginNote 已经登录并打开过。")
    print("   已尝试的路径：")
    for app_name, _, path in DB_CANDIDATES:
        print(f"   - {app_name}: {path}")
    return None


# ---------------------------------------------------------------------------
# Plist helpers (image hash + media unwrap)
# ---------------------------------------------------------------------------


def extract_paint_hash(blob: bytes) -> str | None:
    """从 ZHIGHLIGHT_PIC 的 plist 包裹中取出 paint 字段的 MD5。"""
    if not blob:
        return None
    try:
        pl = plistlib.loads(blob)
        objects = pl.get("$objects", [])

        paint_uid = None
        for i, obj in enumerate(objects):
            if obj == "paint":
                paint_uid = i
                break
        if paint_uid is None:
            return None

        for obj in objects:
            if not (isinstance(obj, dict) and "NS.keys" in obj and "NS.objects" in obj):
                continue
            keys, vals = obj["NS.keys"], obj["NS.objects"]
            for k_idx, k_uid in enumerate(keys):
                uid_val = k_uid.data if hasattr(k_uid, "data") else k_uid
                if uid_val == paint_uid:
                    val_uid = vals[k_idx]
                    idx = val_uid.data if hasattr(val_uid, "data") else val_uid
                    return objects[idx]
    except Exception:
        return None
    return None


_IMAGE_MAGIC = (b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF")


def _looks_like_image(data: bytes | None) -> bool:
    if not data or len(data) < 32:
        return False
    return any(data.startswith(m) for m in _IMAGE_MAGIC)


def unwrap_media_data(blob: bytes) -> bytes | None:
    """ZMEDIA.ZDATA / ZHIGHLIGHT_PIC 中的图片可能被 NSKeyedArchiver 包了一层。

    常见两种结构：
    1) `$objects` 里有一个直接的 `bytes` 对象（旧格式）。
    2) `$objects[i]` 是 `{"NS.data": <bytes>, "$class": <UID>}`（NSData 归档）。
    """
    if not blob:
        return None
    try:
        pl = plistlib.loads(blob)
    except Exception:
        return blob if _looks_like_image(blob) else None

    objects = pl.get("$objects", []) if isinstance(pl, dict) else []
    for obj in objects:
        if isinstance(obj, bytes) and _looks_like_image(obj):
            return obj
        if isinstance(obj, dict):
            data = obj.get("NS.data")
            if isinstance(data, bytes) and _looks_like_image(data):
                return data
    return blob if _looks_like_image(blob) else None


# ---------------------------------------------------------------------------
# Text cleaning
# ---------------------------------------------------------------------------

# PDF 提取常见的"每个字符之间有空格"问题（如 "同 样 一 个 功 能 ， 工 程 师"），
# 通过启发式判断：单字 token 比例较高时认为是被空格分裂的，重新拼接。
_ASCII_WORD_RE = re.compile(r"[A-Za-z0-9]")


def _is_ascii_word(ch: str) -> bool:
    return bool(ch) and bool(_ASCII_WORD_RE.match(ch))


def _normalize_pdf_spaces(text: str) -> str:
    """缓解 PDF 提取造成的字符间空格。"""
    if not text:
        return text

    def _process_line(line: str) -> str:
        # 统计单字符 token 比例，比例够高才认为是被空格分裂的 PDF 文本。
        tokens = line.split(" ")
        if len(tokens) < 6:
            return line
        single = sum(1 for t in tokens if len(t) == 1)
        if single / max(1, len(tokens)) < 0.5:
            return line
        # 在拆字行里，仅保留"两侧都是 ASCII 字母数字"的空格，其余全部删除。
        out: list[str] = []
        n = len(line)
        for i, ch in enumerate(line):
            if ch == " ":
                prev_ch = line[i - 1] if i > 0 else ""
                next_ch = line[i + 1] if i + 1 < n else ""
                if _is_ascii_word(prev_ch) and _is_ascii_word(next_ch):
                    out.append(ch)
                # 否则丢掉
            else:
                out.append(ch)
        return "".join(out)

    return "\n".join(_process_line(ln) for ln in text.splitlines())


# PDF 提取常见的 CJK 部首字（U+2E80–U+2FDF）人工映射到简体常用字。
# Python NFKC 不会替换这些字符，但它们出现在 MarginNote 抽取的 PDF 文本里会很扎眼。
_CJK_RADICAL_MAP = {
    "⺠": "民", "⻔": "门", "⻄": "西", "⻅": "见", "⻆": "角",
    "⻉": "贝", "⻋": "车", "⻓": "长", "⻘": "青", "⻚": "页",
    "⻛": "风", "⻜": "飞", "⻝": "食", "⻢": "马", "⻣": "骨",
    "⻤": "鬼", "⻥": "鱼", "⻦": "鸟", "⻧": "卤", "⻨": "麦",
    "⻩": "黄", "⻫": "齐", "⻬": "齿", "⻰": "龙", "⻱": "龟",
    "⺁": "厂", "⺄": "乙", "⺈": "刀", "⺉": "刂", "⺋": "卩",
    "⺌": "小", "⺍": "小", "⺎": "兀", "⺏": "尢", "⺐": "尣",
    "⺒": "巳", "⺓": "幺", "⺔": "彑", "⺕": "彐", "⺖": "心",
    "⺘": "扌", "⺙": "攵", "⺛": "无", "⺜": "曰", "⺝": "月",
    "⺠": "民", "⺢": "氺", "⺣": "灬", "⺤": "爪", "⺩": "王",
    "⺪": "无", "⺫": "目", "⺬": "示", "⺮": "竹", "⺯": "糸",
    "⺰": "纟", "⺳": "罒", "⺴": "网", "⺵": "网", "⺶": "羊",
    "⺷": "羊", "⺸": "羊", "⺹": "老", "⺺": "耂", "⺻": "聿",
    "⺼": "肉", "⺽": "臼", "⻁": "虎", "⻂": "衤", "⻃": "西",
    "⻇": "言", "⻌": "辶", "⻍": "辶", "⻎": "车", "⻎": "车",
}


def _normalize_cjk_compat(text: str) -> str:
    if not text:
        return text
    return "".join(_CJK_RADICAL_MAP.get(ch, ch) for ch in text)


# 移除 MarginNote 思维导图里的按钮语法 $$button:xxx:color$$。
_BUTTON_RE = re.compile(r"\$\$button:[^$\n]*?\$\$")


def _strip_mn_buttons(text: str) -> str:
    return _BUTTON_RE.sub("", text)


# 形如 `<pad>` `<form>` `<unk>` `<|endoftext|>` `<br/>` `</p>` 的"裸"标签：
# 标签名由字母/数字/下划线/`|`/`-` 组成，且**没有属性**（即 `<` 后只有名字
# 和可选 `/`）。带属性的（`<a href="...">`）不匹配，视为真 inline HTML。
_BARE_TAG_RE = re.compile(r"<(/?)(\|?[A-Za-z][\w|\-]*\|?)\s*(/?)>")


def _escape_pseudo_html(text: str) -> str:
    """把裸标签（`<pad>` `<form>` `<|endoftext|>` 等）包成 inline code。

    背景：MarginNote 笔记 / 教材里出现的 `<form>` `<br>` `<sub>` `<var>` 几乎
    都是在**引用 HTML 标签字面量**（"使用 `<form>` 标签定义表单"），用户并
    不期望它真的被渲染为 HTML 元素。

    更要命的是：哪怕是真 HTML 标签名，只要不闭合、当 inline 文本用，就会
    扰乱 Obsidian/markdown-it → 浏览器的渲染：`<form>` 会创建 form 元素并
    把后面的兄弟节点都吃成自己的子树，导致紧跟的 `> quote` 蓝条 /
    `> [!note]+` callout 装饰整段失效（裸文本）。同样的事情会发生在
    `<pad>` `<unk>` `<|endoftext|>` 等 LLM token 上。

    所以策略是：**所有"裸标签"形态（无属性）一律包成 inline code**，无论
    名字是不是真的 HTML 标签。带属性的 `<a href="...">` `<img src=...>`
    才视为真 inline HTML（极少见，正确写出来的话保留）。
    """
    if not text or "<" not in text:
        return text

    # 跳过反引号包裹的 inline code 段：split 后偶数索引是普通文本，奇数索引
    # 是 code 段（保持原样），逐段替换避免破坏已经写好的 ``…``。
    parts = text.split("`")
    for i in range(0, len(parts), 2):
        seg = parts[i]
        if "<" not in seg:
            continue
        parts[i] = _BARE_TAG_RE.sub(lambda m: f"`{m.group(0)}`", seg)
    return "`".join(parts)


def clean_text(text: str | None) -> str:
    if not text:
        return ""
    text = _normalize_cjk_compat(text)
    text = _normalize_pdf_spaces(text)
    text = _strip_mn_buttons(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 移除零宽字符
    text = text.replace("\u200b", "").replace("\ufeff", "")
    text = _escape_pseudo_html(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 注意：marginnote:// 卡片关联链接不在这里包装。它们在批注里通常是
    # MarginNote 4 "卡片关联跳转"功能写入的，希望被 _split_card_links 单独剥出
    # 来渲染为 "🔗 关联：[label](url)" 行。如果在这里就把它们包成 markdown
    # 链接，_split_card_links 的正则会把里面的 url 抽走，留下 "[🔗 卡片]()"
    # 这种坏掉的空链接。所以包装动作交由调用方在拆分之后自行处理。
    return text.strip()


# Obsidian 中只有"行首 `#` 后跟空格"才会被解析为标题；
# 单纯的 `#tag` 不需要转义，但作为列表项内容里"空格 + #"开头时仍需保留。
_HEADER_RE = re.compile(r"^(\s*)(#{1,6})(\s)")


def escape_markdown_header(line: str) -> str:
    """把行首的 markdown 标题语法转义掉，避免被 Obsidian 当成标题。"""
    return _HEADER_RE.sub(r"\1\\\2\3", line)


# 抽取 ZNOTES_TEXT 里的 #tag 列表（行尾或独立行的 hashtag）。
# 真实样例形如 `#错两次 #知识点 #题型/不等式变形`。
_HASHTAG_RE = re.compile(r"(?<![\w])#([\w/\u4e00-\u9fff][\w/\u4e00-\u9fff\-]*)")


def extract_hashtags(text: str) -> list[str]:
    if not text:
        return []
    found = _HASHTAG_RE.findall(text)
    # 去重保序
    seen, out = set(), []
    for tag in found:
        if tag not in seen:
            seen.add(tag)
            out.append(tag)
    return out


def ns_date_to_iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        unix_ts = ts + NSDATE_EPOCH_OFFSET
        return datetime.datetime.fromtimestamp(unix_ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Note classification helpers
# ---------------------------------------------------------------------------

# AI 上下文节点的两个特征性 placeholder。
AI_CONTEXT_MARKERS = ("{{文档上下文}}", "{{MindMap Context}}")


def is_ai_context_node(note: sqlite3.Row) -> bool:
    if note["ZTYPE"] != 9:
        return False
    title = note["ZNOTETITLE"] or ""
    return any(marker in title for marker in AI_CONTEXT_MARKERS)


def is_ai_answer_node(note: sqlite3.Row) -> bool:
    """ZTYPE=9 且不是上下文节点，认为是 AI 的回答。"""
    return note["ZTYPE"] == 9 and not is_ai_context_node(note)


# ---------------------------------------------------------------------------
# Notebook / Note fetching
# ---------------------------------------------------------------------------


def list_notebooks(ctx: DBContext) -> list[sqlite3.Row]:
    cursor = ctx.conn.cursor()
    try:
        cursor.execute(
            "SELECT ZTOPICID, ZTITLE, ZMINDLINKS, ZBOOKLIST, ZDATE, ZLASTVISIT "
            "FROM ZTOPIC WHERE ZTITLE IS NOT NULL "
            "ORDER BY ZLASTVISIT DESC"
        )
    except sqlite3.OperationalError:
        cursor.execute(
            "SELECT ZTOPICID, ZTITLE, ZMINDLINKS, ZBOOKLIST, ZDATE "
            "FROM ZTOPIC WHERE ZTITLE IS NOT NULL "
            "ORDER BY ZDATE DESC"
        )
    return cursor.fetchall()


def fetch_book_titles(ctx: DBContext, book_md5_list: Iterable[str]) -> list[dict]:
    """根据 ZBOOKMD5（即 ZBOOK.ZMD5LONG）查找书籍信息。"""
    md5s = [m for m in book_md5_list if m]
    if not md5s:
        return []
    placeholders = ",".join("?" * len(md5s))
    cursor = ctx.conn.cursor()
    cursor.execute(
        f"SELECT ZMD5, ZMD5LONG, ZAUTHOR, ZFILE FROM ZBOOK "
        f"WHERE ZMD5LONG IN ({placeholders}) OR ZMD5 IN ({placeholders})",
        md5s + md5s,
    )
    out = []
    for row in cursor.fetchall():
        title = row["ZFILE"] or ""
        # 去掉文件后缀
        title = re.sub(r"\.(pdf|epub|mobi|txt|docx?|mp4|pptx?|html?)$", "", title, flags=re.I)
        out.append({
            "md5": row["ZMD5"],
            "md5long": row["ZMD5LONG"],
            "author": (row["ZAUTHOR"] or "").strip() or None,
            "title": title.strip(),
        })
    return out


def fetch_notes(ctx: DBContext, topic_id: str) -> list[sqlite3.Row]:
    cursor = ctx.conn.cursor()

    cursor.execute("SELECT ZMINDLINKS FROM ZTOPIC WHERE ZTOPICID = ?", (topic_id,))
    row = cursor.fetchone()
    seed_ids: set[str] = set()
    if row and row["ZMINDLINKS"]:
        seed_ids.update(x for x in row["ZMINDLINKS"].split("|") if x)

    cursor.execute("SELECT ZNOTEID FROM ZBOOKNOTE WHERE ZTOPICID = ?", (topic_id,))
    seed_ids.update(r["ZNOTEID"] for r in cursor.fetchall() if r["ZNOTEID"])

    pending = set(seed_ids)
    seen: set[str] = set()
    notes: list[sqlite3.Row] = []

    while pending:
        # 必须 sort 以保证跨进程稳定的迭代顺序——Python 的 set 迭代顺序受
        # PYTHONHASHSEED 影响，每次运行都可能不同；这会导致 notes 列表顺序、
        # 后续 by_topic 字典的插入顺序、以及 main_tid 选择（在 topic_score
        # 打平时）在两次跑之间漂移，让"内容未变化也被反复重写"。
        batch = sorted(pending)[:500]
        pending.difference_update(batch)
        placeholders = ",".join("?" * len(batch))
        cursor.execute(
            f"""
            SELECT
                ZNOTEID, ZNOTETITLE, ZHIGHLIGHT_TEXT, ZNOTES_TEXT,
                ZMINDLINKS, ZHIGHLIGHT_PIC, ZTYPE,
                ZSTARTPAGE, ZSTARTPOS, ZCHILDMAPNOTEID,
                ZHIGHLIGHT_DATE, ZNOTE_DATE,
                ZHIGHLIGHT_STYLE, ZBOOKMD5
            FROM ZBOOKNOTE
            WHERE ZNOTEID IN ({placeholders})
            """,
            batch,
        )
        for note in cursor.fetchall():
            nid = note["ZNOTEID"]
            if nid in seen:
                continue
            seen.add(nid)
            notes.append(note)
            links = note["ZMINDLINKS"]
            if links:
                for cid in links.split("|"):
                    if cid and cid not in seen:
                        pending.add(cid)
    return notes


def fetch_media(ctx: DBContext, notes: list[sqlite3.Row]) -> tuple[dict[str, bytes], dict[str, str]]:
    """根据笔记里的图片 hash 批量取 ZMEDIA 数据。"""
    media_map: dict[str, bytes] = {}
    note_hash_map: dict[str, str] = {}
    hashes: set[str] = set()

    for note in notes:
        blob = note["ZHIGHLIGHT_PIC"]
        if not blob:
            continue
        if blob.startswith(b"bplist"):
            h = extract_paint_hash(blob)
            if h:
                hashes.add(h)
                note_hash_map[note["ZNOTEID"]] = h

    if hashes:
        cursor = ctx.conn.cursor()
        hash_list = list(hashes)
        for i in range(0, len(hash_list), 500):
            batch = hash_list[i : i + 500]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"SELECT ZMD5, ZDATA FROM ZMEDIA WHERE ZMD5 IN ({placeholders})",
                batch,
            )
            for row in cursor.fetchall():
                data = row["ZDATA"]
                if not data:
                    continue
                if data.startswith(b"bplist"):
                    data = unwrap_media_data(data)
                elif not _looks_like_image(data):
                    data = None
                if data:
                    media_map[row["ZMD5"]] = data
    return media_map, note_hash_map


def _resolve_note_image(
    note: sqlite3.Row,
    media_map: dict[str, bytes],
    note_hash_map: dict[str, str],
) -> bytes | None:
    """从一条笔记上拿到真正的图片字节流，找不到则返回 None。

    优先级：ZMEDIA(paint hash) → ZHIGHLIGHT_PIC 自身（裸 PNG/JPEG 或 NSKeyedArchiver 包裹）。
    会过滤 1×1 之类的占位图片（小于 256 字节的 PNG 视为占位）。
    """
    h = note_hash_map.get(note["ZNOTEID"])
    data = media_map.get(h) if h else None
    blob = note["ZHIGHLIGHT_PIC"]
    if not data and blob:
        if blob.startswith(b"bplist"):
            data = unwrap_media_data(blob)
        elif _looks_like_image(blob):
            data = blob
    if not data:
        return None
    if data.startswith(b"\x89PNG") and len(data) < 256:
        return None
    return data


# ---------------------------------------------------------------------------
# Tree building
# ---------------------------------------------------------------------------


@dataclass
class TreeNode:
    note: sqlite3.Row
    children: list["TreeNode"] = field(default_factory=list)


def _has_real_content(note: sqlite3.Row) -> bool:
    if note["ZHIGHLIGHT_TEXT"]:
        return True
    if note["ZNOTES_TEXT"]:
        return True
    if note["ZHIGHLIGHT_PIC"]:
        return True
    if note["ZCHILDMAPNOTEID"]:
        return True
    return False


def _prune_empty_branches(nodes: list[TreeNode]) -> list[TreeNode]:
    """自下而上剪掉没有任何实质内容、子树也为空的占位节点。"""
    kept: list[TreeNode] = []
    for tn in nodes:
        tn.children = _prune_empty_branches(tn.children)
        if _has_real_content(tn.note) or tn.children:
            kept.append(tn)
        # 如果只有 title 且无子树，则丢弃（典型为孤立的导航占位节点）
    return kept


def build_tree(notes: list[sqlite3.Row]) -> list[TreeNode]:
    note_map = {n["ZNOTEID"]: n for n in notes}
    nodes = {nid: TreeNode(note=n) for nid, n in note_map.items()}
    children_set: set[str] = set()

    for note in notes:
        if not note["ZMINDLINKS"]:
            continue
        parent = nodes[note["ZNOTEID"]]
        for cid in note["ZMINDLINKS"].split("|"):
            if cid in nodes:
                parent.children.append(nodes[cid])
                children_set.add(cid)

    roots = [n for nid, n in nodes.items() if nid not in children_set]

    def sort_key(tn: TreeNode) -> tuple:
        n = tn.note
        page = n["ZSTARTPAGE"] if n["ZSTARTPAGE"] is not None else 0
        x, y = 0.0, 0.0
        pos = n["ZSTARTPOS"]
        if pos:
            try:
                parts = pos.split(",")
                if len(parts) >= 2:
                    x = float(parts[0])
                    y = float(parts[1])
            except ValueError:
                pass
        # 页码升序、Y 降序（顶部优先）、X 升序
        return (page, -y, x)

    def sort_recursive(node_list: list[TreeNode]) -> None:
        node_list.sort(key=sort_key)
        for n in node_list:
            sort_recursive(n.children)

    sort_recursive(roots)
    roots = _prune_empty_branches(roots)
    return roots


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


@dataclass
class RenderOptions:
    keep_ai_nodes: bool = False
    image_dir_relative: str = "../assets"
    url_scheme: str = "marginnote4app"
    heading_levels: int = 2  # L1->H2, L2->H3, 之后用列表
    # 当根节点没有子树（典型如划线类书籍）时，是否把它们也渲染成列表项
    flat_roots_as_list: bool = True
    # 是否递归展开子思维导图。Books-only 模式下应当为 False。
    recurse_child_maps: bool = True
    # 图片宽度。> 0 时输出 Obsidian 私有的 `![|N](path)` 写法限制显示宽度；
    # 默认 0 输出标准 Markdown `![](path)`，对所有渲染器（VS Code、GitHub、
    # Cursor 内置 preview 等）都通用。Obsidian 自身在标准写法下也能正常显示，
    # 只是不再强制宽度。
    image_width: int = 0
    # 卡片关联链接的 label 字典：{ZNOTEID: "目标卡片标题/摘录前缀"}。
    # MarginNote 用户在某段笔记上做"关联跳转"时，ZNOTES_TEXT 里只有
    # marginnote4app://note/<id> 一行；导出时若能查到目标卡片的标题/摘录，
    # 就用它做链接 label，使 "🔗 关联：[xxxx](url)" 一目了然。
    card_labels: dict[str, str] | None = None
    # 本次运行已经写过的 .md 绝对路径集合。同次运行内若有真正撞名的另一本
    # 书（罕见），就附 (1)/(2) 后缀；vault 里上次留下的同名文件不再触发
    # +(1)，让"原地更新"成为默认行为，保留 mtime/ctime。
    generated_paths: set[str] | None = None
    # 本书内**所有 note 的 excerpt（划线原文）归一化集合**。用于剥掉批注里
    # 跟独立划线重复的段落：原则是"原文是基础，批注是附加，重复时删批注、
    # 保留划线 quote"。渲染时若批注里某段的归一化字符串落在这个集合里，就
    # 把那段从 callout 中删掉；若整条 comment 被剥空则不再输出 callout。
    excerpt_norms_in_book: set[str] | None = None


@dataclass
class RenderStats:
    note_count: int = 0
    image_count: int = 0
    skipped_ai: int = 0
    skipped_empty: int = 0


def _resolve_dedup(title: str, excerpt: str) -> tuple[str, str]:
    """决定标题与摘录重复时各自的保留/丢弃，返回 (title_to_show, excerpt_to_show)。

    规则按"保留信息量更多"的原则：

    - **完全相同**（单词卡场景：``title='extraordinarily', excerpt='extraordinarily'``）
      → 保留 title（加粗单行更紧凑），丢 excerpt。
    - **title 是 excerpt 的严格子串**（如 ``title='重点', excerpt='...这是一段重点内容...'``）
      → title 信息含量更少，丢 title 保 excerpt。
    - **excerpt 是 title 的严格子串**（罕见，比如 title 用户加了前缀/后缀注释）
      → 保留 title，丢 excerpt。
    - 完全无关 → 两者都保留。
    """
    if not (title and excerpt):
        return (title, excerpt)

    def normalize(s: str) -> str:
        return "".join(c for c in s if c.isalnum())

    t_norm = normalize(title)
    e_norm = normalize(excerpt)
    if not t_norm or not e_norm:
        return (title, excerpt)
    if t_norm == e_norm:
        return (title, "")
    if t_norm in e_norm:
        return ("", excerpt)
    if e_norm in t_norm:
        return (title, "")
    return (title, excerpt)


def _is_redundant(title: str, excerpt: str) -> bool:
    """老版的"是否需要去重"二元判断。新代码请直接用 ``_resolve_dedup``，本函数仅留作向后兼容。"""
    if not (title and excerpt):
        return False

    def normalize(s: str) -> str:
        return "".join(c for c in s if c.isalnum())

    t_norm = normalize(title)
    e_norm = normalize(excerpt)
    if not t_norm or not e_norm:
        return False
    return (
        title.strip() == excerpt.strip()
        or t_norm in e_norm
        or e_norm in t_norm
    )


def _backlink(note_id: str, page: int | None, url_scheme: str) -> str:
    """单一锚点链接：有页码用 `[p.X](url)`，无页码用 `[>>](url)`。
    采用纯 ASCII 链接文本，确保 Obsidian 不会"吃掉"特殊字符导致协议跳转失效。"""
    url = f"{url_scheme}://note/{note_id}"
    label = f"p.{page}" if page else ">>"
    return f"[{label}]({url})"


def _split_tags_from_comment(comment: str) -> tuple[str, list[str]]:
    """从评论里抽取 #标签，并把那些"独占行的标签行"剥离。"""
    if not comment:
        return "", []
    tags = extract_hashtags(comment)

    cleaned_lines: list[str] = []
    for line in comment.splitlines():
        stripped = line.strip()
        # 整行都是 hashtag 的（#a #b #c），去掉以避免污染正文
        if stripped and re.fullmatch(r"(?:#[\w/\u4e00-\u9fff][\w/\u4e00-\u9fff\-]*\s*)+", stripped):
            continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip(), tags


def _emit_excerpt(
    excerpt: str,
    lines: list[str],
    indent: str,
    *,
    trailing_link: str | None = None,
    bullet: str | None = None,
) -> None:
    """摘录渲染为普通 list 项 / 段落（不再加 `> ` quote 前缀）。

    早期版本曾用 `> quote` 突出"PDF 原文"身份，但当一本书的笔记 90% 都是
    纯摘录时，Obsidian 主题给每个 blockquote 加的左竖条 + 内外边距会让多
    个相邻 quote 撑出非常松散的视觉间距，可读性差。现在改为：
    - 纯摘录 → list item 直接放纯文本，密度紧凑（与 MarginNote 旧版导出风格一致）
    - 用户写的批注 → 走 `[!note]+ 💭 我的批注` callout 卡片，已自带视觉强调
    - 用户归纳的 title → 仍以粗体 list head 形式呈现

    这样原文 / 自己写 / 自己归纳 三种内容的层级仍然清晰，但密度不再被 quote 撑破。

    - `bullet` 不为 None：第一行作 list head（`{bullet}第一行`），后续行用 `indent` 续行。
    - `trailing_link` 不为 None：附在最后一行末尾（间隔两个空格 → markdown 软换行）。
    """
    raw_lines = [r for r in excerpt.splitlines() if r.strip()]
    if not raw_lines:
        return
    n = len(raw_lines)
    for i, raw in enumerate(raw_lines):
        out = escape_markdown_header(raw)
        suffix = f"  {trailing_link}" if (trailing_link and i == n - 1) else ""
        if i == 0 and bullet is not None:
            lines.append(f"{bullet}{out}{suffix}")
        else:
            lines.append(f"{indent}{out}{suffix}")


def _emit_card_links(
    card_ids: list[str],
    options: RenderOptions,
    lines: list[str],
    indent: str,
    *,
    self_id: str | None = None,
    trailing_link: str | None = None,
    bullet: str | None = None,
) -> None:
    """渲染"卡片关联跳转"行：`🔗 关联：[label](marginnote4app://note/<id>)`。

    - 多个关联各占一行（list head 行只用一次 bullet）。
    - 自指（`self_id` == 关联 id）的链接跳过——MarginNote 偶发会有这种循环数据。
    - label 优先从 `options.card_labels` 取目标卡片的 title/excerpt 前缀；
      查不到时回退为 `🔗 关联卡片`。
    """
    rendered: list[tuple[str, str]] = []  # (label, url)
    labels = options.card_labels or {}
    for cid in card_ids:
        if self_id and cid == self_id:
            continue
        url = f"{options.url_scheme}://note/{cid}"
        raw_label = labels.get(cid, "")
        label = raw_label.strip() if raw_label else ""
        if not label:
            label = "🔗 关联卡片"
        else:
            # label 中的 markdown 特殊字符（如 [、]、|）会破坏链接语法
            label = re.sub(r"[\[\]|]", " ", label)
            label = re.sub(r"\s+", " ", label).strip()
            # 截断过长的目标 label，避免占太多视觉空间
            if len(label) > 50:
                label = label[:50] + "…"
            label = f"🔗 关联：{label}"
        rendered.append((label, url))
    if not rendered:
        return
    n = len(rendered)
    for i, (label, url) in enumerate(rendered):
        suffix = f"  {trailing_link}" if (trailing_link and i == n - 1) else ""
        head = f"[{label}]({url}){suffix}"
        if i == 0 and bullet is not None:
            lines.append(f"{bullet}{head}")
        else:
            lines.append(f"{indent}{head}")


def _emit_comment(
    comment: str,
    lines: list[str],
    indent: str,
    *,
    trailing_link: str | None = None,
    bullet: str | None = None,
) -> None:
    """评论渲染为 Obsidian [!note] callout。"""
    if not comment.strip():
        return
    # 兜底：批注里若仍残留 marginnote:// 裸链（_split_card_links 已先剥过卡片关联，
    # 这里基本只剩用户偶尔粘贴的他书 URL），包装成 "[🔗 卡片](url)" 防止变光秃。
    comment = _wrap_mn_urls(comment)
    parts = comment.splitlines()
    header_line = "> [!note]+ 💭 我的批注"
    if bullet is not None:
        lines.append(f"{bullet}{header_line}")
    else:
        lines.append(f"{indent}{header_line}")
    n = len(parts)
    for i, raw in enumerate(parts):
        out = escape_markdown_header(raw) if raw.strip() else ""
        suffix = f"  {trailing_link}" if (trailing_link and i == n - 1) else ""
        lines.append(f"{indent}> {out}{suffix}")


def _emit_image(
    note_id: str,
    image_data: bytes,
    images_dir: str,
    options: RenderOptions,
    lines: list[str],
    indent: str,
    *,
    trailing_link: str | None = None,
    bullet: str | None = None,
) -> bool:
    image_filename = f"{note_id}.png"
    image_path = os.path.join(images_dir, image_filename)
    if not os.path.exists(image_path):
        with open(image_path, "wb") as f:
            f.write(image_data)
    rel = f"{options.image_dir_relative}/{image_filename}"
    alt = f"|{options.image_width}" if options.image_width and options.image_width > 0 else ""
    suffix = f"  {trailing_link}" if trailing_link else ""
    prefix = bullet if bullet is not None else indent
    lines.append(f"{prefix}![{alt}]({rel}){suffix}")
    return True


def render_node(
    node: TreeNode,
    level: int,
    md_lines: list[str],
    images_dir: str,
    media_map: dict[str, bytes],
    note_hash_map: dict[str, str],
    options: RenderOptions,
    stats: RenderStats,
    book_titles: list[str],
    force_list: bool = False,
    extra_renderer: Callable[[TreeNode, list[str], str], None] | None = None,
) -> None:
    note = node.note

    # 过滤
    if is_ai_context_node(note):
        stats.skipped_ai += 1
        # 仍然递归子节点（一般 AI 节点没有子节点，但保险）
        for child in node.children:
            render_node(child, level, md_lines, images_dir, media_map,
                        note_hash_map, options, stats, book_titles,
                        extra_renderer=extra_renderer)
        return
    is_ai_answer = is_ai_answer_node(note)
    if is_ai_answer and not options.keep_ai_nodes:
        stats.skipped_ai += 1
        for child in node.children:
            render_node(child, level, md_lines, images_dir, media_map,
                        note_hash_map, options, stats, book_titles,
                        extra_renderer=extra_renderer)
        return

    title = clean_text(note["ZNOTETITLE"])
    excerpt = clean_text(note["ZHIGHLIGHT_TEXT"])
    raw_comment = note["ZNOTES_TEXT"] or ""
    comment = clean_text(raw_comment)
    comment, _tags_in_comment = _split_tags_from_comment(comment)
    # 把 marginnote://note/<id> 这种"卡片关联"从批注里抽出来单独渲染——
    # 否则 callout 内只剩一条自包装的 [url](url) 既丑又没信息量。
    comment, card_link_ids = _split_card_links(comment)
    page = note["ZSTARTPAGE"] or None

    image_data = _resolve_note_image(note, media_map, note_hash_map)

    title_to_show, excerpt_to_show = _resolve_dedup(title, excerpt)
    has_body = (
        bool(excerpt_to_show) or bool(comment) or bool(image_data) or bool(card_link_ids)
    )
    if not (title or has_body):
        stats.skipped_empty += 1
        return

    has_children = bool(node.children)
    head_text: str | None = None
    if title_to_show:
        head_text = title_to_show.strip()
    elif has_children and excerpt_to_show:
        # 这是真正的"分组父节点"——用户没写 title，而是用 PDF 划线本身作为
        # 章节/分组标题（如《背叛》里的"第一章"）。把摘录第一行抬作 head，
        # 余下走 quote，保留 mindmap 层级。
        ex_lines = [l for l in excerpt_to_show.splitlines() if l.strip()]
        if ex_lines:
            head_text = ex_lines[0].strip()
            excerpt_to_show = "\n".join(ex_lines[1:]).strip()

    if head_text:
        head_text = escape_markdown_header(head_text)
        if is_ai_answer:
            head_text = f"🤖 {head_text}"

    backlink = _backlink(note["ZNOTEID"], page, options.url_scheme)

    # 升级为 heading 的条件：
    #   1) 节点有 head 文本（用户 title，或分组父节点抽出的章节摘录）
    #   2) 不是强制 list 模式
    #   3) 处在 heading_levels 范围内
    # 注意：纯叶子摘录节点没 head_text，永远不会被升级为 heading，
    # 避免"### [p.X]"这种页码当标题的丑陋样式。
    use_heading = (
        head_text is not None
        and not force_list
        and level <= options.heading_levels
    )

    if use_heading:
        heading_prefix = "#" * (level + 1)  # L1 -> H2
        md_lines.append("")
        md_lines.append(f"{heading_prefix} {head_text}  {backlink}")
        md_lines.append("")
        body_indent = ""
        if excerpt_to_show:
            _emit_excerpt(excerpt_to_show, md_lines, body_indent)
        if image_data:
            _emit_image(note["ZNOTEID"], image_data, images_dir, options,
                        md_lines, body_indent)
            stats.image_count += 1
        if comment:
            _emit_comment(comment, md_lines, body_indent)
        if card_link_ids:
            _emit_card_links(card_link_ids, options, md_lines, body_indent,
                             self_id=note["ZNOTEID"])
    else:
        if force_list:
            list_depth = level - 1
        else:
            list_depth = level - options.heading_levels - 1
        list_indent = "  " * max(0, list_depth)
        bullet = f"{list_indent}- "
        body_indent = "  " * (max(0, list_depth) + 1)

        if head_text:
            # 有 title：list head 携带 backlink；body 各项原样输出
            md_lines.append(f"{bullet}**{head_text}**  {backlink}")
            if excerpt_to_show:
                _emit_excerpt(excerpt_to_show, md_lines, body_indent)
            if image_data:
                _emit_image(note["ZNOTEID"], image_data, images_dir, options,
                            md_lines, body_indent)
                stats.image_count += 1
            if comment:
                _emit_comment(comment, md_lines, body_indent)
            if card_link_ids:
                _emit_card_links(card_link_ids, options, md_lines, body_indent,
                                 self_id=note["ZNOTEID"])
        else:
            # 无 title：list head 直接由"主体内容"承担；backlink 附在最后元素的最后一行末尾
            slots: list[str] = []
            if excerpt_to_show: slots.append("excerpt")
            if image_data: slots.append("image")
            if comment: slots.append("comment")
            if card_link_ids: slots.append("cardlinks")
            last = slots[-1] if slots else None

            first_emitted = False
            for slot in slots:
                head_bullet = bullet if not first_emitted else None
                tlink = backlink if slot == last else None
                if slot == "excerpt":
                    _emit_excerpt(excerpt_to_show, md_lines, body_indent,
                                  trailing_link=tlink, bullet=head_bullet)
                elif slot == "image":
                    _emit_image(note["ZNOTEID"], image_data, images_dir, options,
                                md_lines, body_indent,
                                trailing_link=tlink, bullet=head_bullet)
                    stats.image_count += 1
                elif slot == "comment":
                    _emit_comment(comment, md_lines, body_indent,
                                  trailing_link=tlink, bullet=head_bullet)
                elif slot == "cardlinks":
                    _emit_card_links(card_link_ids, options, md_lines, body_indent,
                                     self_id=note["ZNOTEID"],
                                     trailing_link=tlink, bullet=head_bullet)
                first_emitted = True

    stats.note_count += 1

    if extra_renderer is not None:
        extra_renderer(node, md_lines, body_indent)

    for child in node.children:
        render_node(
            child, level + 1, md_lines, images_dir, media_map,
            note_hash_map, options, stats, book_titles,
            force_list=force_list,
            extra_renderer=extra_renderer,
        )


# ---------------------------------------------------------------------------
# YAML frontmatter
# ---------------------------------------------------------------------------


def _yaml_escape(value: str) -> str:
    s = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def render_frontmatter(meta: dict[str, Any]) -> str:
    lines = ["---"]
    for key, value in meta.items():
        if value is None or value == "" or value == []:
            continue
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {_yaml_escape(str(item))}")
        elif isinstance(value, bool):
            lines.append(f"{key}: {str(value).lower()}")
        elif isinstance(value, (int, float)):
            lines.append(f"{key}: {value}")
        else:
            lines.append(f"{key}: {_yaml_escape(str(value))}")
    lines.append("---")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# File naming
# ---------------------------------------------------------------------------


# 同时禁掉 Obsidian wikilink 解析时会被截断的字符（# ^ [ ]）。
_FILENAME_BAD = re.compile(r"[\\/:*?\"<>|#\^\[\]]+")


def sanitize_filename(name: str, max_len: int = 80) -> str:
    name = _FILENAME_BAD.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip()
    if len(name) > max_len:
        name = name[:max_len].rstrip()
    return name or "Untitled"


# ---------------------------------------------------------------------------
# Per-notebook export
# ---------------------------------------------------------------------------


@dataclass
class ExportResult:
    topic_id: str
    title: str
    file_path: str
    is_mindmap: bool
    note_count: int
    image_count: int
    # True 表示本次实际写入了文件（内容有变化），False 表示磁盘上已是最新、跳过写入。
    # 用于在 main() 末尾汇总"本次刷新了 X / 总 Y 本"，并控制单本 log 是否打印。
    changed: bool = True


def export_notebook(
    ctx: DBContext,
    topic: sqlite3.Row,
    out_root: str,
    options: RenderOptions,
    parent_titles: list[str] | None = None,
    visited_topics: set[str] | None = None,
) -> list[ExportResult]:
    if visited_topics is None:
        visited_topics = set()
    if topic["ZTOPICID"] in visited_topics:
        return []
    visited_topics.add(topic["ZTOPICID"])

    parent_titles = parent_titles or []
    title = topic["ZTITLE"] or "Untitled"
    is_mindmap = bool(topic["ZMINDLINKS"])

    notes = fetch_notes(ctx, topic["ZTOPICID"])
    if not notes:
        print(f"   · 跳过空笔记本：{title}")
        return []

    media_map, note_hash_map = fetch_media(ctx, notes)

    # 关联书籍
    book_md5_list: list[str] = []
    if topic["ZBOOKLIST"]:
        book_md5_list.extend([m for m in topic["ZBOOKLIST"].split("|") if m])
    note_book_set = {n["ZBOOKMD5"] for n in notes if n["ZBOOKMD5"]}
    for m in note_book_set:
        if m not in book_md5_list:
            book_md5_list.append(m)
    book_infos = fetch_book_titles(ctx, book_md5_list)
    book_titles = [b["title"] for b in book_infos if b["title"]]
    authors = sorted({b["author"] for b in book_infos if b["author"]})

    # 文件路径
    category = "MindMaps" if is_mindmap else "Books"
    out_dir = os.path.join(out_root, category)
    assets_dir = os.path.join(out_root, "assets")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)

    file_stem = " - ".join([sanitize_filename(t) for t in [*parent_titles, title]])
    file_path = os.path.join(out_dir, f"{file_stem}.md")
    counter = 1
    in_run_paths = options.generated_paths
    if in_run_paths is not None:
        # 仅在本次运行内撞名时才加 (1)/(2)；vault 里上次的旧文件不再算占位。
        while file_path in in_run_paths:
            file_path = os.path.join(out_dir, f"{file_stem} ({counter}).md")
            counter += 1
        in_run_paths.add(file_path)

    # 渲染
    roots = build_tree(notes)
    stats = RenderStats()
    body_lines: list[str] = []

    # 启发式判断：如果根节点全是无子节点的叶子（典型于书籍划线），
    # 且数量比较多，就用列表渲染，避免堆出几十个 H2。
    flat_roots = (
        options.flat_roots_as_list
        and len(roots) >= 4
        and all(not r.children for r in roots)
    )

    # 卡片关联 label：本 topic 内 NoteID → 友好 label，跨笔记跳转时能显示对方摘要。
    topic_card_labels: dict[str, str] = {}
    for n in notes:
        nid = n["ZNOTEID"]
        if not nid:
            continue
        title_lbl = clean_text(n["ZNOTETITLE"]).strip()
        if title_lbl:
            topic_card_labels[nid] = title_lbl
            continue
        excerpt_lbl = clean_text(n["ZHIGHLIGHT_TEXT"]).strip()
        if excerpt_lbl:
            topic_card_labels[nid] = excerpt_lbl.splitlines()[0].strip()
    topic_options = dataclasses.replace(options, card_labels=topic_card_labels)

    for root in roots:
        render_node(
            root, 1, body_lines, assets_dir, media_map, note_hash_map,
            topic_options, stats, book_titles,
            force_list=flat_roots,
        )

    # frontmatter + 头部
    created = ns_date_to_iso(topic["ZDATE"])
    last_visit = None
    try:
        last_visit = ns_date_to_iso(topic["ZLASTVISIT"])  # type: ignore[index]
    except Exception:
        pass

    # 标签：用 MarginNote 主页书架打的真实分类（区分性强），叠加用户在批注里写的 hashtag。
    # 不再写入 "MarginNote"/"Book"/"Mindmap" 这种无区分度的来源 tag——frontmatter 里
    # 已经有 doc_type / type 字段标记了。
    tags_set: set[str] = set()
    cat_map = _load_book_categories(ctx)
    for m in book_md5_list:
        for cat in cat_map.get(m, []):
            norm = "/".join(_normalize_tag(seg) for seg in cat.split("/") if seg.strip())
            if norm:
                tags_set.add(norm)
    user_tag_counter: dict[str, int] = {}
    for note in notes:
        if note["ZNOTES_TEXT"]:
            for t in extract_hashtags(note["ZNOTES_TEXT"]):
                if len(t) < 2:  # 跳过单字符标签噪声
                    continue
                if t.isdigit():
                    continue
                user_tag_counter[t] = user_tag_counter.get(t, 0) + 1
    for t in sorted(user_tag_counter, key=lambda k: -user_tag_counter[k])[:30]:
        norm = _normalize_tag(t)
        if norm:
            tags_set.add(norm)

    # `lastNoteUpdate`：取本笔记本所有节点的最大 ZNOTE_DATE / ZHIGHLIGHT_DATE
    # 作为内容指纹的一部分。这样除非 MarginNote 那边真的更新了笔记，
    # frontmatter 不会变 → 文件就不会被覆写 → mtime 保留 → Obsidian 的
    # "最近编辑"列表不会被刷成大批假阳性。
    last_update_ts: float | None = None
    for n in notes:
        for col in ("ZNOTE_DATE", "ZHIGHLIGHT_DATE"):
            ts = n[col] if col in n.keys() else None
            if ts is None:
                continue
            if last_update_ts is None or ts > last_update_ts:
                last_update_ts = ts
    last_update = ns_date_to_iso(last_update_ts) if last_update_ts is not None else None

    frontmatter = render_frontmatter({
        "doc_type": "marginnote-export",
        "topicId": topic["ZTOPICID"],
        "title": title,
        "type": "mindmap" if is_mindmap else "book",
        "books": book_titles,
        "authors": authors,
        "noteCount": stats.note_count,
        "imageCount": stats.image_count,
        "created": created,
        "lastVisit": last_visit,
        "lastNoteUpdate": last_update,
        "tags": sorted(tags_set),
        "source": ctx.app_name,
    })

    abstract_lines = ["", f"# {title}", ""]
    callout = ["> [!info]+ 笔记本元信息"]
    callout.append(f"> - 类型：{'🧠 思维导图' if is_mindmap else '📖 书籍'}")
    if book_titles:
        callout.append(f"> - 关联书籍：{ '、'.join('《' + t + '》' for t in book_titles) }")
    if authors:
        callout.append(f"> - 作者：{ '、'.join(authors) }")
    if created:
        callout.append(f"> - 创建：{created}")
    if last_visit:
        callout.append(f"> - 最近访问：{last_visit}")
    callout.append(f"> - 笔记数：{stats.note_count}（图片 {stats.image_count}）")
    if stats.skipped_ai:
        callout.append(f"> - 已过滤 AI 上下文 / 对话节点 {stats.skipped_ai} 个")
    callout.append(f"> - MarginNote 链接：[在 {ctx.app_name} 中打开]"
                    f"({options.url_scheme}://notebook/{topic['ZTOPICID']})")
    abstract_lines.extend(callout)
    abstract_lines.append("")
    abstract_lines.append("## 📝 笔记内容")
    abstract_lines.append("")

    final = frontmatter + "\n" + "\n".join(abstract_lines + body_lines).rstrip() + "\n"
    changed = _write_if_changed(file_path, final)

    if changed:
        print(f"   ✏️  {title} → {file_path}（{stats.note_count} 条笔记 / {stats.image_count} 张图）")

    results = [ExportResult(
        topic_id=topic["ZTOPICID"],
        title=title,
        file_path=file_path,
        is_mindmap=is_mindmap,
        note_count=stats.note_count,
        image_count=stats.image_count,
        changed=changed,
    )]

    # 递归子思维导图（Books-only 模式下跳过）
    if not options.recurse_child_maps:
        return results
    cursor = ctx.conn.cursor()
    child_topic_ids: list[tuple[str, str]] = []
    for n in notes:
        cmid = n["ZCHILDMAPNOTEID"]
        if not cmid:
            continue
        # cmid 实际是 ZNOTEID 还是 ZTOPICID，存在两种情况，按 ZTOPIC 查最稳妥
        cursor.execute("SELECT ZTOPICID, ZTITLE, ZMINDLINKS, ZBOOKLIST, ZDATE FROM ZTOPIC WHERE ZTOPICID = ?", (cmid,))
        row = cursor.fetchone()
        if row:
            child_topic_ids.append((row, n["ZNOTETITLE"] or "Untitled"))  # type: ignore[arg-type]

    new_parents = [*parent_titles, title]
    for child_topic, child_title in child_topic_ids:
        try:
            sub = export_notebook(
                ctx, child_topic, out_root, options,
                parent_titles=new_parents, visited_topics=visited_topics,
            )
            results.extend(sub)
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️ 子思维导图 {child_title} 导出失败: {exc}")

    return results


# ---------------------------------------------------------------------------
# Per-book export (跨 Topic 聚合，按 ZBOOKMD5)
# ---------------------------------------------------------------------------


_MNDOC_PATH_PREFIX = "$$$MNDOCLINK$$$"
_CATEGORY_PREFIX = re.compile(r"^\$\$\$CATEGORY\d+\$\$\$")


def _clean_category_name(raw: str | None) -> str:
    """剥掉 ZBOOKTAG.ZTAGNAME 的 `$$$CATEGORY1$$$` 之类前缀。"""
    if not raw:
        return ""
    return _CATEGORY_PREFIX.sub("", raw).strip()


def _normalize_tag(name: str) -> str:
    """把分类名转成 Obsidian-friendly tag：
       - 空白替换为 `-`（Obsidian tag 不允许空格）
       - 去掉 `#`/`,` 这种会破坏 yaml 的字符
       - 其它字符（中文、字母、数字、`&`、`+`、`/` 等）尽量保留，由 yaml 引号兜底。
    """
    s = (name or "").strip()
    if not s:
        return ""
    # 一些常见会让 Obsidian #tag 解析挂掉的字符替换为 `-`
    s = re.sub(r"[\s\u3000]+", "-", s)
    s = s.replace("#", "").replace(",", "")
    return s.strip("-")


def _load_book_categories(ctx: DBContext) -> dict[str, list[str]]:
    """读取 MarginNote 主页书架的"分类（Tag）"信息，返回 {ZBOOKMD5LONG: [tag路径,...]}。

    数据流：
      1. ZBOOKTAG 定义了树状的分类层级，自身 ZTAGID + ZTAGLINKS（"|" 拼的子 ID 列表）。
         ZTAGLINKS 里的 ID 既可能是子 tag 的 ZTAGID，也可能是 ZBOOK.ZMD5LONG。
      2. ZBOOKCONFIG.ZTAGLIST 给出每本书归属的 tag id 列表（"|" 分隔的 ZTAGID）。
         注意 ZBOOKCONFIG.ZMD5LONG 和 ZBOOK.ZMD5LONG 对得上。
    我们把每个 tag 的路径还原成 "祖先/父/自己" 的形式（嵌套 tag 在 Obsidian 中
    可同时被搜索 #祖先 / #祖先/父 / #祖先/父/自己 三种）。
    """
    cur = ctx.conn.cursor()
    cur.execute("SELECT ZTAGID, ZTAGNAME, ZTAGLINKS FROM ZBOOKTAG")
    rows = cur.fetchall()
    name_of: dict[str, str] = {}
    parent_of: dict[str, str] = {}
    for r in rows:
        tid = r["ZTAGID"]
        if not tid:
            continue
        name_of[tid] = _clean_category_name(r["ZTAGNAME"])
    for r in rows:
        tid = r["ZTAGID"]
        if not tid or not r["ZTAGLINKS"]:
            continue
        for child in r["ZTAGLINKS"].split("|"):
            if child in name_of:
                parent_of.setdefault(child, tid)

    def path_of(tid: str) -> str:
        chain: list[str] = []
        seen: set[str] = set()
        cur_id: str | None = tid
        while cur_id and cur_id in name_of and cur_id not in seen:
            seen.add(cur_id)
            chain.append(name_of[cur_id])
            cur_id = parent_of.get(cur_id)
        return "/".join(reversed(chain))

    cur.execute(
        "SELECT ZMD5LONG, ZTAGLIST FROM ZBOOKCONFIG "
        "WHERE ZMD5LONG IS NOT NULL AND ZTAGLIST IS NOT NULL AND ZTAGLIST != ''"
    )
    out: dict[str, list[str]] = {}
    for r in cur.fetchall():
        md5 = r["ZMD5LONG"]
        paths: list[str] = []
        for tid in r["ZTAGLIST"].split("|"):
            tid = tid.strip()
            if not tid or tid not in name_of:
                continue
            p = path_of(tid)
            if p and p not in paths:
                paths.append(p)
        if paths:
            out[md5] = paths
    return out


def _parse_book_folder(zpath: str | None) -> str:
    """把 ZBOOK.ZPATH 解析成相对的"书架目录"。

    ZPATH 格式形如：
        $$$MNDOCLINK$$$iCloud.QReader.MarginStudy.easy           → 根（书架首页）
        $$$MNDOCLINK$$$iCloud.QReader.MarginStudy.easy/MNDocs    → MNDocs/
        $$$MNDOCLINK$$$iCloud.QReader.MarginStudy.easy/MNDocs/WebClipper
        MN4Sample                                                → MN4Sample/
        .$$ImportedPages$$                                       → .$$ImportedPages$$/
        ""/None                                                  → 根

    返回值是 OS 相对路径（用 "/" 拼，由调用方再 sanitize 各段）。
    """
    if not zpath:
        return ""
    p = zpath
    if p.startswith(_MNDOC_PATH_PREFIX):
        p = p[len(_MNDOC_PATH_PREFIX):]
        # 第一段一般是容器名（iCloud.QReader.MarginStudy.xxx），跳过。
        parts = p.split("/", 1)
        sub = parts[1] if len(parts) > 1 else ""
        return sub.strip("/")
    return p.strip("/")


def list_books(ctx: DBContext) -> list[dict]:
    """列出所有"被笔记引用过"的书：以 ZBOOKNOTE.ZBOOKMD5 为准，
    再到 ZBOOK 里反查标题/作者；ZBOOK 中找不到的（旧数据 / 已删除）
    用 Topic 标题兜底。"""
    cursor = ctx.conn.cursor()
    cursor.execute("""
        SELECT bn.ZBOOKMD5 AS md5, COUNT(*) AS note_count
        FROM ZBOOKNOTE bn
        WHERE bn.ZBOOKMD5 IS NOT NULL
        GROUP BY bn.ZBOOKMD5
    """)
    rows = cursor.fetchall()

    md5_meta: dict[str, dict] = {}
    for r in rows:
        md5_meta[r["md5"]] = {
            "md5": r["md5"],
            "md5_list": [r["md5"]],  # 单 md5 时长度 1；fallback 同名书合并后会变长
            "note_count": r["note_count"],
            "title": None,
            "author": None,
            "folder": "",
            "categories": [],  # MarginNote 主页"我的书架"中给该书打的分类路径
        }

    # 加载分类映射（一次扫描全表，O(n)）
    book_categories = _load_book_categories(ctx)
    for md5, cats in book_categories.items():
        if md5 in md5_meta:
            md5_meta[md5]["categories"] = cats

    md5_list = list(md5_meta.keys())
    if md5_list:
        for i in range(0, len(md5_list), 500):
            batch = md5_list[i : i + 500]
            placeholders = ",".join("?" * len(batch))
            cursor.execute(
                f"SELECT ZMD5, ZMD5LONG, ZAUTHOR, ZFILE, ZPATH FROM ZBOOK "
                f"WHERE ZMD5LONG IN ({placeholders}) OR ZMD5 IN ({placeholders})",
                batch + batch,
            )
            for row in cursor.fetchall():
                key = row["ZMD5LONG"] if row["ZMD5LONG"] in md5_meta else row["ZMD5"]
                if key not in md5_meta:
                    continue
                title = (row["ZFILE"] or "").strip()
                title = re.sub(r"\.(pdf|epub|mobi|txt|docx?|mp4|pptx?|html?)$", "",
                               title, flags=re.I)
                md5_meta[key]["title"] = title or None
                md5_meta[key]["author"] = (row["ZAUTHOR"] or "").strip() or None
                md5_meta[key]["folder"] = _parse_book_folder(row["ZPATH"])

    # 对没有 ZBOOK 记录的，用其在 Topic 中最常出现的 Topic 标题作为标题兜底；
    # 同时记录"是否兜底"，后面用来判断要不要追加 md5 短码避免重名。
    for md5, meta in md5_meta.items():
        if meta["title"]:
            meta["fallback"] = False
            continue
        cursor.execute(
            """
            SELECT t.ZTITLE, COUNT(*) AS n
            FROM ZBOOKNOTE bn JOIN ZTOPIC t ON t.ZTOPICID = bn.ZTOPICID
            WHERE bn.ZBOOKMD5 = ?
            GROUP BY t.ZTITLE ORDER BY n DESC LIMIT 1
            """,
            (md5,),
        )
        row = cursor.fetchone()
        if row and row["ZTITLE"]:
            meta["title"] = row["ZTITLE"]
        else:
            meta["title"] = "未知书籍"
        meta["fallback"] = True

    # 同名兜底书（ZBOOK 表无记录、靠 Topic 标题取名）合并到同一份 markdown。
    # 包括两类：
    #   (a) 多本 fallback 命中同一标题（例如 5 本都叫 "C++语言"，因为它们 ZBOOKMD5
    #       不在 ZBOOK 中、又同属一个 Topic），合并；
    #   (b) "未知书籍"——任何无 Topic 标题兜底的，统一聚成一条。
    # 不再给文件名加 md5 短码，而是把所有相关 ZBOOKMD5 都汇总到 md5_list 里，
    # 后续 export_book 用 IN(...) 一次性查询，输出一份合并后的 markdown。
    title_counts: dict[str, int] = {}
    for meta in md5_meta.values():
        if meta.get("fallback"):
            title_counts[meta["title"]] = title_counts.get(meta["title"], 0) + 1

    merge_buckets: dict[str, dict] = {}
    final_metas: list[dict] = []
    for meta in md5_meta.values():
        title = meta["title"]
        is_fb = meta.get("fallback", False)
        # 命中合并条件：同名兜底 ≥2 份，或标题就是 "未知书籍"。
        should_merge = is_fb and (title_counts.get(title, 0) > 1 or title == "未知书籍")
        if not should_merge:
            final_metas.append(meta)
            continue
        bucket = merge_buckets.get(title)
        if bucket is None:
            bucket = dict(meta)
            bucket["md5_list"] = list(meta["md5_list"])
            bucket["categories"] = list(meta.get("categories") or [])
            merge_buckets[title] = bucket
            final_metas.append(bucket)
        else:
            for m in meta["md5_list"]:
                if m not in bucket["md5_list"]:
                    bucket["md5_list"].append(m)
            bucket["note_count"] += meta["note_count"]
            for c in (meta.get("categories") or []):
                if c not in bucket["categories"]:
                    bucket["categories"].append(c)
            # folder 保留最频繁的：先简单地"非空 > 空"
            if not bucket.get("folder") and meta.get("folder"):
                bucket["folder"] = meta["folder"]
            if not bucket.get("author") and meta.get("author"):
                bucket["author"] = meta["author"]

    return sorted(final_metas, key=lambda x: -x["note_count"])


def _normalize_excerpt(text: str | None) -> str:
    if not text:
        return ""
    return "".join(ch for ch in text if ch.isalnum())[:200]


# 把评论里裸 marginnote URL 自动包装成 markdown link，避免 Obsidian 不识别。
# 注：MarginNote 4 中的"卡片关联"功能会把目标 NoteID 直接写到 ZNOTES_TEXT
# 里（形如 "marginnote4app://note/<id>"）。此前我们简单地把它包成 [url](url)
# 这种自指 markdown 链接，导出后既丑又没信息量，所以现在改成专门拆分处理：
# 在 _split_card_links 里把这些 NoteID 抽出来，剩下的正文照常作 callout，
# 关联另起一行渲染为 "🔗 关联：[卡片标题/摘录前缀](marginnote4app://...)"。
_BARE_MN_URL_RE = re.compile(r"(?<!\]\()(?<![\w])(marginnote[34]app://[^\s)]+)")
_CARD_LINK_RE = re.compile(r"marginnote[34]app://note/([A-Fa-f0-9-]+)")


def _wrap_mn_urls(text: str) -> str:
    """把残留在文本里的裸 marginnote:// URL 包成可点击 markdown 链接。
    label 用 `🔗 卡片` 而不是 URL 自指——这样阅读体验好一些。"""
    if not text:
        return text
    return _BARE_MN_URL_RE.sub(lambda m: f"[🔗 卡片]({m.group(1)})", text)


def _split_card_links(text: str) -> tuple[str, list[str]]:
    """从 ZNOTES_TEXT 中分离出"卡片关联跳转"链接（marginnote4app://note/<id>）。

    返回 (剩余正文, [note_id, ...] 按出现顺序去重)。
    用于把光秃秃的卡片关联从批注里剥离，单独渲染成"🔗 关联：…"。
    """
    if not text:
        return text, []
    ids: list[str] = []
    seen: set[str] = set()

    def _collect(m: re.Match) -> str:
        nid = m.group(1)
        if nid not in seen:
            seen.add(nid)
            ids.append(nid)
        return ""

    cleaned = _CARD_LINK_RE.sub(_collect, text)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, ids


def _key_for_book_note(r: sqlite3.Row) -> tuple:
    """跨 topic 去重时的"同一段摘录"识别 key。
    没定位信息的"组织/导航节点"用 ZNOTEID 唯一化。"""
    excerpt_norm = _normalize_excerpt(r["ZHIGHLIGHT_TEXT"])
    pos = r["ZSTARTPOS"] or ""
    page = r["ZSTARTPAGE"] or 0
    if excerpt_norm or pos:
        return (page, pos, excerpt_norm)
    return ("__solo__", r["ZNOTEID"])


def _filter_tree_to_book(
    nodes: list[TreeNode],
    md5_set: set[str],
) -> list[TreeNode]:
    """递归过滤：保留所有 ZBOOKMD5∈md5_set 的节点，以及它们的祖先。
    不属于本书但本身是必要"分组节点"（其后代里有本书笔记）的也保留。"""
    kept: list[TreeNode] = []
    for tn in nodes:
        new_children = _filter_tree_to_book(tn.children, md5_set)
        own = tn.note["ZBOOKMD5"] in md5_set
        if own or new_children:
            tn.children = new_children
            kept.append(tn)
    return kept


def _walk_tree(nodes: list[TreeNode]):
    for tn in nodes:
        yield tn
        yield from _walk_tree(tn.children)


# ---------------------------------------------------------------------------
# Weread 风格的段落渲染（仅用于 --by-book）
# ---------------------------------------------------------------------------
# 设计目标：跟 obsidian-weread-plugin 的 markdown 输出保持一致的可视化结构，
# 让用户在同一个 Obsidian vault 里翻 weread 笔记和 MarginNote 笔记时拥有一致的
# 阅读体验。weread 的关键特征：
#   - 顶部 `# 元数据` + `> [!abstract] <书名>` callout
#   - 主体 `# 高亮划线`，按章节 `## H2` / `### H3` 分组，每条原文是独立的 quote
#     段落 `>  text ` —— 段落之间空一行
#   - 末尾 `# 读书笔记`，把有评论的笔记单列一份，附带 `^block-id` Obsidian 块引用
#
# 这些 helper 与 list 风格的 `_emit_excerpt` 等并存，--by-book 模式下专走这条路；
# 按 Topic / mindmap 模式仍然用旧的 list 渲染，保留树状层级密度。


def _short_block_id(note_id: str) -> str:
    """Obsidian 块引用 ID 必须是字母数字、连字符或下划线。
    ZNOTEID 是 UUID，去掉 `-` 后取前 12 位足够唯一，又便于阅读。"""
    return (note_id or "").replace("-", "")[:12].lower() or "note"


def _emit_quote_para(
    text: str,
    lines: list[str],
    *,
    block_id: str | None = None,
    trailing_link: str | None = None,
) -> None:
    """weread 风格：一段原文渲染为独立 quote 段落，前 `>  ` 双空格、行尾空格保
    留软换行的视觉密度。

    关于 `^block-id`：Obsidian 的块引用锚点必须在行的最末尾才会被识别 + 隐藏，
    一旦后面再跟其他文字（比如我们的 [p.X](url) backlink），它就成了普通字符
    串显式渲染出来，又丑又没用。所以策略是：
      - `# 高亮划线` 段不带 ^id（这一段每条原文都附 `[p.X](url)` backlink），
        与 obsidian-weread-plugin 的实际格式一致；
      - `# 读书笔记` 段每条评论最末尾才带 ^id 让 Obsidian 把它作为锚点隐藏。
    """
    raw_lines = [r for r in text.splitlines() if r.strip()]
    if not raw_lines:
        return
    n = len(raw_lines)
    for i, raw in enumerate(raw_lines):
        out = escape_markdown_header(raw)
        is_last = (i == n - 1)
        suffix_parts: list[str] = []
        if is_last and trailing_link:
            suffix_parts.append(trailing_link)
        if is_last and block_id and not trailing_link:
            # 只有当不带 trailing_link 时才把 ^id 放在行尾——否则 Obsidian
            # 不会把它解析成块锚点。
            suffix_parts.append(f"^{block_id}")
        suffix = ("  " + "  ".join(suffix_parts)) if suffix_parts else " "
        lines.append(f">  {out}{suffix}")
    lines.append("")


def _emit_image_para(
    note_id: str,
    image_data: bytes,
    images_dir: str,
    options: RenderOptions,
    lines: list[str],
    *,
    trailing_link: str | None = None,
) -> bool:
    image_filename = f"{note_id}.png"
    image_path = os.path.join(images_dir, image_filename)
    if not os.path.exists(image_path):
        with open(image_path, "wb") as f:
            f.write(image_data)
    rel = f"{options.image_dir_relative}/{image_filename}"
    alt = f"|{options.image_width}" if options.image_width and options.image_width > 0 else ""
    lines.append(f"![{alt}]({rel})")
    if trailing_link:
        lines.append(trailing_link)
    lines.append("")
    return True


def _strip_paragraphs_in_set(text: str, excerpt_norms: set[str] | None) -> str:
    """从 `text`（批注）里剥掉那些与本书内某条独立划线 excerpt 一字不差的段落。

    规则：
    - 段落分割：先按双空行（``\\n\\s*\\n``）拆，再按单换行兜底拆短段。
    - 归一化：仅折叠空白做比较（不归一化标点 / 中英文差异）。
    - 长度护栏：段落长度 < 12 字符不参与匹配，避免短句误伤（如 "嗯"、"对"）。
    - 至少要剥掉一段才返回新文本；若没有段落命中，原样返回，避免把"我的批注"
      正常段落里的换行变形。

    返回剥后剩余的批注文本（可能为 ""）。
    """
    if not text or not excerpt_norms:
        return text
    paras = re.split(r"\n\s*\n", text)
    kept: list[str] = []
    changed = False
    for p in paras:
        ps = p.strip()
        if not ps:
            kept.append(p)
            continue
        norm = re.sub(r"\s+", "", ps)
        if len(norm) >= 12 and norm in excerpt_norms:
            changed = True
            continue
        kept.append(p)
    if not changed:
        return text
    return "\n\n".join(kept).strip()


def _comment_equals_excerpt(comment: str, excerpt: str) -> bool:
    """判定批注内容是否和原文摘录完全相同（仅折叠空白做比较）。

    背景：MarginNote 用户有时会把整段原文复制粘贴到批注栏当作"标记 / 收藏"
    操作，导出到 weread 风格时这就让 `> 划线 quote` 和紧跟着的
    `> [!note]+ 💭 我的批注` callout 显示**同一段文字两次**——视觉上冗余。
    用此函数判定后，调用方应把 comment 清空，跳过 callout，仅保留划线段。

    判定口径：折叠所有空白后逐字符相等。不做更激进的归一化（中文逗号 vs
    顿号等差异要保留差异 → 视为不同的批注）。
    """
    if not comment or not excerpt:
        return False
    return re.sub(r"\s+", "", comment) == re.sub(r"\s+", "", excerpt)


def _emit_comment_para(
    comment: str,
    lines: list[str],
    *,
    trailing_link: str | None = None,
) -> None:
    """评论作为 callout 段落（`[!note]+ 💭 我的批注`），便于和上方原文 quote 区分。"""
    if not comment.strip():
        return
    comment = _wrap_mn_urls(comment)
    parts = comment.splitlines()
    lines.append("> [!note]+ 💭 我的批注")
    n = len(parts)
    for i, raw in enumerate(parts):
        out = escape_markdown_header(raw) if raw.strip() else ""
        suffix = f"  {trailing_link}" if (trailing_link and i == n - 1) else ""
        lines.append(f"> {out}{suffix}")
    lines.append("")


def _emit_card_links_para(
    card_ids: list[str],
    options: RenderOptions,
    lines: list[str],
    *,
    self_id: str | None = None,
    trailing_link: str | None = None,
) -> None:
    rendered: list[str] = []
    labels = options.card_labels or {}
    for cid in card_ids:
        if self_id and cid == self_id:
            continue
        url = f"{options.url_scheme}://note/{cid}"
        raw_label = labels.get(cid, "")
        label = (raw_label or "").strip()
        if label:
            label = re.sub(r"[\[\]|]", " ", label)
            label = re.sub(r"\s+", " ", label).strip()
            if len(label) > 50:
                label = label[:50] + "…"
            label = f"🔗 关联：{label}"
        else:
            label = "🔗 关联卡片"
        rendered.append(f"[{label}]({url})")
    if not rendered:
        return
    if trailing_link:
        rendered[-1] += f"  {trailing_link}"
    for r in rendered:
        lines.append(r)
    lines.append("")


def _emit_extras_para(
    node: "TreeNode",
    extra_per_node: dict,
    options: RenderOptions,
    lines: list[str],
) -> None:
    """跨 topic 的"来自《X》的批注"，weread 风格段落版。"""
    nid = node.note["ZNOTEID"]
    for ttitle, raw in extra_per_node.get(nid, []):
        cleaned = clean_text(raw)
        cleaned, _ = _split_tags_from_comment(cleaned)
        cleaned, card_ids = _split_card_links(cleaned)
        cleaned = cleaned.strip()
        if not cleaned and not card_ids:
            continue
        if cleaned:
            cleaned = _wrap_mn_urls(cleaned)
            lines.append(f"> [!quote]- 💬 来自《{ttitle}》的批注")
            for ln in cleaned.splitlines():
                lines.append(f"> {ln}" if ln.strip() else "> ")
            lines.append("")
        if card_ids:
            _emit_card_links_para(card_ids, options, lines, self_id=nid)


@dataclass
class _ReviewItem:
    """`# 读书笔记` 段里的一条记录。"""
    note_id: str
    chapter: str
    excerpt: str
    comment: str
    page: int | None
    block_id: str


def _render_book_node_weread(
    node: TreeNode,
    level: int,
    lines: list[str],
    images_dir: str,
    media_map: dict,
    note_hash_map: dict,
    options: RenderOptions,
    stats: RenderStats,
    reviews: list[_ReviewItem],
    extra_per_node: dict,
    *,
    chapter_stack: list[str] | None = None,
) -> None:
    """weread 风格：把 mindmap 节点递归渲染成"H 标题 + 段落式 quote 块"。

    - level 1 → H2，level 2 → H3 … 最深 H6
    - 节点有 ZNOTETITLE 或被识别为"分组节点"（excerpt 第一行作为章节标题）时，
      给出 H 标题；其余纯叶子节点直接以 quote 段落呈现。
    - 有评论的节点会被收集进 reviews，最终在 `# 读书笔记` 段重新展开。
    """
    if chapter_stack is None:
        chapter_stack = []

    note = node.note
    is_ai_answer = is_ai_answer_node(note)
    if is_ai_answer and not options.keep_ai_nodes:
        for child in node.children:
            _render_book_node_weread(
                child, level, lines, images_dir, media_map, note_hash_map,
                options, stats, reviews, extra_per_node,
                chapter_stack=chapter_stack,
            )
        stats.skipped_ai += 1
        return

    title = clean_text(note["ZNOTETITLE"])
    excerpt = clean_text(note["ZHIGHLIGHT_TEXT"])
    raw_comment = note["ZNOTES_TEXT"] or ""
    comment = clean_text(raw_comment)
    comment, _tags = _split_tags_from_comment(comment)
    comment, card_link_ids = _split_card_links(comment)
    page = note["ZSTARTPAGE"] or None

    image_data = _resolve_note_image(note, media_map, note_hash_map)
    title_to_show, excerpt_to_show = _resolve_dedup(title, excerpt)
    # A. 跳过和本节点原文一字不差的"伪批注"：用户在 MarginNote 里把整段原文
    #    复制到批注框做"标记"动作，会让 `> 划线 quote` 和 `[!note]+ 💭 我的批注`
    #    callout 显示同一段文字。
    if comment and _comment_equals_excerpt(comment, excerpt_to_show):
        comment = ""
    # B. 跨 note 去重：把批注里和本书其它划线一字不差的段落从 callout 中剥
    #    掉。原则是"原文是基础，批注是附加，重复时删批注、保留划线 quote"。
    if comment:
        comment = _strip_paragraphs_in_set(comment, options.excerpt_norms_in_book)
    has_body = (
        bool(excerpt_to_show) or bool(comment) or bool(image_data) or bool(card_link_ids)
    )

    has_children = bool(node.children)
    head_text: str | None = None
    if title_to_show:
        head_text = title_to_show.strip()
    elif has_children and excerpt_to_show:
        ex_lines = [l for l in excerpt_to_show.splitlines() if l.strip()]
        if ex_lines:
            head_text = ex_lines[0].strip()
            excerpt_to_show = "\n".join(ex_lines[1:]).strip()

    if head_text:
        head_text = escape_markdown_header(head_text)
        if is_ai_answer:
            head_text = f"🤖 {head_text}"

    backlink = _backlink(note["ZNOTEID"], page, options.url_scheme)
    block_id = _short_block_id(note["ZNOTEID"])

    if not (head_text or has_body):
        stats.skipped_empty += 1
        # 空容器：仍然递归子节点
        for child in node.children:
            _render_book_node_weread(
                child, level, lines, images_dir, media_map, note_hash_map,
                options, stats, reviews, extra_per_node,
                chapter_stack=chapter_stack,
            )
        return

    new_chapter_stack = chapter_stack
    if head_text:
        h_level = max(2, min(level + 1, 6))
        lines.append(f"{'#' * h_level} {head_text}  {backlink}")
        lines.append("")
        # 进入新章节：H2 / H3 都进入栈，便于评论段标注归属
        new_chapter_stack = chapter_stack + [head_text] if h_level <= 3 else chapter_stack

    # 段落主体：原文 → 图 → 我的批注 → 卡片关联 → 跨 topic 批注
    # 不带 head_text 的纯叶子节点把 backlink + ^block-id 附在段落最末。
    has_no_head_body = (not head_text) and has_body
    last_slot: str | None = None
    if has_no_head_body:
        if card_link_ids:
            last_slot = "cardlinks"
        elif comment:
            last_slot = "comment"
        elif image_data:
            last_slot = "image"
        elif excerpt_to_show:
            last_slot = "excerpt"

    if excerpt_to_show:
        _emit_quote_para(
            excerpt_to_show, lines,
            trailing_link=backlink if (has_no_head_body and last_slot == "excerpt") else None,
        )
    if image_data:
        _emit_image_para(
            note["ZNOTEID"], image_data, images_dir, options, lines,
            trailing_link=backlink if (has_no_head_body and last_slot == "image") else None,
        )
        stats.image_count += 1
    if comment:
        _emit_comment_para(
            comment, lines,
            trailing_link=backlink if (has_no_head_body and last_slot == "comment") else None,
        )
    if card_link_ids:
        _emit_card_links_para(
            card_link_ids, options, lines,
            self_id=note["ZNOTEID"],
            trailing_link=backlink if (has_no_head_body and last_slot == "cardlinks") else None,
        )

    _emit_extras_para(node, extra_per_node, options, lines)

    if has_body:
        stats.note_count += 1

    # 收集到 # 读书笔记 段：所有有 comment 的笔记都进入
    if comment.strip():
        reviews.append(_ReviewItem(
            note_id=note["ZNOTEID"],
            chapter=" / ".join(new_chapter_stack) if new_chapter_stack else "（未归章）",
            excerpt=excerpt_to_show or (head_text or ""),
            comment=comment,
            page=page,
            block_id=block_id,
        ))

    for child in node.children:
        _render_book_node_weread(
            child, level + 1, lines, images_dir, media_map, note_hash_map,
            options, stats, reviews, extra_per_node,
            chapter_stack=new_chapter_stack,
        )


def _render_flat_book_note_weread(
    n: sqlite3.Row,
    lines: list[str],
    images_dir: str,
    image_cache: dict[str, bytes],
    options: RenderOptions,
    reviews: list[_ReviewItem],
    *,
    chapter: str = "（未归章）",
) -> None:
    """整本书没有 mindmap 层级时（典型为只划线的 PDF），按页码扁平展开。
    weread 风格：每条原文 quote 段独立成段。"""
    title_text = clean_text(n["ZNOTETITLE"])
    excerpt = clean_text(n["ZHIGHLIGHT_TEXT"])
    comment, _ = _split_tags_from_comment(clean_text(n["ZNOTES_TEXT"] or ""))
    comment, card_link_ids = _split_card_links(comment)
    title_to_show, excerpt_to_show = _resolve_dedup(title_text, excerpt)
    # A. 跳过批注 == 原文 的冗余批注。
    if comment and _comment_equals_excerpt(comment, excerpt_to_show):
        comment = ""
    # B. 把批注里和本书其它划线一字不差的段落从 callout 中剥掉，保留划线优先。
    if comment:
        comment = _strip_paragraphs_in_set(comment, options.excerpt_norms_in_book)
    page = n["ZSTARTPAGE"] or None
    backlink = _backlink(n["ZNOTEID"], page, options.url_scheme)
    block_id = _short_block_id(n["ZNOTEID"])
    image_data = image_cache.get(n["ZNOTEID"])

    has_body = bool(excerpt_to_show) or bool(comment) or bool(image_data) or bool(card_link_ids)
    if not (title_text or has_body):
        return

    if title_to_show:
        # 用户归纳的标题 → 加粗段落（不抢章节级 H 资源）
        lines.append(f"**{escape_markdown_header(title_to_show)}**  {backlink}")
        lines.append("")
        if excerpt_to_show:
            _emit_quote_para(excerpt_to_show, lines)
        if image_data:
            _emit_image_para(n["ZNOTEID"], image_data, images_dir, options, lines)
        if comment:
            _emit_comment_para(comment, lines)
        if card_link_ids:
            _emit_card_links_para(card_link_ids, options, lines, self_id=n["ZNOTEID"])
    else:
        # 决定 backlink 附在哪一段尾巴
        slots: list[str] = []
        if excerpt_to_show: slots.append("excerpt")
        if image_data: slots.append("image")
        if comment: slots.append("comment")
        if card_link_ids: slots.append("cardlinks")
        last = slots[-1] if slots else None
        if excerpt_to_show:
            _emit_quote_para(
                excerpt_to_show, lines,
                trailing_link=backlink if last == "excerpt" else None,
            )
        if image_data:
            _emit_image_para(
                n["ZNOTEID"], image_data, images_dir, options, lines,
                trailing_link=backlink if last == "image" else None,
            )
        if comment:
            _emit_comment_para(
                comment, lines,
                trailing_link=backlink if last == "comment" else None,
            )
        if card_link_ids:
            _emit_card_links_para(
                card_link_ids, options, lines,
                self_id=n["ZNOTEID"],
                trailing_link=backlink if last == "cardlinks" else None,
            )

    if comment.strip():
        reviews.append(_ReviewItem(
            note_id=n["ZNOTEID"],
            chapter=chapter,
            excerpt=excerpt_to_show or (title_text or ""),
            comment=comment,
            page=page,
            block_id=block_id,
        ))


def _render_review_section(
    reviews: list[_ReviewItem],
    options: RenderOptions,
    note_dates: dict[str, str] | None = None,
) -> list[str]:
    """weread 的 `# 读书笔记` 段：按章节分组，每条 `> 📌 原文 ^block-id` +
    缩进的 `- 💭 评论` / `- ⏱ 时间` / `- 📄 [p.X](url)`。"""
    if not reviews:
        return []
    note_dates = note_dates or {}
    by_chapter: dict[str, list[_ReviewItem]] = {}
    chapter_order: list[str] = []
    for r in reviews:
        if r.chapter not in by_chapter:
            chapter_order.append(r.chapter)
            by_chapter[r.chapter] = []
        by_chapter[r.chapter].append(r)

    out: list[str] = []
    # 只有一个 fallback 章节时不输出 H2，避免 `## （未归章）` 这种没信息量的标题
    skip_h2 = (len(chapter_order) == 1 and chapter_order[0] == "（未归章）")
    for ch in chapter_order:
        if not skip_h2:
            top = ch.split(" / ")[0] if ch else "（未归章）"
            out.append(f"## {top}")
            out.append("")
        out.append("### 划线评论")
        for r in by_chapter[ch]:
            excerpt_inline = re.sub(r"\s+", " ", r.excerpt).strip()
            if not excerpt_inline:
                # 没有原文摘录的批注（罕见，多半是 MarginNote 自动汇总节点）
                # 用截断后的批注前缀代替，避免出现"(无原文)"这种占位
                excerpt_inline = re.sub(r"\s+", " ", r.comment).strip()
            excerpt_inline = excerpt_inline or "(仅批注)"
            if len(excerpt_inline) > 200:
                excerpt_inline = excerpt_inline[:200] + "…"
            out.append(f"> 📌 {excerpt_inline}  ^{r.block_id}")
            comment_inline = r.comment.replace("\n", " ").strip()
            out.append(f"    - 💭 {comment_inline}")
            ts = note_dates.get(r.note_id, "")
            if ts:
                out.append(f"    - ⏱ {ts}")
            url = f"{options.url_scheme}://note/{r.note_id}"
            label = f"p.{r.page}" if r.page else ">>"
            out.append(f"    - 📄 [{label}]({url})")
            out.append("")
    return out


def export_book(
    ctx: DBContext,
    book_meta: dict,
    out_root: str,
    options: RenderOptions,
) -> ExportResult | None:
    """把一本书在所有 Topic 中产生的笔记聚合到一份 markdown，并尽量保留 mindmap 层级。

    输出 weread-plugin 风格：frontmatter（doc_type=marginnote-highlights-reviews）
    + `# 元数据` callout + `# 高亮划线`（按章节分组的 quote 段落） + `# 读书笔记`
    （评论汇总 + Obsidian 块引用），便于和 obsidian-weread-plugin 的笔记并排阅读。

    策略：
      1. 把所有 ZBOOKMD5=md5 的笔记按 Topic 分组；
      2. 选"主 Topic"（含层级父节点最多 / 笔记最多）的那个；
      3. 拉主 Topic 的全量笔记 + build_tree 取层级，再裁剪到只含本书的子树；
      4. 其它 Topic 中：能在主结构里匹配到同一段摘录的，把额外批注合并到对应节点；
         主结构里没有的，按页码扁平追加到末尾"补充"区。
    """
    md5_list: list[str] = list(book_meta.get("md5_list") or [book_meta["md5"]])
    md5_set: set[str] = set(md5_list)
    title = book_meta["title"]
    author = book_meta.get("author")

    cursor = ctx.conn.cursor()
    placeholders = ",".join("?" * len(md5_list))
    cursor.execute(
        f"""
        SELECT
            bn.ZNOTEID, bn.ZNOTETITLE, bn.ZHIGHLIGHT_TEXT, bn.ZNOTES_TEXT,
            bn.ZHIGHLIGHT_PIC, bn.ZTYPE, bn.ZSTARTPAGE, bn.ZSTARTPOS,
            bn.ZTOPICID, bn.ZBOOKMD5, bn.ZMINDLINKS,
            bn.ZHIGHLIGHT_DATE, bn.ZNOTE_DATE, bn.ZCHILDMAPNOTEID,
            bn.ZHIGHLIGHT_STYLE,
            t.ZTITLE AS topic_title, t.ZMINDLINKS AS topic_mindlinks
        FROM ZBOOKNOTE bn
        LEFT JOIN ZTOPIC t ON t.ZTOPICID = bn.ZTOPICID
        WHERE bn.ZBOOKMD5 IN ({placeholders})
        ORDER BY bn.ZTOPICID, bn.ZSTARTPAGE, bn.ZSTARTPOS, bn.ZNOTEID
        """,
        md5_list,
    )
    rows = cursor.fetchall()

    def is_kept(r: sqlite3.Row) -> bool:
        if is_ai_context_node(r):
            return False
        if is_ai_answer_node(r) and not options.keep_ai_nodes:
            return False
        if not (r["ZHIGHLIGHT_TEXT"] or r["ZNOTES_TEXT"] or r["ZHIGHLIGHT_PIC"] or r["ZNOTETITLE"]):
            return False
        return True

    rows = [r for r in rows if is_kept(r)]
    if not rows:
        return None

    # 1. 按 topic 分组
    by_topic: dict[str, list[sqlite3.Row]] = {}
    topic_meta: dict[str, dict] = {}
    for r in rows:
        tid = r["ZTOPICID"] or ""
        by_topic.setdefault(tid, []).append(r)
        if tid not in topic_meta:
            topic_meta[tid] = {
                "title": r["topic_title"] or "(无 Topic)",
                "is_mindmap": bool(r["topic_mindlinks"]),
            }

    # 2. 选主 topic：先看本书在该 topic 内含层级的笔记数，再看总数。
    #    最后用 tid 字典序做 tiebreaker，确保多个 topic 评分一致时跨进程稳定，
    #    否则 max(...) 落到字典插入顺序里第一个 → 受 SQL/dict 顺序影响 → 抖动。
    def topic_score(tid: str) -> tuple:
        ns = by_topic[tid]
        with_links = sum(1 for r in ns if r["ZMINDLINKS"])
        return (with_links, len(ns), 1 if topic_meta[tid]["is_mindmap"] else 0, tid)

    main_tid = max(by_topic.keys(), key=topic_score) if by_topic else ""
    main_meta = topic_meta.get(main_tid, {"title": "(无 Topic)", "is_mindmap": False})

    # 3. 主 topic 上构造层级树
    roots: list[TreeNode] = []
    main_keys: dict[tuple, sqlite3.Row] = {}
    if main_tid:
        try:
            full_notes = fetch_notes(ctx, main_tid)
        except Exception:
            full_notes = []
        roots = build_tree(full_notes) if full_notes else []
        roots = _filter_tree_to_book(roots, md5_set)
        # 二次剪枝：_filter_tree_to_book 会保留所有 own=True 的节点，
        # 这会把 MarginNote 自动从 PDF 大纲生成的纯目录占位节点（ZTYPE=6，
        # 只有 ZNOTETITLE，没有 excerpt/批注/图/真实子树）也带进来。
        # 用 _prune_empty_branches 把"没真实内容、子树也空"的节点剪掉，
        # 只保留作为分组锚点（有用户笔记挂在下面）的目录节点。
        roots = _prune_empty_branches(roots)
        for tn in _walk_tree(roots):
            if tn.note["ZBOOKMD5"] in md5_set:
                main_keys[_key_for_book_note(tn.note)] = tn.note

    # 树构造失败 / 主 topic 没有层级 → 退化成扁平模式
    if not roots:
        roots = []
        for r in by_topic.get(main_tid, []):
            # 扁平模式没层级可挂，"只有 title、没摘录/批注/图/子 mindmap" 的节点
            # 都属于占位（PDF outline 自动生成的章节、空的 mindmap 主标题等），
            # 跳过。判断口径与 build_tree 内部 _has_real_content 一致。
            if not _has_real_content(r):
                continue
            roots.append(TreeNode(note=r))

        def sk(tn: TreeNode) -> tuple:
            n = tn.note
            page = n["ZSTARTPAGE"] if n["ZSTARTPAGE"] is not None else 0
            return (page, n["ZSTARTPOS"] or "")

        roots.sort(key=sk)
        main_keys = {_key_for_book_note(tn.note): tn.note for tn in roots
                     if tn.note["ZBOOKMD5"] in md5_set}

    # 4. 跨 topic 合并：能匹配主 key 的批注合并；不能的进 standalone
    extra_per_node: dict[str, list[tuple[str, str]]] = {}
    standalone: list[tuple[str, sqlite3.Row]] = []

    for tid, ns in by_topic.items():
        if tid == main_tid:
            continue
        meta = topic_meta[tid]
        ttitle = meta["title"]
        for r in ns:
            key = _key_for_book_note(r)
            primary = main_keys.get(key)
            if primary is not None:
                if r["ZNOTES_TEXT"]:
                    extra_per_node.setdefault(primary["ZNOTEID"], []).append((ttitle, r["ZNOTES_TEXT"]))
            else:
                # 只有 title、没摘录/批注/图/子树的纯占位节点不要列入 standalone。
                # （PDF 目录大纲自动生成的章节占位、空的 mindmap 标题节点等。）
                if not _has_real_content(r):
                    continue
                standalone.append((ttitle, r))

    # 5. 取所有用到的 note 行（主层级 + standalone）后批量取图片
    all_image_notes: list[sqlite3.Row] = [tn.note for tn in _walk_tree(roots)]
    all_image_notes.extend(r for _, r in standalone)
    media_map, note_hash_map = fetch_media(ctx, all_image_notes)

    image_cache: dict[str, bytes] = {}
    for n in all_image_notes:
        data = _resolve_note_image(n, media_map, note_hash_map)
        if data:
            image_cache[n["ZNOTEID"]] = data

    # 6. 文件名 / 子目录
    folder_rel = (book_meta.get("folder") or "") if isinstance(book_meta, dict) else ""
    folder_segs = [sanitize_filename(s) for s in folder_rel.split("/") if s.strip()]
    out_dir = os.path.join(out_root, "Books", *folder_segs)
    assets_dir = os.path.join(out_root, "assets")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)
    safe_name = sanitize_filename(title)
    file_path = os.path.join(out_dir, f"{safe_name}.md")
    counter = 1
    # 仅在"同次运行内"撞名（比如两本书 fallback title 完全相同但没合并）才加
    # 后缀；vault 里上次的同名文件保留 mtime —— 真正的覆盖判定交给
    # _write_if_changed 做。
    in_run_paths = options.generated_paths
    if in_run_paths is not None:
        while file_path in in_run_paths:
            file_path = os.path.join(out_dir, f"{safe_name} ({counter}).md")
            counter += 1
        in_run_paths.add(file_path)

    # 图片相对路径：md 在 Books/[A/B/...]/foo.md，从那里到 assets/ 要 ../ 回退几层。
    # Books 这层占 1 级，folder_segs 各占 1 级。
    depth = 1 + len(folder_segs)
    image_rel = "/".join([".."] * depth) + "/assets" if depth else "./assets"

    # 6.5 卡片关联 label 字典：把本书所有 row 的 NoteID → 友好 label，
    #     这样跨笔记的 marginnote://note/<id> 能用对方的 title/摘录前缀做链接文案。
    card_labels: dict[str, str] = {}
    for r in rows:
        nid = r["ZNOTEID"]
        if not nid:
            continue
        title_lbl = clean_text(r["ZNOTETITLE"]).strip()
        if title_lbl:
            card_labels[nid] = title_lbl
            continue
        excerpt_lbl = clean_text(r["ZHIGHLIGHT_TEXT"]).strip()
        if excerpt_lbl:
            # 取第一行 + 截断，避免 label 过长
            first_line = excerpt_lbl.splitlines()[0].strip()
            card_labels[nid] = first_line

    # 6.6 收集本书所有 note 的 excerpt 归一化集合，用于在渲染阶段剥掉批注里
    #     和某条独立划线一字不差的段落（"原文是基础，批注是附加，重复时删批
    #     注、保留划线"）。
    excerpt_norms: set[str] = set()
    for r in rows:
        e_text = clean_text(r["ZHIGHLIGHT_TEXT"] or "").strip()
        if not e_text:
            continue
        norm = re.sub(r"\s+", "", e_text)
        if len(norm) >= 12:
            excerpt_norms.add(norm)

    book_options = dataclasses.replace(
        options, image_dir_relative=image_rel, card_labels=card_labels,
        excerpt_norms_in_book=excerpt_norms,
    )

    # 7. 标签：优先用 MarginNote 主页书架打的分类（区分性强），叠加用户在批注里写的 hashtag
    tag_set: set[str] = set()
    # (a) MarginNote 主页"我的书架"中给该书打的分类。书架是树状嵌套，
    #     直接写 "祖先/父/自己" 形式 —— Obsidian 会同时识别为 #祖先 / #祖先/父 / #祖先/父/自己。
    for cat in (book_meta.get("categories") or []):
        norm = "/".join(_normalize_tag(seg) for seg in cat.split("/") if seg.strip())
        if norm:
            tag_set.add(norm)
    # (b) 用户自己在 ZNOTES_TEXT 里手写的 hashtag
    user_tag_counter: dict[str, int] = {}
    for r in rows:
        if r["ZNOTES_TEXT"]:
            for t in extract_hashtags(r["ZNOTES_TEXT"]):
                if len(t) < 2 or t.isdigit():
                    continue
                user_tag_counter[t] = user_tag_counter.get(t, 0) + 1
    for t in sorted(user_tag_counter, key=lambda k: -user_tag_counter[k])[:30]:
        norm = _normalize_tag(t)
        if norm:
            tag_set.add(norm)
    tags = sorted(tag_set)

    # 来源 Topic 集合
    all_sources: dict[str, bool] = {main_meta["title"]: main_meta["is_mindmap"]}
    for tid in by_topic:
        if tid == main_tid:
            continue
        m = topic_meta[tid]
        all_sources.setdefault(m["title"], m["is_mindmap"])

    # 笔记时间戳（NSDATE → ISO），用于 # 读书笔记 段的 ⏱ 行
    note_dates: dict[str, str] = {}
    for r in rows:
        ts = r["ZNOTE_DATE"] or r["ZHIGHLIGHT_DATE"]
        if ts is None:
            continue
        try:
            iso = ns_date_to_iso(ts)
            if iso:
                note_dates[r["ZNOTEID"]] = iso
        except Exception:
            pass

    # 8. 渲染主体：weread 风格（# 高亮划线 段）
    stats = RenderStats()
    reviews: list[_ReviewItem] = []
    main_body: list[str] = []

    is_flat_book = bool(roots) and all(not r.children for r in roots)

    if is_flat_book:
        last_page: int | None = None
        for root in roots:
            n = root.note
            page = n["ZSTARTPAGE"]
            if last_page is not None and page != last_page:
                main_body.append("---")
                main_body.append("")
            last_page = page
            _render_flat_book_note_weread(
                n, main_body, assets_dir, image_cache, book_options, reviews,
            )
            stats.note_count += 1
            if n["ZNOTEID"] in image_cache:
                stats.image_count += 1
            _emit_extras_para(TreeNode(note=n), extra_per_node, book_options, main_body)
    else:
        for root in roots:
            _render_book_node_weread(
                root, 1, main_body, assets_dir, media_map, note_hash_map,
                book_options, stats, reviews, extra_per_node,
            )

    # 9. standalone（其它 Topic 独有但和主结构对不上的笔记）：按 Topic 分一节，
    #    weread 风格段落输出
    standalone_body: list[str] = []
    if standalone:
        from collections import defaultdict as _dd
        by_other: dict[str, list[sqlite3.Row]] = _dd(list)
        for ttitle, r in standalone:
            by_other[ttitle].append(r)
        for ttitle in sorted(by_other.keys()):
            standalone_body.append(f"## 📍 {ttitle}")
            standalone_body.append("")
            ns = sorted(
                by_other[ttitle],
                key=lambda r: (r["ZSTARTPAGE"] or 0, r["ZSTARTPOS"] or ""),
            )
            for n in ns:
                _render_flat_book_note_weread(
                    n, standalone_body, assets_dir, image_cache, book_options, reviews,
                    chapter=ttitle,
                )
                stats.note_count += 1
                if n["ZNOTEID"] in image_cache:
                    stats.image_count += 1

    # 10. 历史曾经渲染过 `# 读书笔记 / ### 划线评论` 段——把所有有批注的笔记
    #     再单独罗列一份。但它跟 `# 高亮划线` 区里 `[!note]+ 💭 我的批注`
    #     callout 显示的是同一条信息，纯粹的视觉重复。已下线，只在 frontmatter
    #     `reviewCount` 字段里保留批注计数供索引/搜索。reviews 仍在收集，留作
    #     未来如果想做"按章节 dataview 聚合"等高级视图的 hook。
    _ = note_dates  # noqa: F841 (保留供未来 dataview 视图使用)

    # 11. frontmatter（对齐 weread-plugin 字段命名风格）
    # `lastNoteUpdate` 取本书所有笔记的最大 ZNOTE_DATE / ZHIGHLIGHT_DATE 作为
    # "笔记最新更新时间"，跟运行时刻无关 —— 只有 MarginNote 那边真改了
    # 笔记，这个值才会变，导出文件才会被覆写，从而保留 Obsidian 的 mtime。
    last_update_ts: float | None = None
    for r in rows:
        for col in ("ZNOTE_DATE", "ZHIGHLIGHT_DATE"):
            ts = r[col]
            if ts is None:
                continue
            if last_update_ts is None or ts > last_update_ts:
                last_update_ts = ts
    last_update = ns_date_to_iso(last_update_ts) if last_update_ts is not None else None

    is_merged = len(md5_list) > 1
    fm: dict[str, Any] = {
        "doc_type": "marginnote-highlights-reviews",
        "bookMd5": md5_list if is_merged else md5_list[0],
    }
    if is_merged:
        fm["mergedBooks"] = len(md5_list)
    fm["title"] = title
    if author:
        fm["author"] = author
    fm["noteCount"] = stats.note_count
    fm["reviewCount"] = len(reviews)
    fm["imageCount"] = stats.image_count
    fm["sourceTopics"] = sorted(all_sources.keys())
    fm["primaryTopic"] = main_meta["title"]
    if last_update:
        fm["lastNoteUpdate"] = last_update
    # MarginNote 跳回链接：从原本 `# 元数据` callout 里挪到 frontmatter，便于
    # 在 Obsidian "笔记属性" 面板就能点开跳回 MarginNote，且避免和上方面板内
    # 容重复呈现。
    if main_tid:
        fm["marginnote"] = f"{book_options.url_scheme}://notebook/{main_tid}"
    fm["tags"] = tags
    fm["source"] = ctx.app_name
    frontmatter = render_frontmatter(fm)

    # 12. 头部仅保留 H1 标题。原本的 `# 元数据 / > [!abstract] ...` callout
    #     已下线 —— 它和 Obsidian 顶部"笔记属性"面板（frontmatter）展示的
    #     信息完全重复，纯视觉冗余。MarginNote 跳回链接已挪到 frontmatter
    #     `marginnote` 字段。
    head_block: list[str] = []
    head_block.append(f"# {title}")
    head_block.append("")

    # 13. 拼接 final
    body_lines: list[str] = []
    if any(l.strip() for l in main_body):
        body_lines.append("# 高亮划线")
        body_lines.append("")
        body_lines.extend(main_body)
    if standalone_body:
        if body_lines:
            body_lines.append("")
        body_lines.append("# 其它 Topic 的补充笔记")
        body_lines.append("")
        body_lines.extend(standalone_body)

    # 13.5 防止生成"空导出"：MarginNote 里有时一本书的 ZBOOKNOTE 全是占位
    # （ZTYPE=6 目录节点 / 空 mindmap 容器），rows 不空但所有节点要么被
    # `_prune_empty_branches` 剪掉，要么被去重剥光，最终 body_lines 空着。
    # 这种情况下不应该在 vault 里留个只有 frontmatter + H1 的空壳文件。
    has_real_body = bool(body_lines) and stats.note_count > 0
    if not has_real_body:
        # 把刚才占位的 file_path 从本次运行的"已生成"集合里撤回，让它后续
        # 被 _prune_orphans 当孤儿清理掉（如果之前导过同名文件的话）。
        if in_run_paths is not None:
            in_run_paths.discard(file_path)
        return None

    final = frontmatter + "\n" + "\n".join(head_block + body_lines).rstrip() + "\n"
    changed = _write_if_changed(file_path, final)

    if changed:
        # 只在内容真有变化时打印日志，避免无变更的几百行噪音。
        hierarchy_marker = "🌳" if main_meta["is_mindmap"] else "📄"
        print(
            f"   ✏️  {hierarchy_marker} {title} → {file_path}"
            f"（{stats.note_count} 条 / {stats.image_count} 图 / {len(all_sources)} 来源）"
        )

    return ExportResult(
        topic_id=md5_list[0],
        title=title,
        file_path=file_path,
        is_mindmap=False,
        note_count=stats.note_count,
        image_count=stats.image_count,
        changed=changed,
    )


def _render_flat_book_note(
    n: sqlite3.Row,
    body: list[str],
    assets_dir: str,
    image_cache: dict[str, bytes],
    options: RenderOptions,
) -> None:
    """渲染"补充区 / 平铺书"中的单条笔记。

    样式约定：
    - title（用户归纳）→ 用粗体当 list head，backlink 跟在 head 末
    - 无 title → 用 quote / image / callout 直接当 list head，backlink 附在末尾
    - 摘录 → 一律 `> quote` 块，不加粗
    - backlink → 单一锚点 `[p.X](url)` 或 `[>>](url)`
    """
    page = n["ZSTARTPAGE"]
    title_text = clean_text(n["ZNOTETITLE"])
    excerpt = clean_text(n["ZHIGHLIGHT_TEXT"])
    comment, _ = _split_tags_from_comment(clean_text(n["ZNOTES_TEXT"] or ""))
    comment, card_link_ids = _split_card_links(comment)
    title_to_show, excerpt_to_show = _resolve_dedup(title_text, excerpt)

    backlink = _backlink(n["ZNOTEID"], page, options.url_scheme)
    image_data = image_cache.get(n["ZNOTEID"])

    bullet = "- "
    body_indent = "  "

    if title_to_show:
        body.append(f"{bullet}**{escape_markdown_header(title_to_show)}**  {backlink}")
        if excerpt_to_show:
            _emit_excerpt(excerpt_to_show, body, body_indent)
        if image_data:
            _emit_image(n["ZNOTEID"], image_data, assets_dir, options, body, body_indent)
        if comment:
            _emit_comment(comment, body, body_indent)
        if card_link_ids:
            _emit_card_links(card_link_ids, options, body, body_indent,
                             self_id=n["ZNOTEID"])
    else:
        slots: list[str] = []
        if excerpt_to_show: slots.append("excerpt")
        if image_data: slots.append("image")
        if comment: slots.append("comment")
        if card_link_ids: slots.append("cardlinks")
        last = slots[-1] if slots else None
        first = True
        for slot in slots:
            head_bullet = bullet if first else None
            tlink = backlink if slot == last else None
            if slot == "excerpt":
                _emit_excerpt(excerpt_to_show, body, body_indent,
                              trailing_link=tlink, bullet=head_bullet)
            elif slot == "image":
                _emit_image(n["ZNOTEID"], image_data, assets_dir, options,
                            body, body_indent,
                            trailing_link=tlink, bullet=head_bullet)
            elif slot == "comment":
                _emit_comment(comment, body, body_indent,
                              trailing_link=tlink, bullet=head_bullet)
            elif slot == "cardlinks":
                _emit_card_links(card_link_ids, options, body, body_indent,
                                 self_id=n["ZNOTEID"],
                                 trailing_link=tlink, bullet=head_bullet)
            first = False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="MarginNote → Obsidian 导出工具")
    p.add_argument("--all", action="store_true", help="导出全部笔记本")
    p.add_argument("--id", dest="topic_id", help="按 ZTOPICID 导出单个笔记本")
    p.add_argument("--out", default=OUTPUT_DIR, help=f"输出目录（默认 {OUTPUT_DIR}）")
    p.add_argument("--keep-ai", action="store_true", help="保留 AI 节点（默认过滤）")
    p.add_argument(
        "--image-width", type=int, default=0,
        help="图片显示宽度（像素）。> 0 时使用 Obsidian 私有的 `![|N](path)` 写法限制宽度；"
             "默认 0 输出标准 Markdown，对所有渲染器（VS Code、Cursor、GitHub）都通用。",
    )
    p.add_argument(
        "--no-folder-grouping", dest="group_by_folder", action="store_false",
        default=True,
        help="--by-book 模式下默认按 MarginNote 的文件夹（ZBOOK.ZPATH）归类，"
             "导出到 Books/<文件夹>/<书名>.md。加该选项可强制平铺到 Books/ 下。",
    )
    p.add_argument(
        "--no-clean", dest="clean", action="store_false", default=True,
        help="导出采用增量 + 孤儿清理：磁盘上已有同名文件且内容一致时跳过覆盖（保留 mtime/"
             "ctime/inode），只有 MarginNote 那边真改了笔记才会更新对应文件。本次运行未"
             "再生成的旧 .md（MarginNote 端删除/改名/移目录）会被当成孤儿删掉，让 vault 与"
             "MarginNote 当前状态保持一致。加 --no-clean 关闭孤儿清理（保留所有旧文件，仅"
             "做内容增量更新）。--id 单本调试模式自动跳过孤儿清理。",
    )
    scope = p.add_mutually_exclusive_group()
    scope.add_argument("--books-only", action="store_true",
                       help="只导出书籍类 Topic（无 ZMINDLINKS）")
    scope.add_argument("--mindmaps-only", action="store_true",
                       help="只导出思维导图 Topic（含子思维导图）")
    scope.add_argument("--by-book", action="store_true",
                       help="按 PDF 聚合：把同一本书在所有 Topic 中的笔记合并到一份 markdown")
    return p.parse_args()


def _filter_by_scope(notebooks: list[sqlite3.Row], books_only: bool, mindmaps_only: bool) -> list[sqlite3.Row]:
    if books_only:
        return [n for n in notebooks if not n["ZMINDLINKS"]]
    if mindmaps_only:
        return [n for n in notebooks if n["ZMINDLINKS"]]
    return list(notebooks)


def interactive_choice(notebooks: list[sqlite3.Row]) -> list[sqlite3.Row]:
    print("\n可选笔记本：")
    for i, row in enumerate(notebooks, 1):
        kind = "🧠 思维导图" if row["ZMINDLINKS"] else "📖 书籍"
        print(f"  {i:>3}. {kind}  {row['ZTITLE']}")
    print(f"  {len(notebooks) + 1:>3}. 📦 导出全部")

    raw = input("\n请输入编号（多个用逗号分隔，回车取消）: ").strip()
    if not raw:
        return []
    if raw == str(len(notebooks) + 1):
        return list(notebooks)

    selected: list[sqlite3.Row] = []
    for token in re.split(r"[\s,，]+", raw):
        if not token.isdigit():
            continue
        idx = int(token) - 1
        if 0 <= idx < len(notebooks):
            selected.append(notebooks[idx])
    return selected


def _write_if_changed(path: str, content: str) -> bool:
    """只在内容真有变化时才覆写文件（保留原 mtime/ctime/inode）。

    rationale：
    - 之前是先把整个 Books/ rmtree 再 open(... 'w') 全量重写，每次运行
      都会刷新所有文件的 mtime/ctime，Obsidian 的"最近编辑"列表会被
      误报成"今天动过 414 个文件"。
    - 现在先比对磁盘上的旧内容：相同就什么都不做（连 open 都不开），
      只在字节真不同时才覆写。这样 Obsidian / iCloud / Dropbox 等只在
      MarginNote 那边真有改动时才看到文件被动。

    返回 True 表示有写入，False 表示跳过。
    """
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                if f.read() == content:
                    return False
        except OSError:
            pass
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def _list_existing_md(out_root: str) -> set[str]:
    """扫描 out/Books 与 out/MindMaps 下所有现存的 .md 绝对路径。"""
    found: set[str] = set()
    for sub in ("Books", "MindMaps"):
        base = os.path.join(out_root, sub)
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for f in files:
                if f.endswith(".md"):
                    found.add(os.path.join(root, f))
    return found


def _prune_orphans(out_root: str, kept_files: set[str]) -> int:
    """删掉上次生成、本次未再生成的 .md（孤儿），并清理变空的目录。

    这样可以同步 MarginNote 端的删除 / 改名 / 移目录操作，但**不会动**
    本次仍然存在的文件（mtime 保持原样）。assets/ 保留——图片孤儿不影响
    渲染，避免反复 IO 大体积图片。同时把残留的 INDEX.md 也清掉。
    """
    existing = _list_existing_md(out_root)
    orphans = existing - kept_files
    removed = 0
    for p in orphans:
        try:
            os.remove(p)
            removed += 1
        except OSError:
            pass
    # 清空目录（自下而上）
    for sub in ("Books", "MindMaps"):
        base = os.path.join(out_root, sub)
        if not os.path.isdir(base):
            continue
        for root, _dirs, _files in os.walk(base, topdown=False):
            try:
                if root != base and not os.listdir(root):
                    os.rmdir(root)
            except OSError:
                pass
    legacy_index = os.path.join(out_root, "INDEX.md")
    if os.path.isfile(legacy_index):
        try:
            os.remove(legacy_index)
        except OSError:
            pass
    return removed


def main() -> None:
    args = parse_args()

    print("📘 MarginNote → Obsidian 导出工具")
    ctx = open_database()
    if not ctx:
        sys.exit(1)
    print(f"   数据源：{ctx.app_name}")

    # 本次运行内已经写过的 .md 路径集合，用来：
    #   (a) 同次运行内若有真撞名（罕见）才加 (1)/(2)；vault 里上次留下的同名
    #       文件不会再触发 +(1)，从而保留 mtime/ctime；
    #   (b) 全部导完后做孤儿清理（删除 MarginNote 已删 / 改名 / 移目录的旧文件）。
    generated_paths: set[str] = set()

    options = RenderOptions(
        keep_ai_nodes=args.keep_ai,
        url_scheme=ctx.url_scheme,
        recurse_child_maps=not args.books_only,
        image_width=max(0, args.image_width),
        generated_paths=generated_paths,
    )
    out_root = args.out
    os.makedirs(out_root, exist_ok=True)

    def _summarize(label: str, results: list[ExportResult]) -> None:
        changed = sum(1 for r in results if r.changed)
        unchanged = len(results) - changed
        if args.clean and not args.topic_id:
            removed = _prune_orphans(out_root, generated_paths)
            tail = f"，🧹 清理孤儿 {removed} 个" if removed else ""
        else:
            tail = ""
        print(
            f"\n🎉 完成！共 {len(results)} {label} —— ✏️ 实写 {changed}，"
            f"♻️ 未变化 {unchanged}{tail}。"
        )

    # ---- 模式 1：按书聚合 ----
    if args.by_book:
        books = list_books(ctx)
        if not books:
            print("⚠️ 未发现任何书籍引用。")
            return
        # --by-book 模式下 --id 用作 ZBOOKMD5 过滤（导单本调试用）。支持单 md5 与
        # 合并 books（md5_list 中任一前缀匹配即视为命中）。
        if args.topic_id:
            tgt = args.topic_id
            books = [b for b in books
                     if any((m or "").startswith(tgt) for m in (b.get("md5_list") or [b["md5"]]))]
            if not books:
                print(f"❌ 找不到 ZBOOKMD5={args.topic_id} 的书。")
                sys.exit(1)
        # 不分组时清空 folder（保持平铺）
        if not args.group_by_folder:
            for b in books:
                b["folder"] = ""
        print(f"\n按书聚合：发现 {len(books)} 本被引用过的书，开始导出至 {out_root}")
        if args.group_by_folder:
            print("   📁 已启用按 MarginNote 文件夹分组（--no-folder-grouping 可关闭）")
        all_results: list[ExportResult] = []
        for meta in books:
            try:
                r = export_book(ctx, meta, out_root, options)
                if r:
                    all_results.append(r)
            except Exception as exc:  # noqa: BLE001
                print(f"   ⚠️ 《{meta['title']}》导出失败: {exc}")
        _summarize("本书", all_results)
        return

    # ---- 模式 2：按 Topic ----
    notebooks = list_notebooks(ctx)
    if not notebooks:
        print("⚠️ 未发现任何笔记本。")
        return

    if args.topic_id:
        targets = [n for n in notebooks if n["ZTOPICID"] == args.topic_id]
        if not targets:
            print(f"❌ 找不到 ZTOPICID={args.topic_id} 的笔记本。")
            sys.exit(1)
    elif args.all or args.books_only or args.mindmaps_only:
        targets = _filter_by_scope(notebooks, args.books_only, args.mindmaps_only)
    else:
        scoped = _filter_by_scope(notebooks, args.books_only, args.mindmaps_only)
        targets = interactive_choice(scoped)
        if not targets:
            print("已取消。")
            return

    scope_desc = (
        "Books"
        if args.books_only
        else "MindMaps"
        if args.mindmaps_only
        else "All"
    )

    print(f"\n开始导出 {len(targets)} 个笔记本（范围：{scope_desc}）至 {out_root}")
    all_results = []
    visited: set[str] = set()
    for topic in targets:
        try:
            sub = export_notebook(ctx, topic, out_root, options, visited_topics=visited)
            all_results.extend(sub)
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️ {topic['ZTITLE']} 导出失败: {exc}")

    _summarize("个文件", all_results)


if __name__ == "__main__":
    main()
