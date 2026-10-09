/**
 * 书封面提取：与 weread frontmatter 的 ``cover`` 字段对齐。
 *
 * - 源文件路径：ZPATH（iCloud 容器标记）+ ZBOOKURL/ZFILE → iCloud 容器 Documents。
 * - PDF：系统自带 ``qlmanage`` 把首页渲染成 PNG（离线、无第三方依赖）。
 * - EPUB：EPUB 是 zip，Node 标准库没有 zip 读取，调用系统 ``/usr/bin/python3``
 *   从包内取内嵌封面。
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import type { BookSourceInfo } from "./db";

const execFileAsync = promisify(execFile);

const MNDOC_ICLOUD_PREFIX = "$$$MNDOCLINK$$$iCloud.QReader.MarginStudy.easy";
const ICLOUD_DOCS_DIR = path.join(
  os.homedir(),
  "Library/Mobile Documents/iCloud~QReader~MarginStudy~easy/Documents"
);
const COVER_SIZE = 600;

/** 把 ZBOOK 行解析成本机书源文件路径；非 iCloud 来源或文件未下载时返回 null。 */
export function resolveBookSourcePath(info: BookSourceInfo): string | null {
  const zpath = info.zpath;
  if (!zpath || !zpath.startsWith(MNDOC_ICLOUD_PREFIX)) return null;
  const name = info.zbookurl ? path.basename(info.zbookurl) : info.zfile;
  if (!name) return null;
  const sub = zpath.slice(MNDOC_ICLOUD_PREFIX.length).replace(/^\/+|\/+$/g, "");
  const p = path.join(ICLOUD_DOCS_DIR, sub, name);
  return isFile(p) ? p : null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** qlmanage 渲染 PDF 首页，输出文件名为 ``<原文件名>.png``。 */
async function extractPdfCover(src: string, tmp: string): Promise<Buffer | null> {
  try {
    await execFileAsync(
      "/usr/bin/qlmanage",
      ["-t", "-s", String(COVER_SIZE), "-o", tmp, src],
      { timeout: 30_000 }
    );
  } catch {
    return null;
  }
  const out = path.join(tmp, path.basename(src) + ".png");
  try {
    return fs.readFileSync(out);
  } catch {
    return null;
  }
}

// 缩进刻意保持普通字符串：python 侧用双引号，避免互相干扰。
const EPUB_SCRIPT = String.raw`
import sys, os, zipfile
from xml.etree import ElementTree as ET

src, outdir = sys.argv[1], sys.argv[2]
NS = "{http://www.idpf.org/2007/opf}"
try:
    with zipfile.ZipFile(src) as z:
        container = ET.fromstring(z.read("META-INF/container.xml"))
        opf_path = None
        for rf in container.iter():
            if rf.tag.endswith("}rootfile"):
                opf_path = rf.attrib.get("full-path")
                break
        assert opf_path
        opf_dir = os.path.dirname(opf_path)
        opf = ET.fromstring(z.read(opf_path))

        cover_id = None
        items = []
        for el in opf.iter():
            if el.tag == NS + "meta" and el.attrib.get("name") == "cover":
                cover_id = el.attrib.get("content")
            if el.tag == NS + "item":
                items.append((
                    el.attrib.get("id", ""),
                    el.attrib.get("href", ""),
                    el.attrib.get("media-type", ""),
                    el.attrib.get("properties", ""),
                ))

        href = None
        if cover_id:
            for iid, h, _mt, _pr in items:
                if iid == cover_id:
                    href = h
                    break
        if href is None:
            for _iid, h, _mt, pr in items:
                if "cover-image" in pr:
                    href = h
                    break
        if href is None:
            for _iid, h, mt, _pr in items:
                if mt.startswith("image/"):
                    href = h
                    break
        assert href

        data = z.read(os.path.normpath(os.path.join(opf_dir, href)))
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ext = "png"
        elif data[:3] == b"\xff\xd8\xff":
            ext = "jpg"
        elif data[:4] == b"GIF8":
            ext = "gif"
        elif data[:4] == b"RIFF":
            ext = "webp"
        else:
            ext = "jpg"
        out_path = os.path.join(outdir, "cover." + ext)
        with open(out_path, "wb") as f:
            f.write(data)
        print(out_path)
except Exception:
    sys.exit(1)
`;

async function extractEpubCover(src: string, tmp: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/python3",
      ["-c", EPUB_SCRIPT, src, tmp],
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }
    );
    const out = stdout.trim().split("\n").pop();
    if (!out) return null;
    return fs.readFileSync(out);
  } catch {
    return null;
  }
}

/** 从书源文件提取封面字节；找不到源文件 / 提取失败时返回 null。 */
export async function extractCover(info: BookSourceInfo): Promise<Buffer | null> {
  const src = resolveBookSourcePath(info);
  if (!src) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mncover-"));
  try {
    if (/\.pdf$/i.test(src)) return await extractPdfCover(src, tmp);
    if (/\.epub$/i.test(src)) return await extractEpubCover(src, tmp);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
