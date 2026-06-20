/**
 * weread 风格按书导出渲染（--by-book 模式树状 + 跨 Topic 批注 callout）。
 */

import {
  backlink,
  cleanText,
  commentEqualsExcerpt,
  escapeMdHeader,
  renderNoteWeread,
  resolveDedup,
  splitCardLinks,
  splitTagsFromComment,
  stripParagraphsInSet,
} from "./render";
import type { Note, RenderContext, RenderStats } from "./types";
import type { TreeNode } from "./tree";
import { hasRealContent } from "./tree";

export function emitQuotePara(
  text: string,
  lines: string[],
  trailingLink?: string | null
): void {
  const rawLines = text.split("\n").filter((r) => r.trim());
  if (!rawLines.length) return;
  const n = rawLines.length;
  for (let i = 0; i < n; i++) {
    const out = escapeMdHeader(rawLines[i]);
    const isLast = i === n - 1;
    const suffix = isLast && trailingLink ? `  ${trailingLink}` : " ";
    lines.push(`>  ${out}${suffix}`);
  }
  lines.push("");
}

export function emitExtrasPara(
  noteId: string,
  extraPerNode: Map<string, [string, string][]>,
  ctx: RenderContext,
  lines: string[]
): void {
  const extras = extraPerNode.get(noteId);
  if (!extras?.length) return;
  for (const [ttitle, raw] of extras) {
    let cleaned = cleanText(raw);
    cleaned = splitTagsFromComment(cleaned).body;
    cleaned = splitCardLinks(cleaned).body.trim();
    if (!cleaned) continue;
    lines.push(`> [!quote]- 💬 来自《${ttitle}》的批注`);
    for (const ln of cleaned.split("\n")) {
      lines.push(ln.trim() ? `> ${ln}` : "> ");
    }
    lines.push("");
  }
}

export function renderBookNodeWeread(
  node: TreeNode,
  level: number,
  lines: string[],
  ctx: RenderContext,
  stats: RenderStats,
  extraPerNode: Map<string, [string, string][]>,
  chapterStack: string[] = []
): void {
  const note = node.note;
  const title = cleanText(note.ZNOTETITLE);
  const excerpt = cleanText(note.ZHIGHLIGHT_TEXT);
  let comment = splitTagsFromComment(cleanText(note.ZNOTES_TEXT)).body;
  comment = splitCardLinks(comment).body;
  const page = note.ZSTARTPAGE ?? null;
  const [titleToShow, excerptToShow] = resolveDedup(title, excerpt);

  if (comment && commentEqualsExcerpt(comment, excerptToShow)) comment = "";
  if (comment) comment = stripParagraphsInSet(comment, ctx.excerptNorms);

  const imagePath = ctx.imagePaths?.get(note.ZNOTEID);
  const cardIds = splitCardLinks(cleanText(note.ZNOTES_TEXT)).ids;
  const hasBody = !!(excerptToShow || comment || imagePath || cardIds.length);

  let headText: string | null = titleToShow || null;
  let excerptBody = excerptToShow;
  if (!headText && node.children.length && excerptBody) {
    const exLines = excerptBody.split("\n").filter((l) => l.trim());
    if (exLines.length) {
      headText = exLines[0].trim();
      excerptBody = exLines.slice(1).join("\n").trim();
    }
  }

  if (!headText && !hasBody) {
    stats.skippedEmpty += 1;
    for (const child of node.children) {
      renderBookNodeWeread(child, level, lines, ctx, stats, extraPerNode, chapterStack);
    }
    return;
  }

  let newChapterStack = chapterStack;
  const bl = backlink(note.ZNOTEID, page, ctx.urlScheme);
  if (headText) {
    const hLevel = Math.max(2, Math.min(level + 1, 6));
    lines.push(`${"#".repeat(hLevel)} ${escapeMdHeader(headText)}  ${bl}`);
    lines.push("");
    if (hLevel <= 3) newChapterStack = [...chapterStack, headText];
  }

  const hasNoHead = !headText && hasBody;
  const slots: string[] = [];
  if (excerptBody) slots.push("excerpt");
  if (imagePath) slots.push("image");
  if (comment) slots.push("comment");
  if (cardIds.length) slots.push("cardlinks");
  const lastSlot = slots[slots.length - 1];

  if (excerptBody) {
    emitQuotePara(excerptBody, lines, hasNoHead && lastSlot === "excerpt" ? bl : null);
  }
  if (imagePath) {
    const alt = ctx.imageWidth > 0 ? `|${ctx.imageWidth}` : "";
    lines.push(`![${alt}](${imagePath})${hasNoHead && lastSlot === "image" ? `  ${bl}` : ""}`);
    lines.push("");
    stats.imageCount += 1;
  }
  if (comment) {
    lines.push("> [!note]+ 💭 我的批注");
    const parts = comment.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const suffix = hasNoHead && lastSlot === "comment" && i === parts.length - 1 ? `  ${bl}` : "";
      lines.push(`> ${escapeMdHeader(parts[i])}${suffix}`);
    }
    lines.push("");
  }
  if (cardIds.length) {
    for (let i = 0; i < cardIds.length; i++) {
      const cid = cardIds[i];
      if (cid === note.ZNOTEID) continue;
      const label = ctx.cardLabels.get(cid) || "卡片";
      const url = `${ctx.urlScheme}://note/${cid}`;
      const suffix = hasNoHead && lastSlot === "cardlinks" && i === cardIds.length - 1 ? `  ${bl}` : "";
      lines.push(`[🔗 关联：${label}](${url})${suffix}`);
    }
    lines.push("");
  }

  emitExtrasPara(note.ZNOTEID, extraPerNode, ctx, lines);
  if (hasBody) stats.noteCount += 1;

  for (const child of node.children) {
    renderBookNodeWeread(child, level + 1, lines, ctx, stats, extraPerNode, newChapterStack);
  }
}

/** 扁平书笔记（无 mindmap 层级）— 复用 renderNoteWeread。 */
export function renderFlatBookNote(
  note: Note,
  ctx: RenderContext,
  lines: string[],
  stats: RenderStats,
  extraPerNode: Map<string, [string, string][]>
): void {
  renderNoteWeread(note, ctx, lines, stats);
  emitExtrasPara(note.ZNOTEID, extraPerNode, ctx, lines);
}

export function normalizeTag(name: string): string {
  let s = (name || "").trim();
  if (!s) return "";
  s = s.replace(/[\s\u3000]+/g, "-").replace(/#/g, "").replace(/,/g, "");
  return s.replace(/^-+|-+$/g, "");
}

export { hasRealContent };
