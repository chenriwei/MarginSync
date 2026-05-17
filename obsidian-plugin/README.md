# MarginSync — Obsidian 插件

把 MarginNote 3 / 4 的笔记（高亮划线、批注、思维导图层级、tag）同步到你的 Obsidian vault，
样式对齐 [obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)，
便于在同一个库里和微信读书笔记并排阅读。

## 主要特性

- **直接读取本地 MarginNote SQLite 数据库**，无需打开 MarginNote / 不依赖任何在线服务
- **weread-plugin 风格 Markdown 输出**：每条原文是独立 quote 段落，紧跟着的 `[!note]+ 💭 我的批注` callout 就地显示用户批注
- **增量同步**：内容不变时不动文件 mtime，Obsidian 的"最近编辑"列表只在 MarginNote 那边真改了笔记时才会刷新
- **孤儿清理**：MarginNote 端删除 / 改名 / 移目录的笔记会被同步删掉（可关）
- **跨 note 去重**：批注内容跟某条独立划线一字不差时自动剥掉，原文优先
- **伪 HTML 转义**：`<pad>` `<form>` `<|endoftext|>` 等"裸标签"自动包成 inline code，避免 Obsidian reader 模式被 HTMLUnknownElement 吞掉 quote/callout 装饰
- **MarginNote 跳回链接** 写进 frontmatter 的 `marginnote` 字段，"笔记属性"面板里点一下就能跳回 App
- **hashtag 自动收集到 frontmatter `tags`**

## 安装

> v0.1.0 还在内测中，没上 Obsidian Community Plugin 商店。请用以下任一方式手动安装：

### 方式 A：从源码 build

```bash
cd obsidian-plugin
npm install
npm run build
# 生成 main.js / manifest.json / styles.css 三个文件
```

把 `obsidian-plugin/main.js`、`obsidian-plugin/manifest.json`、`obsidian-plugin/styles.css` 三个文件拷贝到你的 vault：

```
<your-vault>/.obsidian/plugins/marginsync/
├── main.js
├── manifest.json
└── styles.css
```

然后 Obsidian 重启 / 在 Settings → Community plugins 里启用 "MarginSync"。

### 方式 B：BRAT（社区第三方插件管理器）

未上架商店期间，建议社区用户用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加这个仓库直接拉 release。

## 配置

设置面板（Settings → Community plugins → MarginSync）需要填三件事：

| 项 | 说明 | 示例 |
| --- | --- | --- |
| MarginNote 数据库路径 | `MarginNotes.sqlite` 的绝对路径，注意同步前要**关闭 MarginNote**，否则 sqlite 写入还在 WAL 里 | `/Users/you/Library/Containers/QReader.MarginStudyMac/Data/Library/MarginNote Extensions/marginnote.extension.cloudsync/MarginNotes.sqlite` |
| 输出子目录 | vault 内放笔记的相对路径 | `MarginSync` |
| 同步范围 | 全部 / 仅书籍 / 仅思维导图 | `all` |

## 命令

按 Cmd/Ctrl + P 打开命令面板，输入 `MarginSync` 即可看到：

- **MarginSync: 从 MarginNote 同步笔记** — 跑一次完整同步

也可以点左侧 ribbon 的"下载"图标快捷触发。

## 输出格式示例

```markdown
---
doc_type: "marginnote-export"
topicId: "AE81868E-..."
title: "AI 编程是一种'框架'"
type: "book"
noteCount: 7
imageCount: 0
tags:
  - "编程/AI"
marginnote: "marginnote4app://notebook/AE81868E-..."
source: "MarginNote 4"
---
# AI 编程是一种"框架"

# 高亮划线

>  使用框架，控制权牢牢掌握在框架手中…  [p.2](marginnote4app://note/45078519-...)

>  要区分一个东西是框架还是库，关键在于找到"谁控制着程序的整体结构？"  [p.2](marginnote4app://note/169AC4F9-...)

> [!note]+ 💭 我的批注
> 我认为答案的关键在于一个词：认知成本…  [p.3](marginnote4app://note/01839DE3-...)
```

## v0.1 现在能做什么 / 还不能做什么

| 能力 | 状态 |
| --- | --- |
| Topic 列表（books-only / mindmaps-only / all） | ✅ |
| 单 Topic 内的笔记按页码排序展开 | ✅ |
| 高亮划线 + 批注 callout（weread 风格） | ✅ |
| 跨 note 批注去重 | ✅ |
| 伪 HTML 转义（`<pad>`/`<form>` 等） | ✅ |
| hashtag → frontmatter | ✅ |
| 卡片关联跳转链接 | ✅ |
| 增量写入 + 孤儿清理 | ✅ |
| **图片提取**（NSKeyedArchiver plist 解码） | ⏳ v0.2 |
| **`--by-book` 跨 Topic 聚合**（同一本书在多个 Topic 里的笔记合并） | ⏳ v0.2 |
| **MarginNote 文件夹分组** | ⏳ v0.2 |
| 子思维导图递归 | ⏳ v0.3 |

如果上面这些"还不能做什么"对你重要，可以暂时用根目录的 [`mn_export_tool.py`](../mn_export_tool.py) Python 脚本，它已经覆盖了全部能力。两边规则一致、可以混用。

## 贡献

欢迎 issue / PR。需求集中在：

1. **图片解码**：MarginNote 4 的 `ZHIGHLIGHT_PIC` 是 binary plist + NSKeyedArchiver，需要纯 JS 解出 hash 然后从 `ZMEDIA.ZDATA` 取出 PNG 写入 vault attachments
2. **`by-book` 模式**：把同一本书在多个 Topic 里的笔记按 ZBOOKMD5 聚合，并保留主 Topic 的 mindmap 层级
3. **更细的 AI 节点判定**：现在只识别 emoji 前缀，需要看 `ZTYPE` / `ZHIGHLIGHT_STYLE` 等字段做更精确的过滤

## License

MIT — see [LICENSE](../LICENSE).
