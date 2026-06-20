/**
 * vault 写盘工具：增量写入、图片 assets、孤儿清理。
 */

import { TFile, TFolder, Vault } from "obsidian";

export function assetsRelPath(folderDepth: number): string {
  const depth = Math.max(1, folderDepth);
  return `${"../".repeat(depth)}assets`;
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
  if (!(await adapter.exists(assetsDir))) {
    await vault.createFolder(assetsDir);
  }
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
  if (slash > 0) {
    const dir = path.slice(0, slash);
    if (!(await adapter.exists(dir))) {
      await vault.createFolder(dir);
    }
  }
  await adapter.write(path, content);
  return true;
}

export async function listExistingManaged(vault: Vault, outputDir: string): Promise<string[]> {
  const results: string[] = [];
  const root = vault.getAbstractFileByPath(outputDir);
  if (!(root instanceof TFolder)) return results;
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile) {
        const isMd = child.extension === "md";
        const inAssets = child.path.includes(`${outputDir}/assets/`);
        if (isMd || inAssets) results.push(child.path);
      }
    }
  };
  walk(root);
  return results;
}

export async function pruneOrphans(
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
  const root = vault.getAbstractFileByPath(outputDir);
  if (root instanceof TFolder) {
    const allFolders: TFolder[] = [];
    const collect = (f: TFolder) => {
      for (const c of f.children) if (c instanceof TFolder) collect(c);
      if (f.path !== outputDir) allFolders.push(f);
    };
    collect(root);
    allFolders.sort((a, b) => b.path.length - a.path.length);
    for (const f of allFolders) {
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

/** 同目录内防撞名，返回可用相对路径。 */
export function allocateMdPath(
  dir: string,
  stem: string,
  usedInDir: Set<string>,
  generatedPaths: Set<string>
): string {
  let filename = `${stem}.md`;
  let counter = 1;
  while (usedInDir.has(filename) || generatedPaths.has(`${dir}/${filename}`)) {
    filename = `${stem} (${counter}).md`;
    counter += 1;
  }
  usedInDir.add(filename);
  const filePath = `${dir}/${filename}`;
  generatedPaths.add(filePath);
  return filePath;
}
