/**
 * 在 Obsidian 运行时加载 better-sqlite3。
 *
 * 不能直接 require(.node) 里的 Database（那是 C++ 绑定，参数签名不同）；
 * 必须用 better-sqlite3 的 JS 包装层，并通过 nativeBinding 指向预编译 .node。
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { NATIVE_EMBED } from "./native-embed.generated";

function pickEmbeddedBase64(platformKey: string, nmv: string): string | null {
  const platformEmbeds = NATIVE_EMBED[platformKey];
  if (!platformEmbeds) return null;
  if (platformEmbeds[nmv]) return platformEmbeds[nmv];
  const available = Object.keys(platformEmbeds)
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const target = parseInt(nmv, 10);
  let best: string | null = null;
  for (const n of available) {
    if (n <= target) best = String(n);
  }
  if (best) return platformEmbeds[best];
  const fallback = available[available.length - 1];
  return fallback != null ? platformEmbeds[String(fallback)] : null;
}

/** 把嵌入的 .node 解压到插件目录，返回绝对路径。 */
function ensureNativeBinary(pluginDir: string): string {
  const platformKey = `${process.platform}-${process.arch}`;
  const nmv = process.versions.modules;
  const embedded = pickEmbeddedBase64(platformKey, nmv);
  if (!embedded) {
    const have = NATIVE_EMBED[platformKey]
      ? Object.keys(NATIVE_EMBED[platformKey]).join(", ")
      : "无";
    throw new Error(
      `MarginSync: 当前环境 ${platformKey} / NODE_MODULE_VERSION ${nmv} 无匹配预编译。` +
        `已有 ABI: ${have}。请升级插件或暂用 Python CLI。`
    );
  }

  const nativePath = path.join(pluginDir, `better_sqlite3.nmv${nmv}.node`);
  const data = Buffer.from(embedded, "base64");

  const legacyPath = path.join(pluginDir, "better_sqlite3.node");
  if (fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      /* ignore */
    }
  }

  let needWrite = true;
  if (fs.existsSync(nativePath)) {
    const existing = fs.readFileSync(nativePath);
    if (existing.length === data.length && existing.equals(data)) {
      needWrite = false;
    }
  }
  if (needWrite) {
    fs.writeFileSync(nativePath, data);
  }
  return nativePath;
}

/** 打开 MarginNote 数据库（只读）。 */
export function openMarginDatabase(
  pluginDir: string | null,
  dbPath: string
): DatabaseType {
  const options: { readonly: boolean; fileMustExist: boolean; nativeBinding?: string } = {
    readonly: true,
    fileMustExist: true,
  };
  if (pluginDir) {
    options.nativeBinding = ensureNativeBinary(pluginDir);
  }
  return new Database(dbPath, options);
}
