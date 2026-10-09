/**
 * --by-book 按书聚合导出。
 */

import { Vault } from "obsidian";
import { extractPaintHash, type MarginDb, type AppVersion, type BookSourceInfo } from "./db";
import { extractCover, resolveBookSourcePath } from "./cover";
import {
  emitExtrasPara,
  hasRealContent,
  normalizeTag,
  renderBookNodeWeread,
  renderFlatBookNote,
} from "./render-book";
import {
  cleanText,
  extractHashtags,
  isKept,
  nsDateToDate,
  nsDateToIso,
  renderFrontmatter,
  renderNoteWeread,
  sanitizeFilename,
} from "./render";
import type { MarginSyncSettings } from "./settings";
import type { BookMeta, BookNoteRow, Note, RenderContext, RenderStats } from "./types";
import {
  buildTree,
  filterTreeToBook,
  keyForBookNote,
  normalizeExcerpt,
  pruneEmptyBranches,
  walkTree,
  type TreeNode,
} from "./tree";
import {
  allocateMdPath,
  assetsRelPath,
  writeIfChanged,
  findExistingAsset,
  writeImageAssets,
} from "./vault-io";

export interface ExportRunState {
  vault: Vault;
  outRoot: string;
  generatedPaths: Set<string>;
  generatedAttachments: Set<string>;
  filenamesPerDir: Map<string, Set<string>>;
  written: number;
  unchanged: number;
  skippedEmpty: number;
  /** 导出抛异常的书 / 笔记本数；> 0 时跳过孤儿清理，避免误删它们上次导出的文件。 */
  failed: number;
}

function normComment(text: string | null | undefined): string {
  if (!text) return "";
  return cleanText(text).replace(/\s+/g, "");
}

function labelNorm(n: Note): string | null {
  return normalizeExcerpt(n.ZHIGHLIGHT_TEXT) || normalizeExcerpt(n.ZNOTETITLE);
}

/** 图片的身份标识：优先 paint hash，否则原始字节（base64）；无图返回 null。 */
function imageIdentity(blob: Buffer | null): string | null {
  if (!blob || !blob.length) return null;
  return extractPaintHash(blob) ?? blob.toString("base64");
}

/**
 * 与 Python _pick_book_source 一致：按 md5List 顺序取第一个本机可用书源作为
 * bookId 并尝试提取封面；没有可用书源时 bookId 取第一本的 ZMD5。
 *
 * assets 里已有 ``cover-<bookId>.*`` 时直接复用（返回 ``existing`` 文件名），
 * 不再每次同步都调 qlmanage / python3 重新渲染。
 */
export async function pickBookIdAndCover(
  vault: Vault,
  outRoot: string,
  md5List: string[],
  sourceInfos: Map<string, BookSourceInfo>
): Promise<{ bookId: string | null; cover: Buffer | null; existing: string | null }> {
  for (const key of md5List) {
    const info = sourceInfos.get(key);
    if (!info || !resolveBookSourcePath(info)) continue;
    const bookId = info.md5 || key;
    const existing = await findExistingAsset(vault, outRoot, `cover-${bookId}`);
    if (existing) return { bookId, cover: null, existing };
    let cover: Buffer | null = null;
    try {
      cover = await extractCover(info);
    } catch {
      cover = null;
    }
    return { bookId, cover, existing: null };
  }
  const first = md5List[0];
  if (first == null) return { bookId: null, cover: null, existing: null };
  return { bookId: sourceInfos.get(first)?.md5 || first, cover: null, existing: null };
}

export async function exportBook(
  db: MarginDb,
  bookMeta: BookMeta,
  appVer: AppVersion,
  settings: MarginSyncSettings,
  state: ExportRunState
): Promise<boolean> {
  const md5List = bookMeta.md5List;
  const md5Set = new Set(md5List);
  const title = bookMeta.title;
  const author = bookMeta.author;

  const rows = db.fetchNotesByMd5s(md5List).filter((r) => isKept(r, settings.keepAiNodes));
  if (!rows.length) {
    state.skippedEmpty += 1;
    return false;
  }

  const byTopic = new Map<string, BookNoteRow[]>();
  const topicMeta = new Map<string, { title: string; isMindmap: boolean }>();
  for (const r of rows) {
    const tid = r.ZTOPICID || "";
    if (!byTopic.has(tid)) byTopic.set(tid, []);
    byTopic.get(tid)!.push(r);
    if (!topicMeta.has(tid)) {
      topicMeta.set(tid, {
        title: r.topicTitle || "(无 Topic)",
        isMindmap: !!r.topicMindlinks,
      });
    }
  }

  const topicScore = (tid: string): [number, number, number, string] => {
    const ns = byTopic.get(tid) || [];
    const withLinks = ns.filter((r) => r.ZMINDLINKS).length;
    const meta = topicMeta.get(tid);
    return [withLinks, ns.length, meta?.isMindmap ? 1 : 0, tid];
  };

  // "" 是无 Topic 笔记的合法分组 key，不能当"尚未选出"的哨兵值。
  const mainTid = [...byTopic.keys()].reduce((best, tid) => {
    const sa = topicScore(tid);
    const sb = topicScore(best);
    for (let i = 0; i < 4; i++) {
      if (sa[i] !== sb[i]) return sa[i] > sb[i] ? tid : best;
    }
    return best;
  });

  const mainMeta = topicMeta.get(mainTid) || { title: "(无 Topic)", isMindmap: false };
  let roots: TreeNode[] = [];
  const mainKeys = new Map<string, Note>();

  if (mainTid) {
    const fullNotes = db.fetchNotes(mainTid).filter((n) => isKept(n, settings.keepAiNodes));
    roots = buildTree(fullNotes);
    roots = filterTreeToBook(roots, md5Set);
    roots = pruneEmptyBranches(roots);
    for (const tn of walkTree(roots)) {
      if (tn.note.ZBOOKMD5 && md5Set.has(tn.note.ZBOOKMD5)) {
        mainKeys.set(keyForBookNote(tn.note), tn.note);
      }
    }
  }

  if (!roots.length) {
    const flatNotes = (byTopic.get(mainTid) || []).filter((r) => hasRealContent(r));
    flatNotes.sort((a, b) => {
      const pa = a.ZSTARTPAGE ?? 0;
      const pb = b.ZSTARTPAGE ?? 0;
      if (pa !== pb) return pa - pb;
      return (a.ZSTARTPOS || "").localeCompare(b.ZSTARTPOS || "");
    });
    roots = flatNotes.map((n) => ({ note: n, children: [] }));
    for (const tn of roots) {
      if (tn.note.ZBOOKMD5 && md5Set.has(tn.note.ZBOOKMD5)) {
        mainKeys.set(keyForBookNote(tn.note), tn.note);
      }
    }
  }

  const extraPerNode = new Map<string, [string, string][]>();
  const standalone: [string, BookNoteRow][] = [];
  const mainKeysLoose = new Map<string, Note>();

  for (const tn of walkTree(roots)) {
    const n = tn.note;
    if (!n.ZBOOKMD5 || !md5Set.has(n.ZBOOKMD5)) continue;
    const label = labelNorm(n);
    if (!label) continue;
    const page = n.ZSTARTPAGE ?? 0;
    const looseKey = JSON.stringify([page, label]);
    if (!mainKeysLoose.has(looseKey)) mainKeysLoose.set(looseKey, n);
  }

  for (const [tid, ns] of byTopic) {
    if (tid === mainTid) continue;
    const ttitle = topicMeta.get(tid)?.title || "(无 Topic)";
    for (const r of ns) {
      const key = keyForBookNote(r);
      let primary = mainKeys.get(key);
      if (!primary) {
        const label = labelNorm(r);
        if (label) {
          primary = mainKeysLoose.get(JSON.stringify([r.ZSTARTPAGE ?? 0, label]));
        }
      }
      // 合并只搬运批注文本；补充 note 自带的图片与主节点不同时，合并会把图片
      // 丢掉，改走 standalone 完整渲染。
      if (primary && r.ZNOTEID !== primary.ZNOTEID) {
        const img = imageIdentity(r.ZHIGHLIGHT_PIC);
        if (img != null && img !== imageIdentity(primary.ZHIGHLIGHT_PIC)) {
          standalone.push([ttitle, r]);
          continue;
        }
      }
      if (primary) {
        if (!r.ZNOTES_TEXT) continue;
        if (r.ZNOTEID === primary.ZNOTEID) continue;
        if (normComment(r.ZNOTES_TEXT) === normComment(primary.ZNOTES_TEXT)) continue;
        const bucket = extraPerNode.get(primary.ZNOTEID) || [];
        const norm = normComment(r.ZNOTES_TEXT);
        if (norm && bucket.some(([, prev]) => normComment(prev) === norm)) continue;
        bucket.push([ttitle, r.ZNOTES_TEXT]);
        extraPerNode.set(primary.ZNOTEID, bucket);
      } else {
        if (!hasRealContent(r)) continue;
        standalone.push([ttitle, r]);
      }
    }
  }

  const allImageNotes: Note[] = [...walkTree(roots)].map((tn) => tn.note);
  for (const [, r] of standalone) allImageNotes.push(r);
  const imageBytes = db.fetchMedia(allImageNotes);

  // ---- weread 对齐字段的数据收集（源文件 / 进度 / 访问时间 / 封面）----
  const sourceInfos = db.fetchBookSources(md5List);
  const bookConfigs = db.fetchBookConfigs(md5List);

  // 按 md5List 顺序找第一个本机可用书源 → 提取封面，随笔记图片一起写 assets。
  const picked = await pickBookIdAndCover(state.vault, state.outRoot, md5List, sourceInfos);
  const bookId = picked.bookId;
  let coverKey: string | null = null;
  if (picked.cover && bookId) {
    coverKey = `cover-${bookId}`;
    imageBytes.set(coverKey, picked.cover);
  }

  // progress：多 md5 取最大进度；无记录时为 null。
  let progressPct: number | null = null;
  for (const key of md5List) {
    const v = bookConfigs.get(key);
    if (v != null && (progressPct == null || v > progressPct)) progressPct = v;
  }

  const topicVisits = db.fetchTopicVisits([...byTopic.keys()]);
  let lastVisitTs: number | null = null;
  for (const v of topicVisits.values()) {
    if (v != null && (lastVisitTs == null || v > lastVisitTs)) lastVisitTs = v;
  }

  // 本书最早 / 最晚笔记时间
  let earliestTs: number | null = null;
  let latestTs: number | null = null;
  for (const r of rows) {
    for (const ts of [r.ZNOTE_DATE, r.ZHIGHLIGHT_DATE]) {
      if (ts == null) continue;
      if (earliestTs == null || ts < earliestTs) earliestTs = ts;
      if (latestTs == null || ts > latestTs) latestTs = ts;
    }
  }

  const folderRel = settings.folderGrouping ? bookMeta.folder || "" : "";
  const folderSegs = folderRel.split("/").filter((s) => s.trim()).map((s) => sanitizeFilename(s));
  const outDir = [state.outRoot, "Books", ...folderSegs].join("/");
  const depth = 1 + folderSegs.length;
  const assetsRel = assetsRelPath(depth);

  const imagePaths = await writeImageAssets(
    state.vault,
    state.outRoot,
    imageBytes,
    state.generatedAttachments,
    assetsRel
  );
  let coverRel = coverKey ? imagePaths.get(coverKey) ?? null : null;
  if (picked.existing) {
    state.generatedAttachments.add(`${state.outRoot}/assets/${picked.existing}`);
    coverRel = `${assetsRel}/${picked.existing}`;
  }

  const cardLabels = new Map<string, string>();
  const excerptNorms = new Set<string>();
  for (const r of rows) {
    if (r.ZNOTEID) {
      const t = cleanText(r.ZNOTETITLE).trim();
      if (t) cardLabels.set(r.ZNOTEID, t);
      else {
        const e = cleanText(r.ZHIGHLIGHT_TEXT).trim().split("\n")[0];
        if (e) cardLabels.set(r.ZNOTEID, e.slice(0, 60));
      }
    }
    const e = cleanText(r.ZHIGHLIGHT_TEXT).trim().replace(/\s+/g, "");
    if (e.length >= 12) excerptNorms.add(e);
  }

  const ctx: RenderContext = {
    urlScheme: appVer.urlScheme,
    appName: appVer.appName,
    imageWidth: settings.imageWidth,
    excerptNorms,
    cardLabels,
    imagePaths,
  };

  const stats: RenderStats = { noteCount: 0, imageCount: 0, skippedAi: 0, skippedEmpty: 0 };
  const mainBody: string[] = [];
  const isFlatBook = roots.length > 0 && roots.every((r) => !r.children.length);

  if (isFlatBook) {
    let lastPage: number | null = null;
    for (const root of roots) {
      const n = root.note;
      const p = n.ZSTARTPAGE ?? null;
      if (p != null && lastPage != null && p !== lastPage) {
        mainBody.push("---", "");
      }
      lastPage = p;
      renderFlatBookNote(n, ctx, mainBody, stats, extraPerNode);
    }
  } else {
    for (const root of roots) {
      renderBookNodeWeread(root, 1, mainBody, ctx, stats, extraPerNode);
    }
  }

  const standaloneBody: string[] = [];
  if (standalone.length) {
    const byOther = new Map<string, BookNoteRow[]>();
    for (const [ttitle, r] of standalone) {
      if (!byOther.has(ttitle)) byOther.set(ttitle, []);
      byOther.get(ttitle)!.push(r);
    }
    for (const ttitle of [...byOther.keys()].sort()) {
      standaloneBody.push(`## 📍 ${ttitle}`, "");
      const ns = (byOther.get(ttitle) || []).sort((a, b) => {
        const pa = a.ZSTARTPAGE ?? 0;
        const pb = b.ZSTARTPAGE ?? 0;
        if (pa !== pb) return pa - pb;
        return (a.ZSTARTPOS || "").localeCompare(b.ZSTARTPOS || "");
      });
      for (const n of ns) {
        renderNoteWeread(n, ctx, standaloneBody, stats);
        emitExtrasPara(n.ZNOTEID, extraPerNode, ctx, standaloneBody);
      }
    }
  }

  if (!mainBody.some((l) => l.trim()) && stats.noteCount === 0) {
    state.skippedEmpty += 1;
    return false;
  }

  const dirKey = outDir;
  const used = state.filenamesPerDir.get(dirKey) || new Set<string>();
  state.filenamesPerDir.set(dirKey, used);
  const filePath = allocateMdPath(outDir, sanitizeFilename(title), used, state.generatedPaths);

  let lastUpdateTs: number | null = null;
  for (const r of rows) {
    for (const ts of [r.ZNOTE_DATE, r.ZHIGHLIGHT_DATE]) {
      if (ts != null && (lastUpdateTs == null || ts > lastUpdateTs)) lastUpdateTs = ts;
    }
  }

  const tagSet = new Set<string>();
  for (const cat of bookMeta.categories) {
    const norm = cat
      .split("/")
      .map((seg) => normalizeTag(seg))
      .filter(Boolean)
      .join("/");
    if (norm) tagSet.add(norm);
  }
  const userTags = new Map<string, number>();
  for (const r of rows) {
    for (const t of extractHashtags(r.ZNOTES_TEXT)) {
      if (t.length < 2 || /^\d+$/.test(t)) continue;
      userTags.set(t, (userTags.get(t) || 0) + 1);
    }
  }
  for (const t of [...userTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k]) => k)) {
    const norm = normalizeTag(t);
    if (norm) tagSet.add(norm);
  }

  const allSources = new Set<string>([mainMeta.title]);
  for (const tid of byTopic.keys()) {
    if (tid === mainTid) continue;
    const m = topicMeta.get(tid);
    if (m) allSources.add(m.title);
  }

  const reviewCount = rows.filter((r) => cleanText(r.ZNOTES_TEXT).trim()).length;
  const isMerged = md5List.length > 1;

  const lastReadDate = nsDateToDate(lastVisitTs ?? latestTs);
  const readingStatus =
    progressPct == null ? undefined : progressPct >= 0.99 ? "2" : "1";

  // 字段顺序对齐 weread 导出，便于统一看板混排；MN 专有字段放最后。
  const fm: Record<string, unknown> = {
    doc_type: "marginnote-highlights-reviews",
    bookId,
    reviewCount,
    noteCount: stats.noteCount,
  };
  if (author) fm.author = author;
  if (coverRel) fm.cover = coverRel;
  fm.progress =
    progressPct == null ? "-1" : `${Math.min(100, Math.round(progressPct * 100))}%`;
  const readingDate = nsDateToDate(earliestTs);
  if (readingDate) fm.readingDate = readingDate;
  if (lastReadDate) fm.lastReadDate = lastReadDate;
  fm.title = title;
  if (readingStatus) fm.readingStatus = readingStatus;

  // --- MN 专有字段 ---
  fm.bookMd5 = isMerged ? md5List : md5List[0];
  if (isMerged) fm.mergedBooks = md5List.length;
  fm.imageCount = stats.imageCount;
  fm.sourceTopics = [...allSources].sort();
  fm.primaryTopic = mainMeta.title;
  fm.lastNoteUpdate = nsDateToIso(lastUpdateTs);
  fm.tags = [...tagSet].sort();
  fm.marginnote = mainTid ? `${appVer.urlScheme}://notebook/${mainTid}` : undefined;
  fm.source = appVer.appName;

  const bodyLines: string[] = [];
  if (mainBody.some((l) => l.trim())) {
    bodyLines.push("# 高亮划线", "", ...mainBody);
  }
  if (standaloneBody.length) {
    if (bodyLines.length) bodyLines.push("");
    bodyLines.push("# 其它 Topic 的补充笔记", "", ...standaloneBody);
  }

  const content =
    `${renderFrontmatter(fm)}\n\n# ${title}\n\n${bodyLines.join("\n").replace(/\n+$/, "")}\n`;
  const changed = await writeIfChanged(state.vault, filePath, content);
  if (changed) state.written += 1;
  else state.unchanged += 1;
  return true;
}

export async function exportAllBooks(
  db: MarginDb,
  appVer: AppVersion,
  settings: MarginSyncSettings,
  state: ExportRunState
): Promise<void> {
  const books = db.listBooks();
  if (!books.length) return;
  // 按 md5 稳定排序：同名书的 (1)/(2) 后缀不随笔记数变化而互换。
  books.sort((a, b) => (a.md5List[0] < b.md5List[0] ? -1 : a.md5List[0] > b.md5List[0] ? 1 : 0));
  for (const meta of books) {
    if (!settings.folderGrouping) meta.folder = "";
    try {
      await exportBook(db, meta, appVer, settings, state);
    } catch (e) {
      state.failed += 1;
      console.error(`MarginSync: 《${meta.title}》导出失败`, e);
    }
  }
}
