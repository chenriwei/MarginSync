/**
 * 按 Topic 导出（思维导图树状渲染 + 子思维导图递归）。
 */

import type { MarginDb, AppVersion } from "./db";
import {
  cleanText,
  extractHashtags,
  isKept,
  nsDateToIso,
  renderFrontmatter,
  renderNoteWeread,
  sanitizeFilename,
} from "./render";
import { normalizeTag } from "./render-book";
import { renderMindmapNode } from "./render-mindmap";
import type { MarginSyncSettings } from "./settings";
import type { RenderContext, RenderStats, Topic } from "./types";
import { buildTree } from "./tree";
import type { ExportRunState } from "./export-book";
import { allocateMdPath, writeIfChanged, writeImageAssets } from "./vault-io";

function collectCardLabels(notes: ReturnType<MarginDb["fetchNotes"]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of notes) {
    if (!n.ZNOTEID) continue;
    const t = cleanText(n.ZNOTETITLE).trim();
    if (t) {
      map.set(n.ZNOTEID, t);
      continue;
    }
    const e = cleanText(n.ZHIGHLIGHT_TEXT).trim();
    if (e) map.set(n.ZNOTEID, e.split("\n")[0].trim().slice(0, 60));
  }
  return map;
}

function collectExcerptNorms(notes: ReturnType<MarginDb["fetchNotes"]>): Set<string> {
  const norms = new Set<string>();
  for (const n of notes) {
    const e = cleanText(n.ZHIGHLIGHT_TEXT).trim().replace(/\s+/g, "");
    if (e.length >= 12) norms.add(e);
  }
  return norms;
}

function collectTags(
  db: MarginDb,
  notes: ReturnType<MarginDb["fetchNotes"]>,
  bookMd5List: string[]
): string[] {
  const tagSet = new Set<string>();
  const catMap = db.loadBookCategories();
  for (const m of bookMd5List) {
    for (const cat of catMap.get(m) || []) {
      const norm = cat
        .split("/")
        .map((seg) => normalizeTag(seg))
        .filter(Boolean)
        .join("/");
      if (norm) tagSet.add(norm);
    }
  }
  const userTags = new Map<string, number>();
  for (const n of notes) {
    for (const t of extractHashtags(n.ZNOTES_TEXT)) {
      if (t.length < 2 || /^\d+$/.test(t)) continue;
      userTags.set(t, (userTags.get(t) || 0) + 1);
    }
  }
  for (const t of [...userTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k]) => k)) {
    const norm = normalizeTag(t);
    if (norm) tagSet.add(norm);
  }
  return [...tagSet].sort();
}

async function exportOneTopic(
  db: MarginDb,
  topic: Topic,
  appVer: AppVersion,
  settings: MarginSyncSettings,
  state: ExportRunState,
  parentTitles: string[],
  visited: Set<string>,
  useMindmapTree: boolean
): Promise<void> {
  if (visited.has(topic.ZTOPICID)) return;
  visited.add(topic.ZTOPICID);

  const title = topic.ZTITLE || "Untitled";
  const isMindmap = !!topic.ZMINDLINKS;
  const notes = db.fetchNotes(topic.ZTOPICID).filter((n) => isKept(n, settings.keepAiNodes));
  if (!notes.length) {
    state.skippedEmpty += 1;
    return;
  }

  const imageBytes = db.fetchMedia(notes);
  const imagePaths = await writeImageAssets(
    state.vault,
    state.outRoot,
    imageBytes,
    state.generatedAttachments
  );

  const ctx: RenderContext = {
    urlScheme: appVer.urlScheme,
    appName: appVer.appName,
    imageWidth: settings.imageWidth,
    excerptNorms: collectExcerptNorms(notes),
    cardLabels: collectCardLabels(notes),
    imagePaths,
  };

  const stats: RenderStats = { noteCount: 0, imageCount: 0, skippedAi: 0, skippedEmpty: 0 };
  const body: string[] = [];

  if (isMindmap && useMindmapTree) {
    const roots = buildTree(notes);
    const flatRoots =
      roots.length >= 4 && roots.every((r) => !r.children.length);
    for (const root of roots) {
      renderMindmapNode(root, 1, body, ctx, stats, flatRoots);
    }
  } else {
    const sorted = [...notes].sort((a, b) => {
      const pa = a.ZSTARTPAGE ?? 0;
      const pb = b.ZSTARTPAGE ?? 0;
      if (pa !== pb) return pa - pb;
      const sa = a.ZSTARTPOS || "";
      const sb = b.ZSTARTPOS || "";
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.ZNOTEID < b.ZNOTEID ? -1 : 1;
    });
    let lastPage: number | null = null;
    for (const n of sorted) {
      const p = n.ZSTARTPAGE ?? null;
      if (p != null && lastPage != null && p !== lastPage) {
        body.push("---", "");
      }
      renderNoteWeread(n, ctx, body, stats);
      if (p != null) lastPage = p;
    }
  }

  if (!body.some((l) => l.trim()) || stats.noteCount === 0) {
    state.skippedEmpty += 1;
    return;
  }

  const subdir = isMindmap ? "MindMaps" : "Books";
  const dir = `${state.outRoot}/${subdir}`;
  const stem = [...parentTitles, title].map((t) => sanitizeFilename(t)).join(" - ");
  const used = state.filenamesPerDir.get(dir) || new Set<string>();
  state.filenamesPerDir.set(dir, used);
  const filePath = allocateMdPath(dir, stem, used, state.generatedPaths);

  const bookMd5List: string[] = [];
  if (topic.ZBOOKLIST) {
    for (const m of topic.ZBOOKLIST.split("|")) if (m) bookMd5List.push(m);
  }
  for (const n of notes) {
    if (n.ZBOOKMD5 && !bookMd5List.includes(n.ZBOOKMD5)) bookMd5List.push(n.ZBOOKMD5);
  }
  const bookInfos = db.fetchBookInfos(bookMd5List);
  const bookTitles = [...bookInfos.values()].map((b) => b.title).filter(Boolean);
  const authors = [...new Set([...bookInfos.values()].map((b) => b.author).filter(Boolean))] as string[];

  let lastUpdateTs: number | null = null;
  for (const n of notes) {
    for (const ts of [n.ZNOTE_DATE, n.ZHIGHLIGHT_DATE]) {
      if (ts != null && (lastUpdateTs == null || ts > lastUpdateTs)) lastUpdateTs = ts;
    }
  }

  const headLines = isMindmap && useMindmapTree
    ? [
        `# ${title}`,
        "",
        "> [!info]+ 笔记本元信息",
        `> - 类型：🧠 思维导图`,
        bookTitles.length ? `> - 关联书籍：${bookTitles.map((t) => `《${t}》`).join("、")}` : "",
        authors.length ? `> - 作者：${authors.join("、")}` : "",
        `> - 笔记数：${stats.noteCount}（图片 ${stats.imageCount}）`,
        `> - MarginNote 链接：[在 ${appVer.appName} 中打开](${appVer.urlScheme}://notebook/${topic.ZTOPICID})`,
        "",
        "## 📝 笔记内容",
        "",
      ].filter((l) => l !== "")
    : [`# ${title}`, "", "# 高亮划线", ""];

  const fm = renderFrontmatter({
    doc_type: "marginnote-export",
    topicId: topic.ZTOPICID,
    title,
    type: isMindmap ? "mindmap" : "book",
    books: bookTitles.length ? bookTitles : undefined,
    authors: authors.length ? authors : undefined,
    noteCount: stats.noteCount,
    imageCount: stats.imageCount,
    created: nsDateToIso(topic.ZDATE),
    lastVisit: nsDateToIso(topic.ZLASTVISIT),
    lastNoteUpdate: nsDateToIso(lastUpdateTs),
    tags: collectTags(db, notes, bookMd5List),
    marginnote: `${appVer.urlScheme}://notebook/${topic.ZTOPICID}`,
    source: appVer.appName,
  });

  const content = `${fm}\n\n${headLines.join("\n")}${body.join("\n").replace(/\n+$/, "")}\n`;
  const changed = await writeIfChanged(state.vault, filePath, content);
  if (changed) state.written += 1;
  else state.unchanged += 1;

  if (!settings.recurseChildMindmaps || !isMindmap) return;

  const childIds = new Set<string>();
  for (const n of notes) {
    if (n.ZCHILDMAPNOTEID) childIds.add(n.ZCHILDMAPNOTEID);
  }
  for (const childId of childIds) {
    const child = db.getTopic(childId);
    if (!child) continue;
    await exportOneTopic(
      db,
      child,
      appVer,
      settings,
      state,
      [...parentTitles, title],
      visited,
      useMindmapTree
    );
  }
}

export async function exportTopics(
  db: MarginDb,
  topics: Topic[],
  appVer: AppVersion,
  settings: MarginSyncSettings,
  state: ExportRunState,
  options: { mindmapsOnly?: boolean; booksOnly?: boolean } = {}
): Promise<void> {
  const visited = new Set<string>();
  for (const topic of topics) {
    const isMindmap = !!topic.ZMINDLINKS;
    if (options.mindmapsOnly && !isMindmap) continue;
    if (options.booksOnly && isMindmap) continue;
    try {
      await exportOneTopic(
        db,
        topic,
        appVer,
        settings,
        state,
        [],
        visited,
        isMindmap
      );
    } catch (e) {
      console.error(`MarginSync: Topic《${topic.ZTITLE}》导出失败`, e);
    }
  }
}
