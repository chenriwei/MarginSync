/**
 * 一次同步的主流程：按设置选择 by-book / by-topic，写盘后孤儿清理。
 */

import { App, FileSystemAdapter, Notice, normalizePath } from "obsidian";
import * as path from "path";
import { MarginDb, normalizeDatabasePath, detectAppVersion } from "./db";
import { exportAllBooks } from "./export-book";
import { exportTopics } from "./export-topic";
import type { MarginSyncSettings } from "./settings";
import type { SyncResult } from "./types";
import { pruneOrphans } from "./vault-io";

export function resolvePluginDir(app: App, pluginDirRel: string): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("MarginSync: 需要本地 vault（文件系统适配器）。");
  }
  return path.join(adapter.getBasePath(), pluginDirRel);
}

export async function syncMarginNote(
  app: App,
  settings: MarginSyncSettings,
  pluginDirRel: string
): Promise<SyncResult> {
  const dbPath = normalizeDatabasePath(settings.databasePath);
  if (!dbPath) {
    new Notice("MarginSync: 请先在设置里填写 MarginNote 数据库路径");
    throw new Error("databasePath 未配置");
  }
  const pluginDir = resolvePluginDir(app, pluginDirRel);
  const appVer = detectAppVersion(dbPath);
  const db = new MarginDb(dbPath, pluginDir);

  const result: SyncResult = {
    written: 0,
    unchanged: 0,
    skippedEmpty: 0,
    prunedOrphans: 0,
    files: [],
  };

  try {
    const outRoot = normalizePath(settings.outputDir || "MarginSync");
    const generatedPaths = new Set<string>();
    const generatedAttachments = new Set<string>();
    const filenamesPerDir = new Map<string, Set<string>>();

    const state = {
      vault: app.vault,
      outRoot,
      generatedPaths,
      generatedAttachments,
      filenamesPerDir,
      written: 0,
      unchanged: 0,
      skippedEmpty: 0,
    };

    const scope = settings.scope;

    const exportBooksByBook =
      settings.bookExportMode === "by-book" && (scope === "all" || scope === "books");

    const exportBookTopics =
      settings.bookExportMode === "by-topic" && (scope === "all" || scope === "books");

    const exportMindmapTopics = scope === "all" || scope === "mindmaps";

    if (exportBooksByBook) {
      await exportAllBooks(db, appVer, settings, state);
    }

    if (exportBookTopics) {
      const bookTopics = db.listTopics().filter((t) => !t.ZMINDLINKS);
      await exportTopics(db, bookTopics, appVer, settings, state, { booksOnly: true });
    }

    if (exportMindmapTopics) {
      const mindTopics = db.listTopics().filter((t) => !!t.ZMINDLINKS);
      await exportTopics(db, mindTopics, appVer, settings, state, { mindmapsOnly: true });
    }

    if (!exportBooksByBook && !exportBookTopics && !exportMindmapTopics) {
      new Notice("MarginSync: 当前设置下没有可导出的内容");
      return result;
    }

    result.written = state.written;
    result.unchanged = state.unchanged;
    result.skippedEmpty = state.skippedEmpty;
    result.files = [...generatedPaths];

    if (settings.pruneOrphans) {
      const kept = new Set<string>([...generatedPaths, ...generatedAttachments]);
      result.prunedOrphans = await pruneOrphans(app.vault, outRoot, kept);
    }
  } finally {
    db.close();
  }

  return result;
}
