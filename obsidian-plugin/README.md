# MarginSync — Obsidian 插件

把 MarginNote 3 / 4 的笔记（高亮划线、批注、思维导图、tag）同步到你的 Obsidian vault。
样式对齐 [obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)。

**平台要求：** macOS 桌面端 Obsidian ≥ 1.12（`isDesktopOnly`）。预编译 SQLite 模块目前包含 **darwin-arm64**（Apple Silicon）；Intel Mac 请用源码 `npm install` 或 Python CLI。

## 主要特性

- 直接读取本地 MarginNote SQLite，无需联网
- weread 风格 Markdown（quote + `[!note]+ 💭 我的批注` callout）
- 增量同步（内容不变保留 mtime）+ 孤儿清理
- 图片提取（MN3 inline + MN4 sidecar）
- 跨 note 批注去重、伪 HTML 转义、卡片关联、hashtag → frontmatter

## 安装

### 方式 A：GitHub Release（推荐）

1. 打开 [Releases](https://github.com/chenriwei/MarginSync/releases)，下载最新版的 `main.js`、`manifest.json`、`styles.css`
2. 放到 `<vault>/.obsidian/plugins/marginsync/`
3. Obsidian → 设置 → 社区插件 → 启用 MarginSync

首次同步会自动把预编译的 `better_sqlite3.node` 解压到插件目录，**无需**再跑 `npm install`。

### 方式 B：BRAT

用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加仓库 `chenriwei/MarginSync`，选择最新 release tag。

### 方式 C：从源码 build

```bash
cd obsidian-plugin
npm install
npm run build
```

## 配置

| 项 | 说明 |
| --- | --- |
| **MarginNote 数据库路径** | `MarginNotes.sqlite` 绝对路径；同步前**关闭 MarginNote** |
| **输出子目录** | vault 内相对路径，默认 `MarginSync` |
| **书籍导出模式** | **按书聚合**（`--by-book`，推荐）或按 Topic |
| **书架文件夹分组** | 按书聚合时，按 MarginNote 书架目录建 `Books/` 子文件夹 |
| **递归子思维导图** | 导出思维导图时跟随嵌套子图（`父 - 子` 文件名） |
| **同步范围** | 全部 / 仅书籍 / 仅思维导图 |

**MarginNote 4 常见路径（设置页可点击复制）：**

```
~/Library/Containers/QReader.MarginStudy.easy/Data/Library/Private Documents/MN4NotebookDatabase/0/MarginNotes.sqlite
```

**MarginNote 3：**

```
~/Library/Containers/QReader.MarginStudy.RealPro/Data/Library/MarginNote Extensions/marginnote.extension.notedatabase/MarginNotes_default_3.0.sqlite
```

## 命令

- 命令面板 → `MarginSync: 从 MarginNote 同步笔记`
- 左侧 Ribbon「下载」图标
- 设置页「开始同步」

## 功能对照（相对 Python CLI）

| 能力 | 插件 v0.3 | Python CLI |
| --- | --- | --- |
| **`--by-book` 按书聚合** | ✅ | ✅ |
| **书架文件夹分组** | ✅ | ✅ |
| **子思维导图递归** | ✅ | ✅ |
| **思维导图树状渲染** | ✅ | ✅ |
| **图片 / 增量 / 孤儿清理** | ✅ | ✅ |
| **书架分类 tags** | ✅ | ✅ |

## 上架社区插件

仓库根目录已包含 Obsidian 要求的 `manifest.json`、`versions.json`、`LICENSE`。
提交流程见 [Obsidian 插件发布文档](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)。

维护者更新 Electron 预编译：`npm run rebuild:native`（需 macOS + Electron 39 ABI）。

## License

MIT — see [LICENSE](../LICENSE).
