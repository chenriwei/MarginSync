/**
 * MarginNote 思维导图树构建（对应 mn_export_tool.py build_tree 等）。
 */

import type { Note } from "./types";

export interface TreeNode {
  note: Note;
  children: TreeNode[];
}

export function hasRealContent(note: Note): boolean {
  return !!(
    note.ZHIGHLIGHT_TEXT ||
    note.ZNOTES_TEXT ||
    note.ZHIGHLIGHT_PIC ||
    note.ZCHILDMAPNOTEID
  );
}

export function pruneEmptyBranches(nodes: TreeNode[]): TreeNode[] {
  const kept: TreeNode[] = [];
  for (const tn of nodes) {
    tn.children = pruneEmptyBranches(tn.children);
    if (hasRealContent(tn.note) || tn.children.length) {
      kept.push(tn);
    }
  }
  return kept;
}

function sortKey(tn: TreeNode): [number, number, number] {
  const n = tn.note;
  const page = n.ZSTARTPAGE ?? 0;
  let x = 0;
  let y = 0;
  const pos = n.ZSTARTPOS || "";
  if (pos) {
    const parts = pos.split(",");
    if (parts.length >= 2) {
      x = parseFloat(parts[0]) || 0;
      y = parseFloat(parts[1]) || 0;
    }
  }
  return [page, -y, x];
}

function sortRecursive(nodeList: TreeNode[]): void {
  nodeList.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });
  for (const n of nodeList) sortRecursive(n.children);
}

/** 从 flat notes 列表构建 mindmap 层级树。 */
export function buildTree(notes: Note[]): TreeNode[] {
  const noteMap = new Map<string, Note>();
  for (const n of notes) {
    if (n.ZNOTEID) noteMap.set(n.ZNOTEID, n);
  }
  const nodes = new Map<string, TreeNode>();
  for (const [nid, n] of noteMap) {
    nodes.set(nid, { note: n, children: [] });
  }
  const childrenSet = new Set<string>();

  for (const note of notes) {
    if (!note.ZMINDLINKS || !note.ZNOTEID) continue;
    const parent = nodes.get(note.ZNOTEID);
    if (!parent) continue;
    for (const cid of note.ZMINDLINKS.split("|")) {
      const child = nodes.get(cid);
      if (child) {
        parent.children.push(child);
        childrenSet.add(cid);
      }
    }
  }

  const roots: TreeNode[] = [];
  for (const [nid, n] of nodes) {
    if (!childrenSet.has(nid)) roots.push(n);
  }
  sortRecursive(roots);
  return pruneEmptyBranches(roots);
}

export function* walkTree(nodes: TreeNode[]): Generator<TreeNode> {
  for (const tn of nodes) {
    yield tn;
    yield* walkTree(tn.children);
  }
}

export function normalizeExcerpt(text: string | null | undefined): string {
  if (!text) return "";
  return [...text].filter((ch) => /[0-9A-Za-z\u4e00-\u9fff]/.test(ch)).join("").slice(0, 200);
}

export function keyForBookNote(note: Note): string {
  const excerptNorm = normalizeExcerpt(note.ZHIGHLIGHT_TEXT);
  const titleNorm = normalizeExcerpt(note.ZNOTETITLE);
  const labelNorm = excerptNorm || titleNorm;
  const pos = note.ZSTARTPOS || "";
  const page = note.ZSTARTPAGE ?? 0;
  if (labelNorm || pos) {
    return JSON.stringify([page, pos, labelNorm]);
  }
  return JSON.stringify(["__solo__", note.ZNOTEID]);
}

/** 保留本书笔记及其祖先分组节点。 */
export function filterTreeToBook(nodes: TreeNode[], md5Set: Set<string>): TreeNode[] {
  const kept: TreeNode[] = [];
  for (const tn of nodes) {
    const newChildren = filterTreeToBook(tn.children, md5Set);
    const own = !!(tn.note.ZBOOKMD5 && md5Set.has(tn.note.ZBOOKMD5));
    if (own || newChildren.length) {
      tn.children = newChildren;
      kept.push(tn);
    }
  }
  return kept;
}
