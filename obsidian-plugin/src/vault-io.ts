/**
 * vault 写盘工具：增量写入、图片 assets、孤儿清理。
 */

import { App, TFile, TFolder, Vault } from "obsidian";

export function assetsRelPath(folderDepth: number): string {
  const depth = Math.max(1, folderDepth);
  return `${"../".repeat(depth)}assets`;
}

/** 建目录；并发 / 大小写不敏感文件系统下 exists 与 createFolder 可能不一致，已存在时忽略。 */
async function ensureFolder(vault: Vault, dir: string): Promise<void> {
  if (await vault.adapter.exists(dir)) return;
  try {
    await vault.createFolder(dir);
  } catch (e) {
    if (!(await vault.adapter.exists(dir))) throw e;
  }
}

export async function writeImageAssets(
  vault: Vault,
  outRoot: string,
  imageBytes: Map<string, Buffer>,
  generatedAttachments: Set<string>,
  assetsRel = "../assets"
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (imageBytes.size === 0) return out;
  const assetsDir = `${outRoot}/assets`;
  const adapter = vault.adapter;
  await ensureFolder(vault, assetsDir);
  for (const [noteId, data] of imageBytes) {
    const ext = sniffImageExtension(data);
    const filename = `${noteId}.${ext}`;
    const absPath = `${assetsDir}/${filename}`;
    generatedAttachments.add(absPath);
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
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;
      await adapter.writeBinary(absPath, ab);
    }
    out.set(noteId, `${assetsRel}/${filename}`);
  }
  return out;
}

/** 查找 ``<outRoot>/assets/<stem>.<png|jpg|gif|webp>``，存在则返回文件名。 */
export async function findExistingAsset(
  vault: Vault,
  outRoot: string,
  stem: string
): Promise<string | null> {
  for (const ext of ["png", "jpg", "gif", "webp"]) {
    const filename = `${stem}.${ext}`;
    if (await vault.adapter.exists(`${outRoot}/assets/${filename}`)) return filename;
  }
  return null;
}

function sniffImageExtension(buf: Buffer): "png" | "jpg" | "gif" | "webp" {
  if (buf.length < 4) return "png";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF") return "webp";
  return "png";
}

export async function writeIfChanged(vault: Vault, path: string, content: string): Promise<boolean> {
  const adapter = vault.adapter;
  if (await adapter.exists(path)) {
    const old = await adapter.read(path);
    if (old === content) return false;
    await adapter.write(path, content);
    return true;
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) await ensureFolder(vault, path.slice(0, slash));
  await adapter.write(path, content);
  return true;
}

// 本插件 / Python CLI 生成的 md 在 frontmatter 里都带 doc_type: "marginnote-…"。
const MANAGED_MARKER_RE = /^doc_type:\s*"?marginnote-/m;
// assets 里由本工具生成的图片：<ZNOTEID>.<ext> 或 cover-<bookId>.<ext>（均以十六进制开头）。
const MANAGED_ASSET_RE = /^(cover-)?[0-9A-Fa-f]{8}[0-9A-Za-z_-]*\.(png|jpg|gif|webp)$/;

async function isManagedMd(vault: Vault, file: TFile): Promise<boolean> {
  let head: string;
  try {
    head = (await vault.cachedRead(file)).slice(0, 4096);
  } catch {
    return false;
  }
  if (!head.startsWith("---")) return false;
  const end = head.indexOf("\n---", 3);
  return MANAGED_MARKER_RE.test(end >= 0 ? head.slice(0, end) : head);
}

function collectFiles(folder: TFolder, out: TFile[]): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) collectFiles(child, out);
    else if (child instanceof TFile) out.push(child);
  }
}

/**
 * 清理孤儿：只扫描 ``outputDir`` 下指定的子目录（本次导出范围），md 只删带
 * ``doc_type: marginnote-*`` 标记的，assets 只删符合生成命名规则的图片；
 * 走 ``fileManager.trashFile``，遵循用户的"删除文件"偏好（默认进回收站）。
 */
export async function pruneOrphans(
  app: App,
  outputDir: string,
  subdirs: string[],
  kept: Set<string>
): Promise<number> {
  const vault = app.vault;
  let removed = 0;
  for (const sub of subdirs) {
    const base = vault.getAbstractFileByPath(`${outputDir}/${sub}`);
    if (!(base instanceof TFolder)) continue;
    const files: TFile[] = [];
    collectFiles(base, files);
    for (const f of files) {
      if (kept.has(f.path)) continue;
      const managed =
        sub === "assets"
          ? MANAGED_ASSET_RE.test(f.name)
          : f.extension === "md" && (await isManagedMd(vault, f));
      if (!managed) continue;
      await app.fileManager.trashFile(f);
      removed += 1;
    }

    const folders: TFolder[] = [];
    const collect = (f: TFolder) => {
      for (const c of f.children) if (c instanceof TFolder) collect(c);
      if (f !== base) folders.push(f);
    };
    collect(base);
    folders.sort((a, b) => b.path.length - a.path.length);
    for (const f of folders) {
      if (f.children.length === 0) {
        try {
          await vault.delete(f, true);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return removed;
}

// 文件系统单个文件名上限 255 字节；给 " (99).md" 后缀留余量。80 字中文 = 240 字节。
const MAX_STEM_BYTES = 240;

function capStemBytes(stem: string): string {
  const enc = new TextEncoder();
  if (enc.encode(stem).length <= MAX_STEM_BYTES) return stem;
  let out = "";
  let bytes = 0;
  for (const ch of stem) {
    const n = enc.encode(ch).length;
    if (bytes + n > MAX_STEM_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trimEnd() || "Untitled";
}

/**
 * 同目录内防撞名，返回可用相对路径。
 * macOS 默认文件系统大小写不敏感：``Foo.md`` 与 ``foo.md`` 是同一个文件，
 * 必须按小写比较，否则后写的一本会覆盖先写的一本。
 */
export function allocateMdPath(
  dir: string,
  stem: string,
  usedInDir: Set<string>,
  generatedPaths: Set<string>
): string {
  stem = capStemBytes(stem);
  const taken = new Set([...generatedPaths].map((p) => p.toLowerCase()));
  let filename = `${stem}.md`;
  let counter = 1;
  while (
    usedInDir.has(filename.toLowerCase()) ||
    taken.has(`${dir}/${filename}`.toLowerCase())
  ) {
    filename = `${stem} (${counter}).md`;
    counter += 1;
  }
  usedInDir.add(filename.toLowerCase());
  const filePath = `${dir}/${filename}`;
  generatedPaths.add(filePath);
  return filePath;
}
