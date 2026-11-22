> **自用声明**：本仓是 [DSH-OrcaMind](https://github.com/HometownVoyager/DSH-OrcaMind) 个人工作区的自研插件独立发布仓，与 deepseek-ai 官方无关。路径按本机硬编码（Windows，工作区根 `D:\Tools\DeepSeek Harness`），不保证开箱即用；`*.local.json` 凭据文件不入库，缺失时按 README 说明重建。

# @dsh-external/dsh-pdf-reader

PDF 文档查阅工具集：向模型提供概览（含扫描件三态信号）、正文提取（全文 / 按页 / 页码集合）、关键词搜索与**页面渲染成图片**四个工具，解析引擎为 pdfjs-dist（Node legacy build），渲染用 `@napi-rs/canvas`（pdfjs-dist 的可选依赖，本机已随装）。输入支持本地文件路径（绝对路径或相对会话工作目录）、`file://` 链接与 http(s) 网址（下载仅入内存，不落盘）。

## 工具一览

| 工具 | 用途 |
|---|---|
| `pdf_inspect` | 文档概览：页数、元数据（信息字典 **与 XMP 并列**）、目录大纲树、每页内容量、**扫描页 triage**（`pages[].scanned_likely` / `scanned_pages` / `scanned_likely`）与结构信号（`form_field_count` / `xfa` / `js_actions`）。检查页数受 `maxPagesPerCall` 约束，超出部分只报页号并在 `pages_truncated` 标出 |
| `pdf_read` | 正文提取：`page`（单页）或 `range`（页码集合）；不指定时返回全文，超过 `maxCharsPerCall` 自动截断并回传每页字数，提示按页继续读取 |
| `pdf_find` | 关键词搜索：大小写不敏感、全半角（NFKC）与空白容错，返回命中页码、每页次数与上下文片段（各 60 字） |
| `pdf_render` | **页面渲染成 PNG/JPEG 文件**：`dpi`/`scale`、`format`/`quality`、页码选择，缺省写到 `<原名>-pages/`；`inline=true` 时把前几张图内联进结果（需要附件服务）。产出图片用 `read_image` 查看即可目视检查版式、公式、图表、盖章位置与扫描页 |

### 统一参数

- `source`：本地文件路径（相对路径按会话工作目录解析）、`file://` 链接或 http(s) 网址。
- `password`：PDF 打开口令。文档含 `/Encrypt` 字典时 `encrypted=true`；需要口令的文档报明确错误并提示用本参数，而不是「本插件不支持」。

### 页码范围语法（`pdf_read` / `pdf_find` / `pdf_render` 的 `range`）

`12` 单页 · `12-35` 区间 · `12-` 到末页 · `-35` 从首页 · `r2` 倒数第 2 页 · `z` 末页 · 逗号组合如 `3,7,10-`。1-based **闭区间**；越界是错误而不是静默截断（split 后丢页的第一大原因就是 off-by-one）。`dsh-pdf-editor` 的 `pdf_pages` 用同一套语法，有测试逐项比对两侧解析结果。

### 扫描件：渲染而不是重试提取

无文本层不是损坏。`pdf_inspect` 对「文本少于 `scannedCharsThreshold` 且该页画了图」的页报 `scanned_likely`，并在渲染文案里给出可执行的下一步：`pdf_render` 渲染该页 → `read_image` 打开图片 → 视觉判断。本插件**不做 OCR**，也不把「再试一次提取」当成答案。

### pdf_read 的大文档策略

不带 `page` / `range` 时返回全文、不做分割；当文档较小（不超过 `maxCharsPerCall`）一次即可读完。超过上限时结果带 `truncated: true` 与 `chars_per_page` 每页字数表（只列**实际返回**的页），模型据此用 `range` 分段深入。

### pdf_find 的上限语义

`total_matches` 是已统计页的实际命中数（永不超过 `max_matches`），每条命中同时给出 `count`（该页命中总数）与 `reported`（计入本次上限的数量）；`truncated` 表示因上限只报了一部分。三者含义分开，便于判断「还有没有」。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `maxCharsPerCall` | 20000 | 单次 `pdf_read` 返回字符上限 |
| `maxPagesPerCall` | 100 | 单次调用解析页数上限（`pdf_inspect` 的检查、`pdf_read`、`pdf_find` 共用） |
| `maxSearchMatches` | 50 | `pdf_find` 跨页命中数上限 |
| `previewChars` | 120 | `pdf_inspect` 每页预览长度 |
| `contextChars` | 60 | 搜索片段上下文长度 |
| `maxFileBytes` | 209715200 (200MB) | 本地文件体积上限 |
| `maxDownloadBytes` | 104857600 (100MB) | URL 下载体积上限 |
| `downloadTimeoutMs` | 30000 | URL 下载超时 |
| `allowedHosts` | 空（全部允许） | URL 主机白名单正则列表，如 `['^127\\.0\\.0\\.1$']` |
| `maxRenderPagesPerCall` | 10 | 单次 `pdf_render` 渲染页数上限 |
| `maxRenderPixelsPerPage` | 4000000 | 单页像素上限（超限报错并给出可用 dpi） |
| `maxRenderBytesPerCall` | 41943040 (40MB) | 单次渲染写出总字节上限；单张超限即报错，累计超限则停止并如实报告 |
| `defaultRenderDpi` | 96 | 未传 `dpi`/`scale` 时的默认分辨率 |
| `maxInlineImages` | 3 | 单次 `pdf_render` 可内联进结果的图片数上限 |
| `scannedCharsThreshold` | 40 | 低于该字符数且画了图的页报 `scanned_likely` |

## 错误与限制

- 加密文档以明确错误提示需要口令，并提供 `password` 参数解锁；含 `/Encrypt` 字典的文档 `encrypted` 字段为 `true`（由 trailer 扫描判定，不再依赖 pdf.js 主线程看不到的属性）。
- 无文本层的扫描件不报错但返回空文本；本插件不含 OCR——答案是 `pdf_render` 渲染成图交给视觉检查。
- 渲染需要 `@napi-rs/canvas`；缺失时报明确错误（不会连累文本提取）。
- 单次页数超过 `maxPagesPerCall` / `maxRenderPagesPerCall` 时拒绝执行并提示缩小范围；`pdf_inspect` 只检查该上限内的页并如实标出未检查的页号。
- 聊天附件（`@` 引用路径）一期不承诺专门支持，但若附件映射为磁盘路径则按本地路径处理。

## 构建、测试与注入

```bash
# 生成测试夹具（pdf-lib + simhei.ttf，仅 devDependency）
node tests/make-fixtures.mjs

# P0 回归：加密探测、worker 释放、页码语法、字宽、行聚类
node tests/p0-regression.mjs

# 端到端验证（提取、分页、范围、截断、搜索容错、上限语义、URL 下载、错误路径）
node tests/e2e.mjs

# 渲染：D16 的 standard_fonts 关键路径、dpi/scale/格式、页选择与上限、内联图像块
node tests/render.mjs

# 三态信号与元数据：XMP 保留、D: 日期解析、表单/XFA/脚本、扫描页 triage、跨插件语法一致
node tests/triage.mjs

# 纯文本模型路由下核对渲染图几何：数像素回答「内容画出来了吗 / 盖章落在请求的位置吗」
node tests/pixel-probe.mjs <png> 595.28 841.89 110 --region 50,640,545,710

# 构建（需要 DSH_CHECKOUT 指向 dsh 源码树）
DSH_CHECKOUT=D:/Tools/DeepSeek Harness/source bash scripts/build.sh

# 装载：由预设以绝对 file: URL 随身携带（见 Plugins/dsh-user-presets/cordis.patch.yml），改动后重启 DSH 生效
```

## 已知限制与后续方向

- 文本行重建基于 PDF 几何坐标（优先用 pdf.js 给出的 `width`，缺省时才退化为按字号估计），复杂排版（多栏报纸式版面）的阅读顺序仍可能与视觉顺序不一致。
- 公式、表格与图像内容无法提取（文本层之外的内容）；表格抽取需要自己的几何算法，未实现。
- URL 抓取无缓存，同一文档多次读取会重复下载；调用之间也没有解析缓存（`pdf_inspect` 之后 `pdf_read` 会重新解析一次）。文档级缓存涉及 pdfjs worker 的生命周期，收益小于风险，因此未做。
- 页面写操作（合并/拆分/旋转/水印/AcroForm/元数据）在 `dsh-pdf-editor` 插件里，本插件保持只读（`pdf_render` 只写图片文件）。
