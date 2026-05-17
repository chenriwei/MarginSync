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
import type { Note, Topic } from "./types";

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
}

/** macOS 路径里的 ~ 展开（Node 不会自动做）。 */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, p.slice(2));
  }
  return p;
}
