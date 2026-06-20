import * as fs from "fs";
import { App, FileSystemAdapter, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type MarginSyncPlugin from "./main";
import { MarginDb, normalizeDatabasePath } from "./db";
import { resolvePluginDir } from "./sync";

export type SyncScope = "all" | "books" | "mindmaps";

/** 书籍类笔记的导出方式（与 Python CLI 的 --by-book / 默认 Topic 模式对应）。 */
export type BookExportMode = "by-book" | "by-topic";

/** 上次同步的摘要，渲染在设置页顶部的状态面板里。 */
export interface LastSyncSummary {
  /** ISO 字符串。 */
  at: string;
  written: number;
  unchanged: number;
  skippedEmpty: number;
  prunedOrphans: number;
  error?: string;
}

export interface MarginSyncSettings {
  /** MarginNote 4 / 3 的 SQLite 数据库绝对路径（由用户在设置页填入）。 */
  databasePath: string;
  /** 输出在 vault 内的子目录（相对路径）。 */
  outputDir: string;
  /** 同步范围：全部 / 仅书籍 / 仅思维导图。 */
  scope: SyncScope;
  /** 书籍导出：按书聚合（--by-book）或按 Topic。 */
  bookExportMode: BookExportMode;
  /** by-book 模式下按 MarginNote 书架文件夹（ZBOOK.ZPATH）分子目录。 */
  folderGrouping: boolean;
  /** 思维导图 Topic 导出时递归子思维导图（ZCHILDMAPNOTEID）。 */
  recurseChildMindmaps: boolean;
  /** Obsidian 私有图片宽度语法 `![|N](path)` 的 N；0 为关闭，标准 markdown。 */
  imageWidth: number;
  /** 是否在同步结束时把上次生成、本次未再生成的 .md 视为孤儿清理掉。 */
  pruneOrphans: boolean;
  /** 是否保留 AI 上下文 / AI 答复节点（默认丢弃）。 */
  keepAiNodes: boolean;
  /** 仅展示用：上次同步的摘要。 */
  lastSync?: LastSyncSummary;
}

export const DEFAULT_SETTINGS: MarginSyncSettings = {
  databasePath: "",
  outputDir: "MarginSync",
  scope: "all",
  bookExportMode: "by-book",
  folderGrouping: true,
  recurseChildMindmaps: true,
  imageWidth: 0,
  pruneOrphans: true,
  keepAiNodes: false,
};

/**
 * macOS 上 MarginNote 4 / 3 沙盒数据库的常见位置。展示在帮助文本里方便用户复制。
 * iOS 同步过来的副本路径不固定，让用户自己手动选。
 */
export const COMMON_DB_PATHS = [
  // MarginNote 4（macOS）
  "~/Library/Containers/QReader.MarginStudy.easy/Data/Library/Private Documents/MN4NotebookDatabase/0/MarginNotes.sqlite",
  // MarginNote 3（macOS）
  "~/Library/Containers/QReader.MarginStudy.RealPro/Data/Library/MarginNote Extensions/marginnote.extension.notedatabase/MarginNotes_default_3.0.sqlite",
];

export class MarginSyncSettingTab extends PluginSettingTab {
  plugin: MarginSyncPlugin;

  constructor(app: App, plugin: MarginSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "MarginSync 设置" });

    this.renderLastSyncBanner(containerEl);

    // ---- 数据库路径 + 浏览 + 测试连接 ----
    new Setting(containerEl)
      .setName("MarginNote 数据库路径")
      .setDesc(
        "MarginNote 3/4 的 MarginNotes.sqlite 绝对路径。注意：MarginNote 必须先关闭，否则插件可能读不到最新写入的笔记。"
      )
      .addText((text) =>
        text
          .setPlaceholder("/Users/you/Library/Containers/.../MarginNotes.sqlite")
          .setValue(this.plugin.settings.databasePath)
          .onChange(async (value) => {
            this.plugin.settings.databasePath = normalizeDatabasePath(value);
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("浏览…")
          .setTooltip("选择 MarginNotes.sqlite")
          .onClick(() => this.pickDatabaseFile())
      )
      .addButton((btn) =>
        btn
          .setButtonText("测试连接")
          .setTooltip("尝试打开数据库并列出 Topic 数")
          .onClick(() => this.testConnection())
      );

    const hint = containerEl.createEl("div", { cls: "setting-item-description" });
    hint.createEl("div", { text: "macOS 常见路径（点击复制）：" });
    for (const p of COMMON_DB_PATHS) {
      const code = hint.createEl("code", { text: p });
      code.style.display = "block";
      code.style.cursor = "pointer";
      code.title = "点击复制到剪贴板";
      code.addEventListener("click", async () => {
        await navigator.clipboard.writeText(p);
        new Notice("已复制路径到剪贴板");
      });
    }

    // ---- 输出目录 + 打开按钮 ----
    new Setting(containerEl)
      .setName("输出子目录")
      .setDesc("vault 内放 MarginNote 笔记的相对路径。by-book → Books/；思维导图 → MindMaps/。")
      .addText((text) =>
        text
          .setPlaceholder("MarginSync")
          .setValue(this.plugin.settings.outputDir)
          .onChange(async (value) => {
            this.plugin.settings.outputDir = normalizePath(value || "MarginSync");
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("打开")
          .setTooltip("在系统文件管理器中打开输出目录")
          .onClick(() => this.openOutputDir())
      );

    // ---- 书籍导出模式 ----
    new Setting(containerEl)
      .setName("书籍导出模式")
      .setDesc(
        "按书聚合：同一 PDF 跨 Topic 合并为一份 markdown（对齐 Python --by-book）。" +
          "按 Topic：每个书籍笔记本单独一份文件。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("by-book", "按书聚合（推荐）")
          .addOption("by-topic", "按 Topic")
          .setValue(this.plugin.settings.bookExportMode)
          .onChange(async (value: string) => {
            this.plugin.settings.bookExportMode = value as BookExportMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("书架文件夹分组")
      .setDesc("按书聚合时，按 MarginNote「我的书架」目录（ZBOOK.ZPATH）在 Books/ 下建子文件夹。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.folderGrouping).onChange(async (value) => {
          this.plugin.settings.folderGrouping = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("递归子思维导图")
      .setDesc("导出思维导图 Topic 时，跟随 ZCHILDMAPNOTEID 递归导出嵌套子图（父 - 子 命名）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.recurseChildMindmaps).onChange(async (value) => {
          this.plugin.settings.recurseChildMindmaps = value;
          await this.plugin.saveSettings();
        })
      );

    // ---- 同步范围 ----
    new Setting(containerEl)
      .setName("同步范围")
      .setDesc("books = 仅 PDF/EPUB 阅读笔记本；mindmaps = 仅思维导图；all = 全部。")
      .addDropdown((dd) =>
        dd
          .addOption("all", "全部")
          .addOption("books", "仅书籍")
          .addOption("mindmaps", "仅思维导图")
          .setValue(this.plugin.settings.scope)
          .onChange(async (value: string) => {
            this.plugin.settings.scope = value as SyncScope;
            await this.plugin.saveSettings();
          })
      );

    // ---- 图片宽度（v0.2 才生效） ----
    new Setting(containerEl)
      .setName("图片宽度")
      .setDesc("> 0 时输出 Obsidian 私有 ![|N](path) 限宽；0 为标准 markdown。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.imageWidth))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.imageWidth = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          })
      );

    // ---- 孤儿清理 ----
    new Setting(containerEl)
      .setName("孤儿清理")
      .setDesc("同步结束后把上次生成、本次未再生成的 .md 删除（同步 MarginNote 端的删除/改名）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pruneOrphans).onChange(async (value) => {
          this.plugin.settings.pruneOrphans = value;
          await this.plugin.saveSettings();
        })
      );

    // ---- 保留 AI 节点 ----
    new Setting(containerEl)
      .setName("保留 AI 节点")
      .setDesc("是否保留 MarginNote 内 AI 上下文 / AI 回复节点（默认丢弃，避免污染笔记主线）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.keepAiNodes).onChange(async (value) => {
          this.plugin.settings.keepAiNodes = value;
          await this.plugin.saveSettings();
        })
      );

    // ---- 立即同步 ----
    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("从 MarginNote 把笔记拉到 vault。等价于命令面板里的 '从 MarginNote 同步笔记'。")
      .addButton((btn) =>
        btn
          .setButtonText("开始同步")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
            // 同步结束后刷新设置面板，让"上次同步"摘要立即可见
            this.display();
          })
      );

    containerEl.createEl("h3", { text: "使用流程" });
    const help = containerEl.createEl("ol");
    help.createEl("li", { text: "关闭 MarginNote 应用（确保 sqlite 写入已落盘）。" });
    help.createEl("li", { text: "在上方填好数据库绝对路径与输出子目录，可点 '测试连接' 验证。" });
    help.createEl("li", { text: "点 '开始同步'，或用命令面板 (Cmd/Ctrl + P) → 'MarginSync: 从 MarginNote 同步笔记'。" });
  }

  // ---------- 上次同步状态面板 ----------

  private renderLastSyncBanner(parent: HTMLElement): void {
    const last = this.plugin.settings.lastSync;
    const banner = parent.createEl("div", { cls: "setting-item" });
    banner.style.flexDirection = "column";
    banner.style.alignItems = "flex-start";
    banner.style.padding = "12px";
    banner.style.marginBottom = "12px";
    banner.style.border = "1px solid var(--background-modifier-border)";
    banner.style.borderRadius = "6px";
    banner.style.background = "var(--background-secondary)";

    const title = banner.createEl("div");
    title.style.fontWeight = "bold";
    title.textContent = "上次同步";

    const body = banner.createEl("div");
    body.style.marginTop = "4px";
    body.style.color = "var(--text-muted)";
    body.style.fontSize = "0.9em";

    if (!last) {
      body.textContent = "尚未运行过同步。";
      return;
    }
    if (last.error) {
      body.style.color = "var(--text-error)";
      body.textContent = `${last.at} · ❌ ${last.error}`;
      return;
    }
    body.textContent =
      `${last.at} · ✏️ 实写 ${last.written}` +
      ` · ♻️ 未变化 ${last.unchanged}` +
      ` · ⏭ 空跳过 ${last.skippedEmpty}` +
      (last.prunedOrphans ? ` · 🧹 清孤儿 ${last.prunedOrphans}` : "");
  }

  // ---------- 行为按钮 ----------

  /**
   * 用 Electron 渲染进程支持的 `<input type="file">` 弹原生文件选择器。
   * Obsidian 桌面端是 Electron，input.files[0].path 直接给出绝对路径。
   */
  private pickDatabaseFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqlite,.db";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const filePath = (file as unknown as { path?: string }).path;
      if (!filePath) {
        new Notice("无法获取文件绝对路径，请手动粘贴到输入框。");
        return;
      }
      this.plugin.settings.databasePath = normalizeDatabasePath(filePath);
      await this.plugin.saveSettings();
      this.display();
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 0);
  }

  private async testConnection(): Promise<void> {
    const path = normalizeDatabasePath(this.plugin.settings.databasePath);
    if (!path) {
      new Notice("请先填写数据库路径。");
      return;
    }
    if (!fs.existsSync(path)) {
      new Notice(
        `✗ 文件不存在：${path}\n请确认路径指向 MarginNotes.sqlite 文件本身（不是目录），且不要用引号包裹。`,
        10000
      );
      return;
    }
    try {
      const pluginDir = resolvePluginDir(
        this.app,
        this.plugin.manifest.dir ?? "marginsync"
      );
      const db = new MarginDb(path, pluginDir);
      const topics = db.listTopics();
      const books = topics.filter((t) => !t.ZMINDLINKS).length;
      const minds = topics.length - books;
      db.close();
      new Notice(`✓ 连接成功 — 共 ${topics.length} 个笔记本（书籍 ${books} · 思维导图 ${minds}）`, 8000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`✗ 连接失败：${msg}`, 8000);
    }
  }

  /**
   * 用 Electron `shell.openPath` 在系统文件管理器中打开 vault 内的输出目录。
   * 没装 Electron 接口时降级为 Notice 提示。
   */
  private async openOutputDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("当前 vault 不在本地文件系统中，无法打开。");
      return;
    }
    const outDir = this.plugin.settings.outputDir || "MarginSync";
    const abs = adapter.getFullPath(outDir);
    try {
      const electron = (window as unknown as {
        require?: (id: string) => { shell?: { openPath: (p: string) => Promise<string> } };
      }).require?.("electron");
      const result = await electron?.shell?.openPath(abs);
      if (result) new Notice(`无法打开：${result}`);
    } catch (e) {
      new Notice(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
