import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MarginSyncSettingTab, type MarginSyncSettings } from "./settings";
import { syncMarginNote } from "./sync";

export default class MarginSyncPlugin extends Plugin {
  settings!: MarginSyncSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new MarginSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-from-marginnote",
      name: "从 MarginNote 同步笔记",
      callback: () => {
        void this.runSync();
      },
    });

    // 给左侧 ribbon 一个快捷入口
    this.addRibbonIcon("download", "MarginSync: 同步", () => {
      void this.runSync();
    });
  }

  /**
   * 跑一次完整同步：toast 提示 → 写盘 → 把摘要回写到 settings.lastSync
   * 设置面板顶部的"上次同步"banner 读这个字段。
   */
  async runSync(): Promise<void> {
    const inProgress = new Notice("MarginSync: 同步中…", 0);
    try {
      const result = await syncMarginNote(this.app, this.settings);
      inProgress.hide();
      this.settings.lastSync = {
        at: nowDisplayString(),
        written: result.written,
        unchanged: result.unchanged,
        skippedEmpty: result.skippedEmpty,
        prunedOrphans: result.prunedOrphans,
      };
      await this.saveSettings();
      new Notice(
        `MarginSync 完成 — ✏️ 实写 ${result.written}，` +
          `♻️ 未变化 ${result.unchanged}，` +
          `⏭ 空跳过 ${result.skippedEmpty}` +
          (result.prunedOrphans ? `，🧹 清孤儿 ${result.prunedOrphans}` : ""),
        8000
      );
    } catch (e) {
      inProgress.hide();
      console.error("MarginSync 同步失败：", e);
      const msg = e instanceof Error ? e.message : String(e);
      this.settings.lastSync = {
        at: nowDisplayString(),
        written: 0,
        unchanged: 0,
        skippedEmpty: 0,
        prunedOrphans: 0,
        error: msg,
      };
      await this.saveSettings();
      new Notice("MarginSync 同步失败：" + msg, 10000);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function nowDisplayString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
