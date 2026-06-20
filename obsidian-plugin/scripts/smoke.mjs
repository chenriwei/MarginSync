// 离线 smoke 测试：直接调 better-sqlite3 + render 函数，验证插件核心
// 在不启动 Obsidian 的情况下也能正确解析 MarginNotes.sqlite 并产出 markdown。
//
// 使用：node scripts/smoke.mjs <path-to-MarginNotes.sqlite>

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node scripts/smoke.mjs <MarginNotes.sqlite>");
  process.exit(1);
}

// 用 esbuild 把 src/render.ts + src/db.ts 编译成单一 cjs，便于 node 直接 require
const outDir = join(__dirname, ".smoke");
mkdirSync(outDir, { recursive: true });
const renderOut = join(outDir, "render.cjs");
const dbOut = join(outDir, "db.cjs");

await build({
  entryPoints: [join(__dirname, "..", "src", "render.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: renderOut,
  external: ["better-sqlite3", "bplist-parser"],
  logLevel: "warning",
});
await build({
  entryPoints: [join(__dirname, "..", "src", "db.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: dbOut,
  external: ["better-sqlite3", "bplist-parser"],
  logLevel: "warning",
});

const render = await import(renderOut);
const dbMod = await import(dbOut);

const db = new dbMod.MarginDb(dbPath, null);
const topics = db.listTopics();
console.log(`✓ 列出 Topic：${topics.length} 个`);

if (topics.length === 0) {
  console.log("⚠️  数据库里没有 topic。");
  db.close();
  process.exit(0);
}

// 找一个内容较多的 topic 做渲染演示：取笔记数最多的前 3 个
const samples = topics
  .slice(0, 30)
  .map((t) => ({ topic: t, notes: db.fetchNotes(t.ZTOPICID).filter((n) => render.isKept(n, false)) }))
  .filter((s) => s.notes.length > 0)
  .sort((a, b) => b.notes.length - a.notes.length)
  .slice(0, 3);

const ver = dbMod.detectAppVersion(dbPath);

for (const { topic, notes } of samples) {
  console.log(`\n--- ${topic.ZTITLE}（${notes.length} 条 note）---`);
  notes.sort((a, b) => {
    const pa = a.ZSTARTPAGE ?? 0;
    const pb = b.ZSTARTPAGE ?? 0;
    if (pa !== pb) return pa - pb;
    return (a.ZNOTEID || "") < (b.ZNOTEID || "") ? -1 : 1;
  });

  const excerptNorms = new Set();
  for (const n of notes) {
    const e = render.cleanText(n.ZHIGHLIGHT_TEXT).trim();
    if (!e) continue;
    const norm = e.replace(/\s+/g, "");
    if (norm.length >= 12) excerptNorms.add(norm);
  }
  const cardLabels = new Map();

  const ctx = {
    urlScheme: ver.urlScheme,
    appName: ver.appName,
    imageWidth: 0,
    excerptNorms,
    cardLabels,
  };
  const stats = { noteCount: 0, imageCount: 0, skippedAi: 0, skippedEmpty: 0 };
  const lines = [];
  for (const n of notes.slice(0, 8)) {
    render.renderNoteWeread(n, ctx, lines, stats);
  }
  console.log(`note_count=${stats.noteCount}  skipped_empty=${stats.skippedEmpty}`);
  console.log(lines.slice(0, 25).join("\n"));
}

// 写一个完整 sample 文件
const out = join(outDir, "sample.md");
const { topic, notes } = samples[0];
const ctx = {
  urlScheme: ver.urlScheme,
  appName: ver.appName,
  imageWidth: 0,
  excerptNorms: new Set(notes.flatMap((n) => {
    const e = render.cleanText(n.ZHIGHLIGHT_TEXT).trim().replace(/\s+/g, "");
    return e.length >= 12 ? [e] : [];
  })),
  cardLabels: new Map(),
};
const stats = { noteCount: 0, imageCount: 0, skippedAi: 0, skippedEmpty: 0 };
const body = [];
let lastPage = null;
for (const n of notes) {
  if (n.ZSTARTPAGE != null && lastPage != null && n.ZSTARTPAGE !== lastPage) {
    body.push("---", "");
  }
  render.renderNoteWeread(n, ctx, body, stats);
  if (n.ZSTARTPAGE != null) lastPage = n.ZSTARTPAGE;
}
const fm = render.renderFrontmatter({
  doc_type: "marginnote-export",
  topicId: topic.ZTOPICID,
  title: topic.ZTITLE,
  type: topic.ZMINDLINKS ? "mindmap" : "book",
  noteCount: stats.noteCount,
  imageCount: 0,
  marginnote: `${ver.urlScheme}://notebook/${topic.ZTOPICID}`,
  source: ver.appName,
});
writeFileSync(out, `${fm}\n\n# ${topic.ZTITLE}\n\n# 高亮划线\n\n${body.join("\n")}\n`);
console.log(`\n✓ 完整 sample 写入：${out}`);

db.close();
