/**
 * MarginSync 插件的核心类型定义。
 *
 * 所有 Z 前缀字段都是直接来自 MarginNotes.sqlite 表（ZTOPIC / ZBOOKNOTE / ZBOOK），
 * 保持字段名一致便于和 Python 端 mn_export_tool.py 互相对照。
 */

export interface Note {
  ZNOTEID: string;
  ZNOTETITLE: string | null;
  ZHIGHLIGHT_TEXT: string | null;
  ZNOTES_TEXT: string | null;
  ZMINDLINKS: string | null;
  ZHIGHLIGHT_PIC: Buffer | null;
  ZTYPE: number | null;
  ZSTARTPAGE: number | null;
  ZSTARTPOS: string | null;
  ZHIGHLIGHT_DATE: number | null;
  ZNOTE_DATE: number | null;
  ZBOOKMD5: string | null;
  ZTOPICID: string | null;
  ZCHILDMAPNOTEID: string | null;
}

export interface Topic {
  ZTOPICID: string;
  ZTITLE: string;
  /**
   * 在 ZTOPIC 表里实际是 `ZLOCALBOOKMD5`（单本书的 hash）。MarginNote 4 还有
   * `ZBOOKLIST`（多本书空格分隔）但 v0.1 暂未使用。统一暴露成 `bookMd5`
   * 字符串字段，避免和 ZBOOKNOTE 表里的 `ZBOOKMD5` 重名混淆。
   */
  bookMd5: string | null;
  ZMINDLINKS: string | null;
  ZDATE: number | null;
  ZLASTVISIT: number | null;
}

export interface Book {
  md5: string;
  title: string;
  author: string | null;
  folder: string;
}

/** 渲染期间的统计计数。 */
export interface RenderStats {
  noteCount: number;
  imageCount: number;
  skippedAi: number;
  skippedEmpty: number;
}

/** 渲染期间共享的常量与查找表。 */
export interface RenderContext {
  urlScheme: "marginnote3app" | "marginnote4app";
  appName: "MarginNote 3" | "MarginNote 4";
  imageWidth: number; // 0 = 标准 markdown ![](path)，>0 = ![|N](path)
  /** 本书所有划线 excerpt 的归一化集合，用于跨 note 剥重复批注。 */
  excerptNorms: Set<string>;
  /** 卡片关联 label：ZNOTEID → 友好显示文本。 */
  cardLabels: Map<string, string>;
}

/** 一个节点经渲染抽出的"单条记录"，用于 weread 风格段落输出。 */
export interface NoteRender {
  excerpt: string; // 渲染时已经被 _is_redundant 剥过的 "可显示原文"
  comment: string; // 已被去 hashtag、剥 card_link、跨 note 去重之后的批注
  page: number | null;
  noteId: string;
  cardLinkIds: string[];
  // image 留作 v0.2 添加 plist 解码后再补
}

/** 一次同步运行的结果。 */
export interface SyncResult {
  written: number;
  unchanged: number;
  skippedEmpty: number;
  prunedOrphans: number;
  files: string[];
}
