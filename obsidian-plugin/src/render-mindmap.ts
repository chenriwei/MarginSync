/**
 * 思维导图 Topic 的树状 list/heading 渲染（按 Topic 导出模式）。
 */

import {
  backlink,
  cleanText,
  escapeMdHeader,
  isKept,
  resolveDedup,
  splitCardLinks,
  splitTagsFromComment,
} from "./render";
import type { RenderContext, RenderStats } from "./types";
import type { TreeNode } from "./tree";

function emitExcerpt(
  excerpt: string,
  lines: string[],
  indent: string,
  trailingLink?: string | null,
  bullet?: string | null
): void {
  const rawLines = excerpt.split("\n").filter((r) => r.trim());
  if (!rawLines.length) return;
  for (let i = 0; i < rawLines.length; i++) {
    const out = escapeMdHeader(rawLines[i]);
    const suffix = trailingLink && i === rawLines.length - 1 ? `  ${trailingLink}` : "";
    if (i === 0 && bullet) lines.push(`${bullet}${out}${suffix}`);
    else lines.push(`${indent}${out}${suffix}`);
  }
}

function emitComment(
  comment: string,
  lines: string[],
  indent: string,
  trailingLink?: string | null,
  bullet?: string | null
): void {
  if (!comment.trim()) return;
  const header = "> [!note]+ 💭 我的批注";
  if (bullet) lines.push(`${bullet}${header}`);
  else lines.push(`${indent}${header}`);
  const parts = comment.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const suffix = trailingLink && i === parts.length - 1 ? `  ${trailingLink}` : "";
    lines.push(`${indent}> ${escapeMdHeader(parts[i])}${suffix}`);
  }
}

function emitCardLinks(
  cardIds: string[],
  ctx: RenderContext,
  lines: string[],
  indent: string,
  selfId: string,
  trailingLink?: string | null,
  bullet?: string | null
): void {
  const rendered: string[] = [];
  for (const cid of cardIds) {
    if (cid === selfId) continue;
    const raw = ctx.cardLabels.get(cid) || "";
    const label = raw.trim()
      ? `🔗 关联：${raw.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50)}`
      : "🔗 关联卡片";
    rendered.push(`[${label}](${ctx.urlScheme}://note/${cid})`);
  }
  if (!rendered.length) return;
  for (let i = 0; i < rendered.length; i++) {
    const suffix = trailingLink && i === rendered.length - 1 ? `  ${trailingLink}` : "";
    const head = `${rendered[i]}${suffix}`;
    if (i === 0 && bullet) lines.push(`${bullet}${head}`);
    else lines.push(`${indent}${head}`);
  }
}

export function renderMindmapNode(
  node: TreeNode,
  level: number,
  lines: string[],
  ctx: RenderContext,
  stats: RenderStats,
  forceList: boolean
): void {
  const note = node.note;
  if (!isKept(note, false)) {
    for (const child of node.children) {
      renderMindmapNode(child, level, lines, ctx, stats, forceList);
    }
    return;
  }

  const title = cleanText(note.ZNOTETITLE);
  const excerpt = cleanText(note.ZHIGHLIGHT_TEXT);
  const rawComment = cleanText(note.ZNOTES_TEXT);
  let comment = splitTagsFromComment(rawComment).body;
  const cardSplit = splitCardLinks(comment);
  const cardIds = cardSplit.ids;
  comment = cardSplit.body;
  const page = note.ZSTARTPAGE ?? null;
  const imagePath = ctx.imagePaths?.get(note.ZNOTEID);
  const [titleToShow, excerptToShow] = resolveDedup(title, excerpt);
  const hasBody = !!(excerptToShow || comment || imagePath || cardIds.length);

  if (!title && !hasBody) {
    stats.skippedEmpty += 1;
    return;
  }

  let headText: string | null = titleToShow || null;
  let excerptBody = excerptToShow;
  if (!headText && node.children.length && excerptBody) {
    const exLines = excerptBody.split("\n").filter((l) => l.trim());
    if (exLines.length) {
      headText = exLines[0].trim();
      excerptBody = exLines.slice(1).join("\n").trim();
    }
  }

  const bl = backlink(note.ZNOTEID, page, ctx.urlScheme);
  const headingLevels = 2;
  const useHeading = headText !== null && !forceList && level <= headingLevels;

  if (useHeading && headText) {
    lines.push("");
    lines.push(`${"#".repeat(level + 1)} ${escapeMdHeader(headText)}  ${bl}`);
    lines.push("");
    if (excerptBody) emitExcerpt(excerptBody, lines, "");
    if (imagePath) {
      const alt = ctx.imageWidth > 0 ? `|${ctx.imageWidth}` : "";
      lines.push(`![${alt}](${imagePath})`);
      lines.push("");
      stats.imageCount += 1;
    }
    if (comment) emitComment(comment, lines, "");
    if (cardIds.length) emitCardLinks(cardIds, ctx, lines, "", note.ZNOTEID);
  } else {
    const listDepth = forceList ? level - 1 : level - headingLevels - 1;
    const listIndent = "  ".repeat(Math.max(0, listDepth));
    const bullet = `${listIndent}- `;
    const bodyIndent = "  ".repeat(Math.max(0, listDepth) + 1);
    const slots: string[] = [];
    if (headText) {
      lines.push(`${bullet}**${escapeMdHeader(headText)}**  ${bl}`);
      if (excerptBody) emitExcerpt(excerptBody, lines, bodyIndent);
      if (imagePath) {
        const alt = ctx.imageWidth > 0 ? `|${ctx.imageWidth}` : "";
        lines.push(`${bodyIndent}![${alt}](${imagePath})`);
        stats.imageCount += 1;
      }
      if (comment) emitComment(comment, lines, bodyIndent);
      if (cardIds.length) emitCardLinks(cardIds, ctx, lines, bodyIndent, note.ZNOTEID);
    } else {
      if (excerptBody) slots.push("excerpt");
      if (imagePath) slots.push("image");
      if (comment) slots.push("comment");
      if (cardIds.length) slots.push("cardlinks");
      const last = slots[slots.length - 1];
      let first = true;
      for (const slot of slots) {
        const b = first ? bullet : undefined;
        const tlink = slot === last ? bl : undefined;
        if (slot === "excerpt") emitExcerpt(excerptBody, lines, bodyIndent, tlink, b ?? null);
        else if (slot === "image") {
          const alt = ctx.imageWidth > 0 ? `|${ctx.imageWidth}` : "";
          const line = `${first ? bullet : bodyIndent}![${alt}](${imagePath})${tlink ? `  ${tlink}` : ""}`;
          lines.push(line);
          stats.imageCount += 1;
        } else if (slot === "comment") emitComment(comment, lines, bodyIndent, tlink, b ?? null);
        else if (slot === "cardlinks") emitCardLinks(cardIds, ctx, lines, bodyIndent, note.ZNOTEID, tlink, b ?? null);
        first = false;
      }
    }
  }

  stats.noteCount += 1;
  for (const child of node.children) {
    renderMindmapNode(child, level + 1, lines, ctx, stats, forceList);
  }
}
