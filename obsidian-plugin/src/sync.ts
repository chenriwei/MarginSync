/**
 * 一次"同步"动作的主流程：
 *
 * 1. 打开 sqlite（只读）→ 列出 Topic
 * 2. 按 settings.scope 过滤（books / mindmaps / all）
 * 3. 对每个 Topic：fetch_notes → 渲染 markdown → 增量写入（内容相同则不动 mtime）
 * 4. 收集本次写入的相对路径集合，最后做孤儿清理
 *
 * 写盘走 Vault.adapter（通过 Obsidian 的文件 API），保证：
 *  - 文件创建/修改时间被 Obsidian 正确感知（"最近编辑"列表只在内容真变时刷新）
 *  - 子目录会自动创建
 */

import { App, Notice, TFile, TFolder, Vault, normalizePath } from "obsidian";
import { MarginDb, expandHome, detectAppVersion } from "./db";
import {
  cleanText,
  extractHashtags,
  isKept,
  nsDateToIso,
  renderFrontmatter,
  renderNoteWeread,
  sanitizeFilename,
} from "./render";
import type { MarginSyncSettings, SyncScope } from "./settings";
import type { Note, RenderContext, RenderStats, SyncResult, Topic } from "./types";

function topicScope(topic: Topic): "book" | "mindmap" {
  return topic.ZMINDLINKS ? "mindmap" : "book";
}

function filterByScope(topics: Topic[], scope: SyncScope): Topic[] {
  if (scope === "all") return topics;
  if (scope === "books") return topics.filter((t) => topicScope(t) === "book");
  return topics.filter((t) => topicScope(t) === "mindmap");
}

/** 收集本书所有 note 的 excerpt 归一化集合，供跨 note 去重使用。 */
function collectExcerptNorms(notes: Note[]): Set<string> {
  const norms = new Set<string>();
  for (const n of notes) {
    const e = cleanText(n.ZHIGHLIGHT_TEXT).trim();
    if (!e) continue;
    const norm = e.replace(/\s+/g, "");
    if (norm.length >= 12) norms.add(norm);
  }
  return norms;
}

/** 收集本 Topic 内 NoteID → 友好 label。用于卡片关联跳转的链接文案。 */
function collectCardLabels(notes: Note[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of notes) {
    if (!n.ZNOTEID) continue;
    const t = cleanText(n.ZNOTETITLE).trim();
    if (t) {
      map.set(n.ZNOTEID, t);
      continue;
    }
    const e = cleanText(n.ZHIGHLIGHT_TEXT).trim();
    if (e) {
      const firstLine = e.split("\n")[0].trim();
      map.set(n.ZNOTEID, firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine);
    }
  }
  return map;
}

/**
 * 把图片字节增量写入 ``<outRoot>/assets/<noteId>.<ext>``，返回 ``noteId → 相对当前 .md 的路径``。
 *
 * 命名约定与 Python 端 ``mn_export_tool.py`` 一致：用 noteId 作为文件名，下次同步时
 * 同名覆盖，配合 ``writeIfChanged`` 保留 mtime。markdown 里使用相对路径
 * ``../assets/<id>.png``，Obsidian 在 reader 模式能直接渲染。
 */
async function writeImageAssets(
  vault: Vault,
  outRoot: string,
  imageBytes: Map<string, Buffer>,
  generatedAttachments: Set<string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (imageBytes.size === 0) return out;
  const assetsDir = `${outRoot}/assets`;

  const adapter = vault.adapter;
  if (!(await adapter.exists(assetsDir))) {
    await vault.createFolder(assetsDir);
  }
  for (const [noteId, data] of imageBytes) {
    const ext = sniffImageExtension(data);
    const filename = `${noteId}.${ext}`;
    const absPath = `${assetsDir}/${filename}`;
    generatedAttachments.add(absPath);
    // Obsidian 的 adapter.writeBinary 增量比对：先读已有 binary，相等就不写
    let needWrite = true;
    if (await adapter.exists(absPath)) {
      try {
        const old = await adapter.readBinary(absPath);
        if (old.byteLength === data.byteLength && Buffer.from(old).equals(data)) {
          needWrite = false;
        }
      } catch {
        /* 读失败就重写 */
      }
    }
    if (needWrite) {
      // Obsidian writeBinary 需要 ArrayBuffer；Node Buffer 必须显式 slice 出独立的 ArrayBuffer
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      await adapter.writeBinary(absPath, ab);
    }
    out.set(noteId, `../assets/${filename}`);
  }
  return out;
}

function sniffImageExtension(buf: Buffer): "png" | "jpg" | "gif" | "webp" {
  if (buf.length < 4) return "png";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF") return "webp";
  return "png";
}

/** 增量写入：内容不变则不写盘，保留原 mtime。 */
async function writeIfChanged(vault: Vault, path: string, content: string): Promise<boolean> {
  const adapter = vault.adapter;
  if (await adapter.exists(path)) {
    const old = await adapter.read(path);
    if (old === content) return false;
    await adapter.write(path, content);
    return true;
  }
  // 父目录可能不存在，先建
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dir = path.slice(0, slash);
    if (!(await adapter.exists(dir))) {
      await vault.createFolder(dir);
    }
  }
  await adapter.write(path, content);
  return true;
}

/** 列出 outputDir 下所有受插件管理的文件路径（vault 相对）。
 *  受管文件 = 一切 ``.md``，加 ``assets/`` 子目录里的所有图片。其余文件（用户手动放的）一律不动。 */
async function listExistingManaged(vault: Vault, outputDir: string): Promise<string[]> {
  const results: string[] = [];
  const root = vault.getAbstractFileByPath(outputDir);
  if (!(root instanceof TFolder)) return results;
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        walk(child);
      } else if (child instanceof TFile) {
        const isMd = child.extension === "md";
        const inAssets = child.path.includes(`${outputDir}/assets/`);
        if (isMd || inAssets) results.push(child.path);
      }
    }
  };
  walk(root);
  return results;
}

/** 清理本次未生成的孤儿（.md / assets/ 图片），并 rmdir 变空的子目录。 */
async function pruneOrphans(
  vault: Vault,
  outputDir: string,
  kept: Set<string>
): Promise<number> {
  const existing = await listExistingManaged(vault, outputDir);
  let removed = 0;
  for (const p of existing) {
    if (kept.has(p)) continue;
    const f = vault.getAbstractFileByPath(p);
    if (f instanceof TFile) {
      await vault.delete(f);
      removed += 1;
    }
  }
  // 自下而上清空目录
  const root = vault.getAbstractFileByPath(outputDir);
  if (root instanceof TFolder) {
    const allFolders: TFolder[] = [];
    const collect = (f: TFolder) => {
      for (const c of f.children) if (c instanceof TFolder) collect(c);
      if (f.path !== outputDir) allFolders.push(f);
    };
    collect(root);
    // 子目录在前
    allFolders.sort((a, b) => b.path.length - a.path.length);
    for (const f of allFolders) {
      if (f.children.length === 0) {
        try {
          await vault.delete(f, true);
        } catch {
          /* 目录非空 / 被占用，忽略 */
        }
      }
    }
  }
  return removed;
}

export async function syncMarginNote(
  app: App,
  settings: MarginSyncSettings
): Promise<SyncResult> {
  const dbPath = expandHome(settings.databasePath);
  if (!dbPath) {
    new Notice("MarginSync: 请先在设置里填写 MarginNote 数据库路径");
    throw new Error("databasePath 未配置");
  }
  const appVer = detectAppVersion(dbPath);
  const db = new MarginDb(dbPath);
  const result: SyncResult = {
    written: 0,
    unchanged: 0,
    skippedEmpty: 0,
    prunedOrphans: 0,
    files: [],
  };

  try {
    const topics = filterByScope(db.listTopics(), settings.scope);
    if (!topics.length) {
      new Notice("MarginSync: 数据库里没有可同步的笔记本");
      return result;
    }

    const outRoot = normalizePath(settings.outputDir || "MarginSync");
    const generatedPaths = new Set<string>();
    /** 本次同步写到 vault 的图片绝对路径（vault 相对），用于孤儿清理时跳过。 */
    const generatedAttachments = new Set<string>();
    const generatedFilenamesPerDir = new Map<string, Set<string>>();

    for (const topic of topics) {
      const isMindmap = topicScope(topic) === "mindmap";
      const subdir = isMindmap ? "MindMaps" : "Books";
      const dir = `${outRoot}/${subdir}`;

      const notes = db.fetchNotes(topic.ZTOPICID).filter((n) => isKept(n, settings.keepAiNodes));
      if (!notes.length) continue;

      const stats: RenderStats = { noteCount: 0, imageCount: 0, skippedAi: 0, skippedEmpty: 0 };

      // 抓本书图片字节并落到 vault assets/，得到 noteId → 相对当前 .md 的路径
      // markdown 里 ../assets/<id>.png 即可在 Obsidian 内嵌
      const imageBytes = db.fetchMedia(notes);
      const imagePaths = await writeImageAssets(
        app.vault,
        outRoot,
        imageBytes,
        generatedAttachments
      );

      const ctx: RenderContext = {
        urlScheme: appVer.urlScheme,
        appName: appVer.appName,
        imageWidth: settings.imageWidth,
        excerptNorms: collectExcerptNorms(notes),
        cardLabels: collectCardLabels(notes),
        imagePaths,
      };

      // 对 notes 按 (page, startpos, noteid) 排序，保证跨进程稳定
      notes.sort((a, b) => {
        const pa = a.ZSTARTPAGE ?? 0;
        const pb = b.ZSTARTPAGE ?? 0;
        if (pa !== pb) return pa - pb;
        const sa = a.ZSTARTPOS || "";
        const sb = b.ZSTARTPOS || "";
        if (sa !== sb) return sa < sb ? -1 : 1;
        return a.ZNOTEID < b.ZNOTEID ? -1 : 1;
      });

      const body: string[] = [];
      let lastPage: number | null = null;
      for (const n of notes) {
        const p = n.ZSTARTPAGE ?? null;
        if (p != null && lastPage != null && p !== lastPage) {
          body.push("---");
          body.push("");
        }
        renderNoteWeread(n, ctx, body, stats);
        if (p != null) lastPage = p;
      }

      // 收集 hashtag → frontmatter
      const tagSet = new Set<string>();
      for (const n of notes) {
        for (const t of extractHashtags(n.ZNOTES_TEXT)) {
          if (t.length >= 2 && !/^\d+$/.test(t)) tagSet.add(t);
        }
      }

      // 仅当真有内容时才写盘（防空导出）
      const hasRealBody = body.some((l) => l.trim()) && stats.noteCount > 0;
      if (!hasRealBody) {
        result.skippedEmpty += 1;
        continue;
      }

      // 计算文件名（同次运行内防撞名）
      const filenameSet = generatedFilenamesPerDir.get(dir) ?? new Set<string>();
      generatedFilenamesPerDir.set(dir, filenameSet);
      const safeName = sanitizeFilename(topic.ZTITLE);
      let filename = `${safeName}.md`;
      let counter = 1;
      while (filenameSet.has(filename)) {
        filename = `${safeName} (${counter}).md`;
        counter += 1;
      }
      filenameSet.add(filename);

      const filePath = `${dir}/${filename}`;
      generatedPaths.add(filePath);

      // 时间戳
      let lastUpdateTs: number | null = null;
      for (const n of notes) {
        for (const ts of [n.ZNOTE_DATE, n.ZHIGHLIGHT_DATE]) {
          if (ts == null) continue;
          if (lastUpdateTs == null || ts > lastUpdateTs) lastUpdateTs = ts;
        }
      }

      const fm = renderFrontmatter({
        doc_type: "marginnote-export",
        topicId: topic.ZTOPICID,
        title: topic.ZTITLE,
        type: isMindmap ? "mindmap" : "book",
        noteCount: stats.noteCount,
        imageCount: stats.imageCount,
        created: nsDateToIso(topic.ZDATE),
        lastVisit: nsDateToIso(topic.ZLASTVISIT),
        lastNoteUpdate: nsDateToIso(lastUpdateTs),
        tags: [...tagSet].sort(),
        marginnote: `${appVer.urlScheme}://notebook/${topic.ZTOPICID}`,
        source: appVer.appName,
      });

      const content = `${fm}\n\n# ${topic.ZTITLE}\n\n# 高亮划线\n\n${body.join("\n").replace(/\n+$/, "")}\n`;
      const changed = await writeIfChanged(app.vault, filePath, content);
      if (changed) result.written += 1;
      else result.unchanged += 1;
      result.files.push(filePath);
    }

    if (settings.pruneOrphans) {
      const kept = new Set<string>([...generatedPaths, ...generatedAttachments]);
      result.prunedOrphans = await pruneOrphans(app.vault, outRoot, kept);
    }
  } finally {
    db.close();
  }

  return result;
}
