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

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import bplistParser from "bplist-parser";
import type { Note, Topic } from "./types";

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

  constructor(public readonly dbPath: string) {
    if (!dbPath) throw new Error("MarginSync: 数据库路径未配置");
    // readonly + fileMustExist：不存在就立刻报错，避免 better-sqlite3 自动创建空库
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  /** 列出所有 Topic（笔记本）。 */
  listTopics(): Topic[] {
    // SQLite ZTOPIC 实际字段名是 ZLOCALBOOKMD5，单独 alias 成统一的 bookMd5
    // 字段以匹配 Topic 接口；ZBOOKLIST 暂未使用。
    const rows = this.db
      .prepare(
        `SELECT ZTOPICID, ZTITLE, ZLOCALBOOKMD5 AS bookMd5, ZMINDLINKS, ZDATE, ZLASTVISIT
         FROM ZTOPIC
         ORDER BY ZLASTVISIT DESC NULLS LAST, ZDATE DESC NULLS LAST`
      )
      .all() as Topic[];
    return rows.filter((r) => r.ZTOPICID && r.ZTITLE);
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
}

/** macOS 路径里的 ~ 展开（Node 不会自动做）。 */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, p.slice(2));
  }
  return p;
}
