# MarginSync

把 MarginNote 3 / 4 本地数据库里的笔记本（书籍 + 思维导图）同步到 Obsidian。
输出风格参考 [obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)，让 MarginNote 笔记可以无缝融入 Obsidian 知识库。

## 快速开始

```bash
# 交互式选择要导出的笔记本（支持多选，用逗号分隔）
python mn_export_tool.py

# === 按 Topic 导出 ===
python mn_export_tool.py --all            # 全部 Topic（书籍 + 思维导图）
python mn_export_tool.py --books-only     # 只导出书籍类 Topic
python mn_export_tool.py --mindmaps-only  # 只导出思维导图 Topic

# === 按"书"聚合导出（推荐用于"我只看 books"的场景）===
python mn_export_tool.py --by-book                    # 默认按 MarginNote 文件夹归类
python mn_export_tool.py --by-book --no-folder-grouping  # 平铺到 Books/ 下
python mn_export_tool.py --by-book --id e7e8cad8      # 仅导单本（按 ZBOOKMD5 前缀匹配）

# 按 ZTOPICID 单本导出
python mn_export_tool.py --id 9BD54707-EBB7-4C52-80AB-7576CD189B23

# 自定义输出目录、保留 AI 节点
python mn_export_tool.py --all --out ~/Obsidian/MyVault/MarginNote --keep-ai
```

工具会自动检测本地 MarginNote 3 / 4 的 SQLite 数据库；若两个版本都装了，优先使用 MN4。

### 三种导出模式怎么选

| 模式 | 一份 markdown 对应 | 适合场景 |
|---|---|---|
| 默认 / `--all` | 一个 Topic（笔记本） | 完整还原 MarginNote 中的笔记本结构 |
| `--books-only` | 一个 Book Topic | 只想拿原始划线 |
| `--mindmaps-only` | 一个 MindMap Topic | 只想拿精选 / 重组过的内容 |
| `--by-book` | 一本 PDF（跨所有 Topic 聚合） | **想"只看 books"就拿到一本书全部笔记** |

`--by-book` 模式会读取 `ZBOOKMD5`，把同一本 PDF 在所有 Topic（无论是 Book 还是 MindMap）中产生的笔记合并到一份 markdown 里，并：

- 选含层级笔记最多的 Topic 作为"主结构"，其它 Topic 上对同一段原文的额外批注会以可折叠 callout `[!quote]- 💬 来自《X》的批注` 注入到对应节点末尾；主结构里没有的，按页码扁平追加到末尾"补充"区；
- 用 `(ZBOOKMD5, ZSTARTPOS, normalized_excerpt)` 做跨 Topic 去重，仅在节点真的指向 PDF 同一段时才合并；
- frontmatter 里 `sourceTopics` 列出该书涉及的所有 Topic、`primaryTopic` 标识主结构来源；
- 自动跳过 MarginNote 从 PDF 大纲（outline）自动生成、用户没在上面挂任何笔记的占位节点（`ZTYPE=6` 仅有 title），避免把书的目录章节也当成笔记导出来。

### 输出格式：对齐 obsidian-weread-plugin

`--by-book` 模式的 markdown 在结构和样式上完全对齐 [obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin) 的导出风格，便于在同一个 vault 里和微信读书笔记并排阅读：

```markdown
---
doc_type: marginnote-highlights-reviews
bookMd5: "..."
title: "..."
author: "..."
noteCount: 19
reviewCount: 3   # 仅作 frontmatter 计数，不再单独渲染章节
imageCount: 0
sourceTopics: [...]
primaryTopic: "..."
exported: "..."
tags: [...]
source: "MarginNote 4"
---
# 书名

# 元数据
> [!abstract] 书名
> - 书名：xxx
> - 作者：xxx
> - 笔记数：19
> - 划线评论：3
> - 主结构：🧠 主 Topic
> - 其它来源：📖 X、🧠 Y
> - MarginNote：marginnote4app://notebook/<ZTOPICID>

# 高亮划线

## 章节标题  [p.X](url)

>  原文摘录文本  [p.1](marginnote4app://note/<ZNOTEID>)

>  下一段摘录  [p.2](url)

> [!note]+ 💭 我的批注
> 我写的批注内容
```

要点：

- **`# 高亮划线`** 主体：每条原文是独立的 quote 段落 `>  text  [p.X](url)`，紧跟其后的 `[!note]+ 💭 我的批注` callout 就地展示该笔记的批注内容，方便上下文阅读。
- 历史曾有 `# 读书笔记 / ### 划线评论` 段把有批注的笔记再单列一份，但跟上方 callout 完全重复，已下线。`reviewCount` 字段仍保留作 frontmatter 索引。如果想做"全 vault 批注汇总"，用 Obsidian Dataview / Backlinks 即可。
- **`> [!quote]- 💬 来自《X》的批注`** callout 用于跨 Topic 在同一段原文上的额外批注（默认折叠）。

注：按 Topic / 思维导图模式的输出仍走"mindmap 树状层级 + list"的紧凑风格，因为 mindmap 的层级密度高，weread 的"段落式 quote"撑不开。

### 按 MarginNote 文件夹归类（默认开启）

`--by-book` 模式默认按 `ZBOOK.ZPATH` 解析出的文件夹（即你在 MarginNote 主页"我的书架"看到的目录层级）归类导出，子目录与 iCloud 容器中的实际目录一致。例如：

```
MarginNote_Exports/Books/
├── 《毛泽东选集》... .md           # iCloud 根目录的书直接平铺
├── AI/
│   └── harness engineering....md
├── AICode/
│   └── Claude Code从入门到精通....md
├── MNDocs/                       # MarginNote 的"默认书架"
│   ├── 流畅的 Python.md
│   └── WebClipper/               # 嵌套子目录也会保留
│       └── Reasoning best practices....md
└── 心理学/
    └── 改变：问题形成和解决的原则.md
```

图片相对路径会按 markdown 文件深度自动计算（根目录用 `../assets/`、一级子目录用 `../../assets/`、二级用 `../../../assets/`），保证在 Obsidian / VS Code / GitHub 中都能正常渲染。如果偏好平铺到 `Books/` 下，加 `--no-folder-grouping`。

### 增量同步（默认开启，保留 mtime/ctime）

为了不干扰 Obsidian 的"最近编辑"列表 / iCloud / Dropbox 的同步指示，导出走的是**内容感知的原地写入**：

- 每个 `.md` 在写盘前先把新生成的内容跟磁盘上旧文件做一次字节比对；
  - **完全相同 → 完全不动**（连 `open(..., 'w')` 都不调用，mtime / ctime / inode 全部保留）；
  - **有差异 → 覆写**（保留同一文件路径，只是字节内容更新）。
- frontmatter 里的"时间戳"字段已经改成只反映内容真实更新时间：
  - `lastNoteUpdate`：取本书 / 本笔记本所有节点的最大 `ZNOTE_DATE` / `ZHIGHLIGHT_DATE`；
  - **去掉了**每次都变的 `exported: <运行时刻>`，避免它让"内容比对"永远 fail。
- 收尾会做一次**孤儿清理**：本次未再生成、但 vault 里还有的 `Books/*.md` / `MindMaps/*.md`（以及残留的 `INDEX.md`）会被删掉，同步 MarginNote 端的删除 / 改名 / 移目录操作；变空的子目录也会被一并 `rmdir`。
- `assets/` 不清理 —— 图片以 `ZNOTEID` 命名稳定，孤儿图片不影响渲染，能避免反复写几百兆 IO。

可选开关：

- `--no-clean`：保留所有旧的 `.md` 文件（关闭孤儿清理），仅做内容增量更新。适合你在 vault 里手动整理过、不希望工具帮你删的场景。
- `--id <prefix>`：单本调试模式自动跳过孤儿清理（只动指定那本）。

跑完后命令行会汇总成 `共 414 本书 —— ✏️ 实写 0，♻️ 未变化 414，🧹 清理孤儿 0 个`，可以一眼看出本次到底动了哪些文件。

## 输出目录结构

```
MarginNote_Exports/
├── Books/            # 书籍类笔记本（无 ZMINDLINKS）
│   ├── <根级书名>.md
│   └── <MarginNote 文件夹>/
│       └── <书名>.md
├── MindMaps/         # 思维导图（含子思维导图，按"父 - 子"命名）
│   └── <思维导图>.md
└── assets/           # 所有引用到的图片，按 ZNOTEID 命名
    └── <ZNOTEID>.png
```

不再生成 `INDEX.md` —— Obsidian 自带的文件浏览器、Quick Switcher、search、dataview 等都能更灵活地检索导出内容，单独的索引文件维护成本高且会过时。如果你想自定义索引视图，可以在 vault 里建一个 dataview 查询，例如：

````markdown
```dataview
table file.folder as 目录, noteCount as 笔记数, imageCount as 图片数
from "MarginNote4/Books"
sort noteCount desc
```
````

## 数据源

读取 MarginNote 4 的本地 SQLite 数据库（MN3 路径作 fallback）：

```
~/Library/Containers/QReader.MarginStudy.easy/Data/Library/Private Documents/MN4NotebookDatabase/0/MarginNotes.sqlite
```

涉及的主要表：

- `ZTOPIC`：笔记本（书籍 / 思维导图），含标题、`ZMINDLINKS`、`ZBOOKLIST`、时间戳。
- `ZBOOKNOTE`：所有笔记节点（摘录、评论、图片、子节点链接、AI 节点等）。
- `ZBOOK`：书籍信息（`ZMD5LONG = ZBOOKNOTE.ZBOOKMD5`，反查书名 / 作者）。
- `ZMEDIA`：图片二进制（按 `ZMD5` 索引）。

## 提取规则

### 1. 笔记本筛选与分类

- 列出 `ZTOPIC` 中 `ZTITLE` 非空的全部笔记本，按 `ZLASTVISIT DESC` 排序（缺失时回退到 `ZDATE DESC`）。
- 类型判定：`ZMINDLINKS` 非空 → 思维导图（`MindMaps/`）；否则 → 书籍（`Books/`）。
- 通过 `ZTOPIC.ZBOOKLIST` 解析关联的书籍 SHA256 列表，再到 `ZBOOK.ZMD5LONG` 反查书名 / 作者，写入 frontmatter 与元信息 callout。

### 2. 笔记节点收集

从一个 Topic 出发：

1. 从 `ZTOPIC.ZMINDLINKS` 切分得到根节点 ID。
2. 同时通过 `ZBOOKNOTE.ZTOPICID` 补齐直接挂在 Topic 下的笔记。
3. 以根节点 + 直挂节点为种子，沿 `ZMINDLINKS` 递归收集子节点（每批最多 500，去重）。

每个节点读取：`ZNOTEID, ZNOTETITLE, ZHIGHLIGHT_TEXT, ZNOTES_TEXT, ZMINDLINKS, ZHIGHLIGHT_PIC, ZTYPE, ZSTARTPAGE, ZSTARTPOS, ZCHILDMAPNOTEID, ZHIGHLIGHT_DATE, ZNOTE_DATE, ZHIGHLIGHT_STYLE, ZBOOKMD5`。

### 3. 节点过滤

- **AI 上下文节点**：`ZTYPE = 9` 且 `ZNOTETITLE` 含 `{{文档上下文}}` / `{{MindMap Context}}` → 永远丢弃（这些只是用户向 AI 提问时附带的上下文）。
- **AI 回答节点**：`ZTYPE = 9` 但不是上下文 → 默认丢弃；通过 `--keep-ai` 保留时会在头部加 `🤖` 前缀。
- **空占位节点剪枝**：自下而上递归剪掉"只有标题、没有摘录 / 评论 / 图片 / 子图，且子树为空"的节点（典型如 mindmap 顶层的导航占位节点）。
- 其它情况按以下顺序保留：实质内容（摘录 / 评论 / 图片 / 子思维导图）、有效子节点、有标题。

### 4. 层级与排序

同级节点按以下三元组排序，模拟"在文档中从上到下、从左到右"阅读：

1. `ZSTARTPAGE` 升序。
2. `ZSTARTPOS` 中的 Y 坐标降序（Y 越大越靠上）。
3. `ZSTARTPOS` 中的 X 坐标升序（X 越小越靠左）。

### 5. 文本清洗

为了让 PDF 抽取后的文本在 Obsidian 中可读：

- **PDF 拆字空格**：当一行的"单字 token 比例 ≥ 50%"时认为是被空格逐字拆开的（"同 样 一 个 功 能"），重新拼接，仅保留两侧都是 ASCII 字母数字的空格。
- **CJK 部首字符替换**：`⺠ → 民`、`⻔ → 门`、`⻄ → 西` 等 PDF 提取常见的部首组件字符。
- **MarginNote 思维导图按钮语法**：移除 `$$button:文本:颜色$$`，避免污染 Obsidian。
- **零宽字符**：清理 `\u200b`、`\ufeff`。
- **行首 `#` 转义**：仅在真正命中 markdown 标题语法（`# ` 后跟空格）时转义，单纯的 `#tag` 不再误转义，可被 Obsidian 当成标签。

> 注意：故意 **不** 使用 NFKC 全字符规范化，避免把中文全角逗号、句号转成半角。

### 6. 节点 → Markdown 渲染

每个保留下来的节点根据层级 `level` 渲染为：

- L1 → `## 标题`，L2 → `### 标题`，L3 + → 列表项（每深一级缩进 2 空格）。
- 一个特殊优化：如果根节点全是无子树的扁平叶子（典型于书籍划线），则直接降级为列表，不再堆几十个 H2。

冗余检测：`ZNOTETITLE` 与 `ZHIGHLIGHT_TEXT` 在去掉非字母数字后存在包含关系或 strip 后相等，则认为冗余，避免重复渲染。

不同内容的呈现方式：

- **标题**：用户在 MarginNote 写的 `ZNOTETITLE` 渲染为 H2/H3 或列表项的加粗文本。
- **摘录**：直接以普通 list item 文本呈现（不再 `> quote`）。这样大量纯摘录的章节在 Obsidian 中渲染密度紧凑，避免每行都触发 blockquote 的左竖条 + 内外边距导致页面整体被撑得很松散。原文身份的视觉区分由批注的 callout 卡片来承担，参见下条。
- **评论**：渲染为 callout `> [!note]+ 💭 我的批注`，自带卡片背景，能与上一行的"原文摘录"形成清晰对比。
- **卡片关联**：MarginNote "卡片关联跳转" 功能在 `ZNOTES_TEXT` 里写入的形如 `marginnote4app://note/<id>` 的链接，会被单独剥离出来渲染为 `[🔗 关联：<目标卡片标题/摘录前缀>](url)` 行，不再被错误地包成 `[!note]` callout 中的自指 URL。当目标卡片在本次导出范围内能找到 title/excerpt 时取用作 label，否则回退为 `[🔗 关联卡片]`。
- **图片**：写入 `assets/{ZNOTEID}.png`，并以 `![](../assets/{ZNOTEID}.png)` 引用（标准 Markdown，Obsidian / VS Code / GitHub 通吃；通过 `--image-width N` 可启用 Obsidian 私有的 `![|N](...)` 限宽写法）。
- **回链**：每个节点末尾加 `[p.X](marginnote4app://note/{ZNOTEID})`，没有页码时退化为 `[>>](url)`。纯 ASCII label 最大化兼容 Obsidian 的 URL handler。

### 7. 图片处理

`ZHIGHLIGHT_PIC` 可能是：

- **二进制 plist**：从 `$objects` 中找到键 `paint` 对应的 hash，再到 `ZMEDIA` 中按 `ZMD5 IN (...)` 批量取 `ZDATA`；若 `ZDATA` 仍是 plist 包装，再次解出第一个 `bytes` 即真实图片。
- **直接的图片字节**：以 `\x89PNG`（PNG）或 `\xff\xd8`（JPEG）开头时直接使用。

所有图片统一存放在 `assets/`，文件名为 `{ZNOTEID}.png`，Markdown 内以相对路径引用。

### 8. 子思维导图递归导出

若节点的 `ZCHILDMAPNOTEID` 非空，会把它作为新的 Topic 递归导出，并：

- 始终输出到 `MindMaps/` 目录。
- 文件名前缀按"父标题 - 子标题"拼接，去掉 Obsidian wikilink 不友好的字符（`#`、`[`、`]`、`|`、`/` 等）。
- 同名时自动加 `(1)`、`(2)` 后缀。
- 通过全局 `visited_topics` 集合防止 mindmap 自循环。

### 9. Tags / 分类

`tags` 字段不再写入 `MarginNote`/`Book`/`Mindmap` 这种没有区分性的来源 tag——`doc_type`/`type` 字段已经标了类别。tag 来源是：

1. **MarginNote 主页"我的书架"中给该书打的分类**（来自 `ZBOOKCONFIG.ZTAGLIST` 关联到 `ZBOOKTAG`）。
   - 分类是树状嵌套的，导出时还原成 `祖先/父/自己` 的形式。例如 `应用研发/分布式系统技术`、`系统与设计/方法论`。
   - Obsidian 会同时把该 tag 解析为 `#应用研发`、`#应用研发/分布式系统技术` 两层，索引时都能搜到。
   - 一本书可以归属多个分类，全部输出。
2. **用户自己在 `ZNOTES_TEXT` 里手写的 `#hashtag`**：仍然提取，按使用频率排序，每本书最多保留 30 个。

如果一本书既没分类、批注里也没 hashtag，frontmatter 里就直接没有 `tags` 字段。

### 10. Frontmatter

每个导出文件以 YAML frontmatter 起头，便于 Obsidian dataview / templater 检索：

```yaml
---
doc_type: "marginnote-export"
topicId: "..."
title: "..."
type: "book"            # 或 mindmap
books:                  # 关联书籍（来自 ZBOOK）
  - "..."
authors:                # 关联作者
  - "..."
noteCount: 12
imageCount: 5
created: "2024-05-13 10:52:48"
lastVisit: "2024-05-17 11:24:27"
exported: "2026-05-16 18:00:00"
tags:
  - "应用研发/分布式系统技术"   # 来自 MarginNote 主页书架打的分类（嵌套）
  - "..."                  # 用户在 ZNOTES_TEXT 中写的 #hashtag（最多 30 个）
source: "MarginNote 4"
---
```

紧接 frontmatter 后是一个 `> [!info]+ 笔记本元信息` callout，含类型、关联书籍、作者、创建时间、最近访问、笔记/图片数量、跳回 MarginNote 的链接等。

## Books / MindMaps 重叠关系

MarginNote 中一段 PDF 划线可能同时存在于：

1. 你最初新建的 **Book Topic**；
2. 你后来从 Book 中"挑选 / 重组"得到的 **MindMap Topic**（节点会被复制成新 `ZNOTEID`，但 `ZBOOKMD5 + ZSTARTPOS` 不变）；
3. 直接在某个 **MindMap 中打开 PDF 标注**——这种情况下原 PDF 没有独立的 Book Topic。

因此这三种摘录关系在导出物里的表现：

- 「Book ∩ MindMap 都有」：同一段原文同时出现在 `Books/x.md` 和 `MindMaps/y.md`。
- 「仅 Book 有」：那些划过线但没拖进任何 mindmap 的散落笔记。
- 「仅 MindMap 有」：直接在 mindmap 中打开 PDF 标注的笔记，`Books/` 里完全找不到。

需要"全部内容"必须 `--all`；只看精选 → `--mindmaps-only`；只看原始划线 → `--books-only`。

## 已知边界情况

- 部分笔记本完全为空（只有 PDF 没有标注）会被跳过，不会生成空文件。
- MarginNote 内的链接节点（A 节点的 `ZMINDLINKS` 指向不在当前 Topic 范围内的节点 B）无法跨 Topic 跟随，但回链中保留了 `mn4://note/{ZNOTEID}` 的链接，仍可在 MarginNote 中跳转。
- PDF 字符空格清洗是启发式的，理论上可能误伤"刻意分行的英文短句"，目前阈值为 50% 单字 token，验证下来误伤率较低。
