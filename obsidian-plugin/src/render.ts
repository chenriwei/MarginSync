/**
 * 把 MarginNote 笔记数据渲染为 obsidian-weread-plugin 风格的 Markdown。
 *
 * 这里实现的是 mn_export_tool.py（Python 端）渲染规则的 TS 复刻，规则一一对应：
 * - clean_text：去 MarginNote 私有标记 / CJK 兼容字符 / 零宽字符 / 伪 HTML
 * - 伪 HTML 转义：所有"裸标签 <name>"用 inline code 包起来，避免 Obsidian 的
 *   reader 模式被 `<form>` `<pad>` 等吞掉后续 quote / callout 装饰
 * - hashtag 抽取（行尾 `#tag`）→ frontmatter tags，并从批注正文中删除
 * - excerpt 跟 title 重复时不再渲染原文，避免双显示
 * - 跨 note 去重：批注里和别处独立划线一字不差的段落，从 callout 中剥掉，
 *   保留划线 quote
 * - weread 段落式 quote：每条原文独立成段 `>  text  [p.X](url)`，紧跟着的
 *   `> [!note]+ 💭 我的批注` callout 显示用户批注
 */

import type { Note, NoteRender, RenderContext, RenderStats } from "./types";

// ---------- 文本清洗 ----------

const CJK_COMPAT_MAP: Record<string, string> = {
  // 常见 CJK 兼容字符 → 普通形式（PDF 抽取常残留这些）
  // 完整表请见 Python 端 _normalize_cjk_compat；这里挑高频字 + 标点。
  "︰": "：", "︱": "—", "︿": "︿", "﹀": "﹀", "﹁": "「", "﹂": "」",
  "﹃": "『", "﹄": "』", "﹏": "﹏",
};

/** 折叠 PDF 抽取里 CJK 字符之间的多余空格。 */
function normalizePdfSpaces(text: string): string {
  // 中文字符之间多空格 → 单空格；首尾空格保留
  return text.replace(/([\u3000-\u9fff])\s+([\u3000-\u9fff])/g, "$1$2");
}

/** 移除 MarginNote 私有按钮标记 `$$button:...$$`。 */
function stripMnButtons(text: string): string {
  return text.replace(/\$\$button:[^$]*\$\$/g, "");
}

/** 真实 HTML 标签（不论开/闭）的写法识别：带属性时认为是真 inline HTML。 */
const BARE_TAG_RE = /<(\/?)(\|?[A-Za-z][\w|-]*\|?)\s*(\/?)>/g;

/**
 * 把"裸标签"（无属性的 `<name>` / `</name>` / `<name/>`）一律包成 inline code。
 * Obsidian 的 reader 模式默认放行 inline HTML，遇到不闭合的 `<form>` `<pad>` 等
 * 会让浏览器创建未知元素并吞掉后续兄弟节点，破坏 quote / callout 装饰。
 * 带属性的 `<a href="x">` 视为真 inline HTML，保留。
 */
function escapePseudoHtml(text: string): string {
  if (!text || !text.includes("<")) return text;
  // 跳过反引号包裹段：split 后偶数索引是普通文本，奇数索引是已经在 inline code 里的内容
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (!seg.includes("<")) continue;
    parts[i] = seg.replace(BARE_TAG_RE, (m) => "`" + m + "`");
  }
  return parts.join("`");
}

export function cleanText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const [k, v] of Object.entries(CJK_COMPAT_MAP)) {
    if (out.includes(k)) out = out.split(k).join(v);
  }
  out = normalizePdfSpaces(out);
  out = stripMnButtons(out);
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(/\u200b/g, "").replace(/\ufeff/g, "");
  out = escapePseudoHtml(out);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// ---------- 标签 ----------

/** `(?<![\w])#([\w/\u4e00-\u9fff][\w/\u4e00-\u9fff-]*)` 的 ES2020 等价。 */
const HASHTAG_RE = /(?<![\w])#([\w/\u4e00-\u9fff][\w/\u4e00-\u9fff-]*)/g;

/** 抽取 ZNOTES_TEXT 中的 hashtag，返回去重后的列表。 */
export function extractHashtags(text: string | null): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = HASHTAG_RE.exec(text))) {
    const tag = m[1];
    if (!seen.has(tag)) {
      seen.add(tag);
      found.push(tag);
    }
  }
  return found;
}

/**
 * 把 hashtag 从批注正文里剥掉。MarginNote 笔记里行尾常带一串 `#tag1 #tag2`，
 * frontmatter 已经收录这些 tag，正文里再保留就是噪音。
 */
export function splitTagsFromComment(comment: string): { body: string; tags: string[] } {
  const tags = extractHashtags(comment);
  if (!tags.length) return { body: comment, tags: [] };
  const body = comment.replace(HASHTAG_RE, "").replace(/[ \t]+\n/g, "\n").trim();
  return { body, tags };
}

// ---------- 卡片关联 ----------

/**
 * MarginNote "卡片关联跳转" 在 ZNOTES_TEXT 里写成 `marginnote4app://note/<UUID>`。
 * 把它们抽出来，剩下的批注正文就是干净文字。
 */
const CARD_LINK_RE = /marginnote[34]app:\/\/note\/([0-9A-Fa-f-]+)/g;
export function splitCardLinks(comment: string): { body: string; ids: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const body = comment.replace(CARD_LINK_RE, (_full, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    return "";
  });
  return { body: body.replace(/[ \t]+\n/g, "\n").trim(), ids };
}

// ---------- 去重 / 等价判断 ----------

const collapseWs = (s: string) => s.replace(/\s+/g, "");
const alphanumOnly = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");

export function commentEqualsExcerpt(comment: string, excerpt: string): boolean {
  if (!comment || !excerpt) return false;
  return collapseWs(comment) === collapseWs(excerpt);
}

/**
 * 决定 title 与 excerpt 重复时分别要不要保留，返回 [titleToShow, excerptToShow]。
 *
 * 规则按"保留信息量更多"的原则：
 * - **完全相同**（单词卡场景：``title='extraordinarily', excerpt='extraordinarily'``）
 *   → 保留 title（加粗单行更紧凑），丢 excerpt。
 * - **title 是 excerpt 的严格子串**（如 ``title='重点', excerpt='...这是一段重点内容...'``）
 *   → title 信息含量更少，丢 title 保 excerpt。
 * - **excerpt 是 title 的严格子串**（罕见，比如 title 用户加了前缀/后缀注释）
 *   → 保留 title，丢 excerpt。
 * - 完全无关 → 两者都保留。
 */
export function resolveDedup(title: string, excerpt: string): [string, string] {
  if (!title || !excerpt) return [title, excerpt];
  const t = alphanumOnly(title);
  const e = alphanumOnly(excerpt);
  if (!t || !e) return [title, excerpt];
  if (t === e) return [title, ""];
  if (e.includes(t)) return ["", excerpt];
  if (t.includes(e)) return [title, ""];
  return [title, excerpt];
}

/**
 * 从批注里剥掉跟本书内某条独立划线一字不差的段落（按双空行拆段）。
 * 段长 < 12 字符不参与匹配，避免短句误伤。
 */
export function stripParagraphsInSet(text: string, excerptNorms: Set<string>): string {
  if (!text || !excerptNorms.size) return text;
  const paras = text.split(/\n\s*\n/);
  const kept: string[] = [];
  let changed = false;
  for (const p of paras) {
    const ps = p.trim();
    if (!ps) {
      kept.push(p);
      continue;
    }
    const norm = collapseWs(ps);
    if (norm.length >= 12 && excerptNorms.has(norm)) {
      changed = true;
      continue;
    }
    kept.push(p);
  }
  if (!changed) return text;
  return kept.join("\n\n").trim();
}

// ---------- backlink / quote 段落 ----------

export function backlink(noteId: string, page: number | null, urlScheme: string): string {
  const url = `${urlScheme}://note/${noteId}`;
  const label = page != null ? `p.${page}` : ">>";
  return `[${label}](${url})`;
}

function escapeMdHeader(line: string): string {
  // 行首 `#` + 空格 会被识别为标题 → 转义。
  return line.replace(/^(\s*)(#{1,6})(\s)/, "$1\\$2$3");
}

/**
 * 渲染一条 note 为 weread 风格 markdown 段落（push 到 lines 里）。
 *
 * 输出形态（典型）：
 *
 *   >  原文摘录文本  [p.X](marginnote4app://note/<id>)
 *
 *   > [!note]+ 💭 我的批注
 *   > 用户写的批注内容
 *
 *   [🔗 关联：目标卡片](marginnote4app://note/<linked-id>)
 */
export function renderNoteWeread(
  note: Note,
  ctx: RenderContext,
  lines: string[],
  stats: RenderStats
): NoteRender | null {
  const title = cleanText(note.ZNOTETITLE);
  const excerptRaw = cleanText(note.ZHIGHLIGHT_TEXT);
  let { body: comment } = splitTagsFromComment(cleanText(note.ZNOTES_TEXT));
  const { body: commentClean, ids: cardLinkIds } = splitCardLinks(comment);
  comment = commentClean;

  // title 与 excerpt 重复时按"信息量更多"原则各自决定保留/丢弃
  // 见 resolveDedup 注释：单词卡（title==excerpt）保 title 丢 excerpt
  const [titleToShow, excerpt] = resolveDedup(title, excerptRaw);

  // A. comment == excerpt 的伪批注 → 清空 comment
  if (comment && commentEqualsExcerpt(comment, excerpt)) {
    comment = "";
  }
  // B. comment 里跟本书别的划线一字不差的段落 → 剥掉
  if (comment) {
    comment = stripParagraphsInSet(comment, ctx.excerptNorms);
  }

  const imagePath = ctx.imagePaths?.get(note.ZNOTEID) ?? null;

  const hasBody = !!(excerpt || comment || cardLinkIds.length || imagePath);
  const headText = titleToShow;

  if (!headText && !hasBody) {
    stats.skippedEmpty += 1;
    return null;
  }

  const page = note.ZSTARTPAGE ?? null;
  const link = backlink(note.ZNOTEID, page, ctx.urlScheme);

  // 决定 backlink 附在哪一段尾巴
  const slots: string[] = [];
  if (excerpt) slots.push("excerpt");
  if (imagePath) slots.push("image");
  if (comment) slots.push("comment");
  if (cardLinkIds.length) slots.push("cardlinks");
  const last = slots.length ? slots[slots.length - 1] : null;
  const trailing = (slot: string) => (last === slot ? `  ${link}` : "");

  // 标题（用户在 mindmap 上写的归纳）—— 加粗段落，行尾跟 backlink
  if (headText) {
    lines.push(`**${escapeMdHeader(headText)}**  ${link}`);
    lines.push("");
  }

  if (excerpt) {
    const para = excerpt
      .split("\n")
      .map((l) => `>  ${escapeMdHeader(l)}`)
      .join("\n");
    const lastSuffix = trailing("excerpt");
    if (lastSuffix) {
      // 把最后一行末尾追加 backlink
      const arr = para.split("\n");
      arr[arr.length - 1] = arr[arr.length - 1] + lastSuffix;
      lines.push(arr.join("\n"));
    } else {
      lines.push(para);
    }
    lines.push("");
  }

  if (imagePath) {
    const widthSpec = ctx.imageWidth > 0 ? `|${ctx.imageWidth}` : "";
    lines.push(`![${widthSpec}](${imagePath})${trailing("image")}`);
    lines.push("");
    stats.imageCount += 1;
  }

  if (comment) {
    lines.push("> [!note]+ 💭 我的批注");
    const cl = comment.split("\n");
    for (let i = 0; i < cl.length; i++) {
      const isLast = i === cl.length - 1;
      const suffix = isLast ? trailing("comment") : "";
      lines.push(`> ${escapeMdHeader(cl[i])}${suffix}`);
    }
    lines.push("");
  }

  if (cardLinkIds.length) {
    for (let i = 0; i < cardLinkIds.length; i++) {
      const id = cardLinkIds[i];
      if (id === note.ZNOTEID) continue;
      const url = `${ctx.urlScheme}://note/${id}`;
      const label = ctx.cardLabels.get(id) || "卡片";
      const isLast = i === cardLinkIds.length - 1;
      const suffix = isLast ? trailing("cardlinks") : "";
      lines.push(`[🔗 关联：${label}](${url})${suffix}`);
    }
    lines.push("");
  }

  stats.noteCount += 1;
  return {
    excerpt,
    comment,
    page,
    noteId: note.ZNOTEID,
    cardLinkIds,
  };
}

// ---------- frontmatter ----------

/** 渲染 YAML frontmatter（保持和 Python 端 render_frontmatter 兼容的引号策略）。 */
export function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** NSDate（自 2001-01-01 起秒数）→ "YYYY-MM-DD HH:MM:SS"。 */
export function nsDateToIso(ts: number | null): string | null {
  if (ts == null) return null;
  const epoch = 978307200; // 2001-01-01 UTC
  const d = new Date((epoch + ts) * 1000);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 把字符串变成安全的文件名（去掉 / : * ? " < > | 等）。 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "Untitled";
}

/** 是否需要保留这条 note（过滤 AI 节点 / 全空占位）。 */
export function isKept(note: Note, keepAi: boolean): boolean {
  // ZTYPE 标记：1=划线 2=笔记 6=mindmap 节点 等。
  // AI 上下文 / AI 答复节点的常见判定：标题以特定 emoji 开头。Python 端用了
  // is_ai_context_node / is_ai_answer_node，TS 这边先用最常见的两条：
  const title = note.ZNOTETITLE || "";
  const isAiCtx = /^🤖\s*AI/.test(title) || /^🌟\s*AI 上下文/.test(title);
  const isAiAns = /^🤖\s*AI 答复/.test(title);
  if (isAiCtx) return false;
  if (isAiAns && !keepAi) return false;
  if (!note.ZHIGHLIGHT_TEXT && !note.ZNOTES_TEXT && !note.ZHIGHLIGHT_PIC && !note.ZNOTETITLE) {
    return false;
  }
  return true;
}
