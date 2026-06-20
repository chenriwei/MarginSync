/**
 * MarginNote SQLite 数据访问层。
 *
 * 设计点：
 * - 用 better-sqlite3（同步 API），在 Electron 主线程内直接打开数据库。
 *   插件已声明 `isDesktopOnly: true`，不需要兼容 iOS 沙盒环境。
 * - 数据库以只读模式打开，避免误改 MarginNote 数据。
 * - 通过 ZTOPIC.ZMINDLINKS（Map URL Scheme `marginnote3app` / `marginnote4app`）
 *   推断 App 版本与 URL Scheme：mindmaps 表里有就用 mindmap，否则用 book。
 *   实际上我们用一个简化策略——按文件名或父目录判断，找不到就默认 4。
 */

import type Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import bplistParser from "bplist-parser";
import { openMarginDatabase } from "./native-sqlite";
import type { BookMeta, BookNoteRow, Note, Topic } from "./types";

const MNDOC_PATH_PREFIX = "$$$MNDOCLINK$$$";
const CATEGORY_PREFIX = /^\$\$\$CATEGORY\d+\$\$\$/;
const FILE_EXT_RE = /\.(pdf|epub|mobi|txt|docx?|mp4|pptx?|html?)$/i;

// ---------- 图片字节工具 ----------

const IMAGE_MAGIC: Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from("GIF8"),
  Buffer.from("RIFF"), // WebP
];

function looksLikeImage(buf: Buffer | null): boolean {
  if (!buf || buf.length < 32) return false;
  return IMAGE_MAGIC.some((m) => buf.subarray(0, m.length).equals(m));
}

function isBplist(buf: Buffer | null): boolean {
  if (!buf || buf.length < 8) return false;
  return buf.toString("ascii", 0, 6) === "bplist";
}

/** 取 bplist UID 的整数值。bplist-parser 把 NSKeyedArchiver UID 表示成 `{UID: n}` 对象。 */
function uidValue(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (x && typeof x === "object" && "UID" in x) {
    const v = (x as { UID: unknown }).UID;
    if (typeof v === "number") return v;
  }
  return null;
}

/**
 * 从 ``ZHIGHLIGHT_PIC`` 的 NSKeyedArchiver bplist 包裹中取出 ``paint`` 字段对应的 MD5 hash。
 *
 * 算法（对应 Python 端 ``extract_paint_hash``）：
 * 1. 在 ``$objects`` 数组里找到字符串 ``"paint"`` 的下标 paintIdx。
 * 2. 遍历 ``$objects`` 找到含 ``NS.keys`` + ``NS.objects`` 的 NSDictionary 对象。
 * 3. 在 ``NS.keys`` 中定位 UID == paintIdx 的项，取对应 ``NS.objects`` 项的 UID。
 * 4. ``$objects[uid]`` 即为字符串形式的 paint hash。
 */
export function extractPaintHash(blob: Buffer | null): string | null {
  if (!isBplist(blob) || !blob) return null;
  let parsed: { $objects?: unknown[] } | null = null;
  try {
    const result = bplistParser.parseBuffer(blob) as unknown[];
    parsed = (result?.[0] ?? null) as { $objects?: unknown[] } | null;
  } catch {
    return null;
  }
  const objects = parsed?.$objects;
  if (!Array.isArray(objects)) return null;

  let paintIdx = -1;
  for (let i = 0; i < objects.length; i++) {
    if (objects[i] === "paint") {
      paintIdx = i;
      break;
    }
  }
  if (paintIdx < 0) return null;

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    const dict = obj as Record<string, unknown>;
    const keys = dict["NS.keys"];
    const vals = dict["NS.objects"];
    if (!Array.isArray(keys) || !Array.isArray(vals)) continue;
    for (let i = 0; i < keys.length; i++) {
      const k = uidValue(keys[i]);
      if (k !== paintIdx) continue;
      const v = uidValue(vals[i]);
      if (v == null) continue;
      const target = objects[v];
      if (typeof target === "string") return target;
    }
  }
  return null;
}

/**
 * 把 ZMEDIA.ZDATA / ZHIGHLIGHT_PIC 中可能被 NSKeyedArchiver 包了一层的图片解包。
 *
 * 常见两种结构：
 * 1. ``$objects`` 里有一个直接的 ``Buffer``（旧格式）。
 * 2. ``$objects[i]`` 是 ``{ "NS.data": <Buffer>, "$class": <UID> }``（NSData 归档）。
 */
export function unwrapMediaData(buf: Buffer | null): Buffer | null {
  if (!buf || buf.length < 8) return null;
  if (looksLikeImage(buf)) return buf;
  if (!isBplist(buf)) return null;
  try {
    const result = bplistParser.parseBuffer(buf) as unknown[];
    const parsed = (result?.[0] ?? null) as { $objects?: unknown[] } | null;
    const objects = parsed?.$objects;
    if (!Array.isArray(objects)) return null;
    for (const obj of objects) {
      if (Buffer.isBuffer(obj) && looksLikeImage(obj)) return obj;
      if (obj && typeof obj === "object" && "NS.data" in obj) {
        const d = (obj as { "NS.data": unknown })["NS.data"];
        if (Buffer.isBuffer(d) && looksLikeImage(d)) return d;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export type AppVersion = {
  appName: "MarginNote 3" | "MarginNote 4";
  urlScheme: "marginnote3app" | "marginnote4app";
};

/**
 * 根据 sqlite 文件路径里的 Container 名推断 App 版本（macOS 沙盒约定）。
 *
 * MarginNote 4：QReader.MarginStudy.easy / MN4NotebookDatabase  → marginnote4app
 * MarginNote 3：QReader.MarginStudy.RealPro / MarginStudy（旧）   → marginnote3app
 *
 * 找不到匹配的兜底为 MarginNote 4，因为 4 是当前主流。
 */
export function detectAppVersion(dbPath: string): AppVersion {
  const lower = dbPath.toLowerCase();
  if (lower.includes("mn4notebookdatabase") || lower.includes("marginstudy.easy")) {
    return { appName: "MarginNote 4", urlScheme: "marginnote4app" };
  }
  if (lower.includes("marginstudy.realpro") || /marginnotes_default_3\.0/.test(lower)) {
    return { appName: "MarginNote 3", urlScheme: "marginnote3app" };
  }
  return { appName: "MarginNote 4", urlScheme: "marginnote4app" };
}

export class MarginDb {
  private db: Database.Database;

  /**
   * @param pluginDir Obsidian 插件目录绝对路径；传 null 时走 dev 模式（node_modules）。
   */
  constructor(public readonly dbPath: string, pluginDir: string | null) {
    if (!dbPath) throw new Error("MarginSync: 数据库路径未配置");
    this.db = openMarginDatabase(pluginDir, dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 列出所有 Topic（笔记本）。 */
  listTopics(): Topic[] {
    const rows = this.db
      .prepare(
        `SELECT ZTOPICID, ZTITLE, ZLOCALBOOKMD5 AS bookMd5, ZMINDLINKS, ZBOOKLIST, ZDATE, ZLASTVISIT
         FROM ZTOPIC
         ORDER BY ZLASTVISIT DESC NULLS LAST, ZDATE DESC NULLS LAST`
      )
      .all() as Topic[];
    return rows.filter((r) => r.ZTOPICID && r.ZTITLE);
  }

  getTopic(topicId: string): Topic | null {
    const row = this.db
      .prepare(
        `SELECT ZTOPICID, ZTITLE, ZLOCALBOOKMD5 AS bookMd5, ZMINDLINKS, ZBOOKLIST, ZDATE, ZLASTVISIT
         FROM ZTOPIC WHERE ZTOPICID = ?`
      )
      .get(topicId) as Topic | undefined;
    return row?.ZTOPICID ? row : null;
  }

  /** 抓某个 Topic 下的所有 ZBOOKNOTE（含从 ZMINDLINKS 跟踪到的层级链接）。 */
  fetchNotes(topicId: string): Note[] {
    // 1. 收集 seed ids：ZTOPIC.ZMINDLINKS（mindmap 顶层 chain）+ ZBOOKNOTE.ZTOPICID 直属
    const topicRow = this.db
      .prepare("SELECT ZMINDLINKS FROM ZTOPIC WHERE ZTOPICID = ?")
      .get(topicId) as { ZMINDLINKS: string | null } | undefined;
    const seedIds = new Set<string>();
    if (topicRow?.ZMINDLINKS) {
      for (const id of topicRow.ZMINDLINKS.split("|")) {
        if (id) seedIds.add(id);
      }
    }
    const directRows = this.db
      .prepare("SELECT ZNOTEID FROM ZBOOKNOTE WHERE ZTOPICID = ?")
      .all(topicId) as { ZNOTEID: string | null }[];
    for (const r of directRows) {
      if (r.ZNOTEID) seedIds.add(r.ZNOTEID);
    }

    // 2. 跟着 ZMINDLINKS 递归扩展，注意防环
    const seen = new Set<string>();
    const notes: Note[] = [];
    const pending = new Set(seedIds);
    while (pending.size > 0) {
      // 注意：必须 sort 后取，避免 Set 迭代顺序漂移导致输出节序变 → 文件被
      // 反复重写（mtime 失效）。和 Python 端 fetch_notes 的修复对应。
      const batch = [...pending].sort().slice(0, 500);
      for (const id of batch) pending.delete(id);

      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `SELECT ZNOTEID, ZNOTETITLE, ZHIGHLIGHT_TEXT, ZNOTES_TEXT,
                ZMINDLINKS, ZHIGHLIGHT_PIC, ZTYPE, ZSTARTPAGE, ZSTARTPOS,
                ZHIGHLIGHT_DATE, ZNOTE_DATE, ZBOOKMD5, ZTOPICID, ZCHILDMAPNOTEID
         FROM ZBOOKNOTE
         WHERE ZNOTEID IN (${placeholders})`
      );
      const rows = stmt.all(...batch) as Note[];
      for (const note of rows) {
        if (!note.ZNOTEID || seen.has(note.ZNOTEID)) continue;
        seen.add(note.ZNOTEID);
        notes.push(note);
        if (note.ZMINDLINKS) {
          for (const child of note.ZMINDLINKS.split("|")) {
            if (child && !seen.has(child)) pending.add(child);
          }
        }
      }
    }
    return notes;
  }

  /**
   * 抓 notes 中所有图片字节，返回 ``noteId → Buffer`` 映射。
   *
   * MarginNote 4 把大图外置到 sqlite 同目录的 sidecar 文件夹
   * ``<db>.sqlite.files/<hash>``，``ZMEDIA.ZDATA`` 改成 NULL。这里两条路径
   * 并用：先批量查 sqlite，对没拿到字节的 hash 再 fallback 到文件系统。
   */
  fetchMedia(notes: Note[]): Map<string, Buffer> {
    const noteToHash = new Map<string, string>();
    const allHashes = new Set<string>();
    for (const n of notes) {
      if (!n.ZHIGHLIGHT_PIC) continue;
      const h = extractPaintHash(n.ZHIGHLIGHT_PIC);
      if (h) {
        noteToHash.set(n.ZNOTEID, h);
        allHashes.add(h);
      }
    }
    if (!allHashes.size) return new Map();

    const hashToData = new Map<string, Buffer>();
    const hashList = [...allHashes];
    for (let i = 0; i < hashList.length; i += 500) {
      const batch = hashList.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT ZMD5, ZDATA FROM ZMEDIA WHERE ZMD5 IN (${placeholders})`)
        .all(...batch) as { ZMD5: string; ZDATA: Buffer | null }[];
      for (const r of rows) {
        if (!r.ZDATA) continue;
        const unwrapped = unwrapMediaData(r.ZDATA);
        if (unwrapped) hashToData.set(r.ZMD5, unwrapped);
      }
    }

    // sidecar fallback：MN4 的图片可能根本没在 sqlite 里
    const sidecarDir = this.dbPath + ".files";
    let sidecarExists = false;
    try {
      sidecarExists = fs.statSync(sidecarDir).isDirectory();
    } catch {
      sidecarExists = false;
    }
    if (sidecarExists) {
      for (const h of allHashes) {
        if (hashToData.has(h)) continue;
        const p = path.join(sidecarDir, h);
        let data: Buffer | null = null;
        try {
          data = fs.readFileSync(p);
        } catch {
          continue;
        }
        if (!data || data.length === 0) continue;
        const unwrapped = looksLikeImage(data) ? data : unwrapMediaData(data);
        if (unwrapped && looksLikeImage(unwrapped)) hashToData.set(h, unwrapped);
      }
    }

    const result = new Map<string, Buffer>();
    for (const [nid, h] of noteToHash) {
      const d = hashToData.get(h);
      if (d) result.set(nid, d);
    }
    return result;
  }

  /** 按 ZBOOKMD5 列表抓取所有关联笔记（含 Topic 标题）。 */
  fetchNotesByMd5s(md5List: string[]): BookNoteRow[] {
    if (!md5List.length) return [];
    const placeholders = md5List.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT
            bn.ZNOTEID, bn.ZNOTETITLE, bn.ZHIGHLIGHT_TEXT, bn.ZNOTES_TEXT,
            bn.ZMINDLINKS, bn.ZHIGHLIGHT_PIC, bn.ZTYPE, bn.ZSTARTPAGE, bn.ZSTARTPOS,
            bn.ZTOPICID, bn.ZBOOKMD5,
            bn.ZHIGHLIGHT_DATE, bn.ZNOTE_DATE, bn.ZCHILDMAPNOTEID,
            t.ZTITLE AS topicTitle, t.ZMINDLINKS AS topicMindlinks
         FROM ZBOOKNOTE bn
         LEFT JOIN ZTOPIC t ON t.ZTOPICID = bn.ZTOPICID
         WHERE bn.ZBOOKMD5 IN (${placeholders})
         ORDER BY bn.ZTOPICID, bn.ZSTARTPAGE, bn.ZSTARTPOS, bn.ZNOTEID`
      )
      .all(...md5List) as BookNoteRow[];
    return rows;
  }

  /** MarginNote 书架分类：ZBOOKMD5LONG → ["祖先/父/自己", ...] */
  loadBookCategories(): Map<string, string[]> {
    const nameOf = new Map<string, string>();
    const parentOf = new Map<string, string>();
    const tagRows = this.db
      .prepare("SELECT ZTAGID, ZTAGNAME, ZTAGLINKS FROM ZBOOKTAG")
      .all() as { ZTAGID: string; ZTAGNAME: string | null; ZTAGLINKS: string | null }[];

    for (const r of tagRows) {
      const tid = r.ZTAGID;
      const raw = (r.ZTAGNAME || "").replace(CATEGORY_PREFIX, "").trim();
      nameOf.set(tid, raw);
      const links = (r.ZTAGLINKS || "").split("|").filter(Boolean);
      if (links.length) parentOf.set(tid, links[0]);
    }

    const pathOf = (tid: string): string => {
      const parts: string[] = [];
      let cur: string | undefined = tid;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const nm = nameOf.get(cur);
        if (nm) parts.unshift(nm);
        cur = parentOf.get(cur);
      }
      return parts.join("/");
    };

    const configRows = this.db
      .prepare(
        "SELECT ZMD5LONG, ZTAGLIST FROM ZBOOKCONFIG " +
          "WHERE ZMD5LONG IS NOT NULL AND ZTAGLIST IS NOT NULL AND ZTAGLIST != ''"
      )
      .all() as { ZMD5LONG: string; ZTAGLIST: string }[];

    const out = new Map<string, string[]>();
    for (const r of configRows) {
      const paths: string[] = [];
      for (const tid of r.ZTAGLIST.split("|")) {
        const t = tid.trim();
        if (!t || !nameOf.has(t)) continue;
        const p = pathOf(t);
        if (p && !paths.includes(p)) paths.push(p);
      }
      if (paths.length) out.set(r.ZMD5LONG, paths);
    }
    return out;
  }

  fetchBookInfos(md5List: string[]): Map<string, { title: string; author: string | null }> {
    const out = new Map<string, { title: string; author: string | null }>();
    if (!md5List.length) return out;
    for (let i = 0; i < md5List.length; i += 500) {
      const batch = md5List.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT ZMD5, ZMD5LONG, ZAUTHOR, ZFILE FROM ZBOOK
           WHERE ZMD5LONG IN (${ph}) OR ZMD5 IN (${ph})`
        )
        .all(...batch, ...batch) as {
        ZMD5: string;
        ZMD5LONG: string;
        ZAUTHOR: string | null;
        ZFILE: string | null;
      }[];
      for (const row of rows) {
        const title = (row.ZFILE || "").trim().replace(FILE_EXT_RE, "");
        const info = { title: title || "", author: (row.ZAUTHOR || "").trim() || null };
        if (row.ZMD5LONG) out.set(row.ZMD5LONG, info);
        if (row.ZMD5) out.set(row.ZMD5, info);
      }
    }
    return out;
  }

  /** 列出所有被笔记引用过的书（按 ZBOOKMD5 聚合）。 */
  listBooks(): BookMeta[] {
    const countRows = this.db
      .prepare(
        `SELECT ZBOOKMD5 AS md5, COUNT(*) AS noteCount
         FROM ZBOOKNOTE WHERE ZBOOKMD5 IS NOT NULL GROUP BY ZBOOKMD5`
      )
      .all() as { md5: string; noteCount: number }[];

    const md5Meta = new Map<string, BookMeta>();
    for (const r of countRows) {
      md5Meta.set(r.md5, {
        md5: r.md5,
        md5List: [r.md5],
        noteCount: r.noteCount,
        title: "",
        author: null,
        folder: "",
        categories: [],
        fallback: false,
      });
    }

    const bookCategories = this.loadBookCategories();
    for (const [md5, cats] of bookCategories) {
      const m = md5Meta.get(md5);
      if (m) m.categories = cats;
    }

    const md5List = [...md5Meta.keys()];
    if (md5List.length) {
      for (let i = 0; i < md5List.length; i += 500) {
        const batch = md5List.slice(i, i + 500);
        const ph = batch.map(() => "?").join(",");
        const rows = this.db
          .prepare(
            `SELECT ZMD5, ZMD5LONG, ZAUTHOR, ZFILE, ZPATH FROM ZBOOK
             WHERE ZMD5LONG IN (${ph}) OR ZMD5 IN (${ph})`
          )
          .all(...batch, ...batch) as {
          ZMD5: string;
          ZMD5LONG: string;
          ZAUTHOR: string | null;
          ZFILE: string | null;
          ZPATH: string | null;
        }[];
        for (const row of rows) {
          const key = md5Meta.has(row.ZMD5LONG) ? row.ZMD5LONG : row.ZMD5;
          const meta = md5Meta.get(key);
          if (!meta) continue;
          const title = (row.ZFILE || "").trim().replace(FILE_EXT_RE, "");
          meta.title = title || meta.title;
          meta.author = (row.ZAUTHOR || "").trim() || meta.author;
          meta.folder = parseBookFolder(row.ZPATH);
        }
      }
    }

    for (const [md5, meta] of md5Meta) {
      if (meta.title) {
        meta.fallback = false;
        continue;
      }
      const row = this.db
        .prepare(
          `SELECT t.ZTITLE, COUNT(*) AS n
           FROM ZBOOKNOTE bn JOIN ZTOPIC t ON t.ZTOPICID = bn.ZTOPICID
           WHERE bn.ZBOOKMD5 = ? GROUP BY t.ZTITLE ORDER BY n DESC LIMIT 1`
        )
        .get(md5) as { ZTITLE: string | null } | undefined;
      meta.title = row?.ZTITLE || "未知书籍";
      meta.fallback = true;
    }

    const titleCounts = new Map<string, number>();
    for (const meta of md5Meta.values()) {
      if (meta.fallback) {
        titleCounts.set(meta.title, (titleCounts.get(meta.title) || 0) + 1);
      }
    }

    const mergeBuckets = new Map<string, BookMeta>();
    const finalMetas: BookMeta[] = [];
    for (const meta of md5Meta.values()) {
      const shouldMerge =
        meta.fallback &&
        ((titleCounts.get(meta.title) || 0) > 1 || meta.title === "未知书籍");
      if (!shouldMerge) {
        finalMetas.push(meta);
        continue;
      }
      let bucket = mergeBuckets.get(meta.title);
      if (!bucket) {
        bucket = { ...meta, md5List: [...meta.md5List], categories: [...meta.categories] };
        mergeBuckets.set(meta.title, bucket);
        finalMetas.push(bucket);
      } else {
        for (const m of meta.md5List) {
          if (!bucket.md5List.includes(m)) bucket.md5List.push(m);
        }
        bucket.noteCount += meta.noteCount;
        for (const c of meta.categories) {
          if (!bucket.categories.includes(c)) bucket.categories.push(c);
        }
        if (!bucket.folder && meta.folder) bucket.folder = meta.folder;
        if (!bucket.author && meta.author) bucket.author = meta.author;
      }
    }

    return finalMetas.sort((a, b) => b.noteCount - a.noteCount);
  }
}

/** 解析 ZBOOK.ZPATH 为书架相对目录。 */
export function parseBookFolder(zpath: string | null | undefined): string {
  if (!zpath) return "";
  let p = zpath;
  if (p.startsWith(MNDOC_PATH_PREFIX)) {
    p = p.slice(MNDOC_PATH_PREFIX.length);
    const parts = p.split("/", 2);
    return (parts[1] || "").replace(/^\/+|\/+$/g, "");
  }
  return p.replace(/^\/+|\/+$/g, "");
}

/** 清理并规范化用户填入的数据库路径（去引号、展开 ~、合并异常空白）。 */
export function normalizeDatabasePath(p: string): string {
  let s = p.trim();
  if (!s) return s;

  for (;;) {
    const prev = s;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
    if (s === prev) break;
  }

  // 复制粘贴时夹带的引号会破坏路径解析（macOS 路径本身不含引号）
  s = s.replace(/["'`]/g, "");
  // 修复 "Library/     Private Documents" 这类断裂空白
  s = s.replace(/\s{2,}/g, " ");

  if (s.startsWith("~/")) {
    s = path.join(os.homedir(), s.slice(2));
  } else if (s === "~") {
    s = os.homedir();
  }

  return path.normalize(s);
}

/** @deprecated 请用 normalizeDatabasePath */
export function expandHome(p: string): string {
  return normalizeDatabasePath(p);
}
