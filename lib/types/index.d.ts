/**
 * @dsh-external/dsh-pdf-reader — PDF 文档查阅工具集。
 *
 * 提供四个模型可见工具：
 * - `pdf_inspect`：文档概览（页数、元数据与 XMP、目录、每页内容量与扫描件三态信号），决定如何读取；
 * - `pdf_read`：正文提取（单页 / 页码集合 / 全文），超长自动截断并回传每页字数；
 * - `pdf_find`：关键词搜索（NFKC + 大小写折叠 + 空白不敏感），返回命中页码与上下文片段；
 * - `pdf_render`：把页面渲染成 PNG/JPEG 文件（pdfjs + @napi-rs/canvas），拿到「渲染出来目视检查」
 *   的闭环，也是无文本层扫描件的答案——返回图而不是移植 OCR 栈。
 *
 * 输入统一为 `source`：本地路径（绝对或相对会话工作目录）、file:// 链接或 http(s) 网址
 * （URL 下载仅入内存，不落盘）。解析引擎为 pdfjs-dist（Node legacy build）。
 * 加密 PDF 以明确中文错误报告并给出 password 参数；无文本层扫描件返回空文本而不是损坏。
 * 全部输出受插件配置上限约束（见 Config）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-pdf-reader";
export declare const inject: string[];
/** Deployment caps and defaults for the PDF tools (all changeable from cordis.yml). */
export interface Config {
    /** Maximum characters returned by one `pdf_read` call; over-length output truncates. */
    maxCharsPerCall: number;
    /** Maximum pages scanned by one call (extract or search). */
    maxPagesPerCall: number;
    /** Maximum hits returned by one `pdf_find` call across pages. */
    maxSearchMatches: number;
    /** Character length of the per-page preview in `pdf_inspect`. */
    previewChars: number;
    /** Context characters kept on each side of a search match snippet. */
    contextChars: number;
    /** Maximum local PDF file size in bytes. */
    maxFileBytes: number;
    /** Maximum downloaded PDF body size in bytes. */
    maxDownloadBytes: number;
    /** Download timeout in milliseconds. */
    downloadTimeoutMs: number;
    /** Regex list of allowed URL hosts; empty allows any host. */
    allowedHosts: string[];
    /** Maximum pages one `pdf_render` call may render. */
    maxRenderPagesPerCall: number;
    /** Maximum pixels (width × height) of one rendered page. */
    maxRenderPixelsPerPage: number;
    /** Maximum total encoded bytes one `pdf_render` call may write. */
    maxRenderBytesPerCall: number;
    /** Default rendering resolution when the caller does not pass `dpi`. */
    defaultRenderDpi: number;
    /** Maximum images one `pdf_render` call may inline into the model-visible result. */
    maxInlineImages: number;
    /** Character count below which a page with images is reported as likely scanned. */
    scannedCharsThreshold: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    maxCharsPerCall: z<number, number>;
    maxPagesPerCall: z<number, number>;
    maxSearchMatches: z<number, number>;
    previewChars: z<number, number>;
    contextChars: z<number, number>;
    maxFileBytes: z<number, number>;
    maxDownloadBytes: z<number, number>;
    downloadTimeoutMs: z<number, number>;
    allowedHosts: z<string[], string[]>;
    maxRenderPagesPerCall: z<number, number>;
    maxRenderPixelsPerPage: z<number, number>;
    maxRenderBytesPerCall: z<number, number>;
    defaultRenderDpi: z<number, number>;
    maxInlineImages: z<number, number>;
    scannedCharsThreshold: z<number, number>;
}>, Schemastery.ObjectT<{
    maxCharsPerCall: z<number, number>;
    maxPagesPerCall: z<number, number>;
    maxSearchMatches: z<number, number>;
    previewChars: z<number, number>;
    contextChars: z<number, number>;
    maxFileBytes: z<number, number>;
    maxDownloadBytes: z<number, number>;
    downloadTimeoutMs: z<number, number>;
    allowedHosts: z<string[], string[]>;
    maxRenderPagesPerCall: z<number, number>;
    maxRenderPixelsPerPage: z<number, number>;
    maxRenderBytesPerCall: z<number, number>;
    defaultRenderDpi: z<number, number>;
    maxInlineImages: z<number, number>;
    scannedCharsThreshold: z<number, number>;
}>>;
/**
 * Parse a page selector into an explicit page list within the page count.
 *
 * Grammar (shared verbatim with `dsh-pdf-editor`'s `pdf_pages`, mirroring the小米 SKILL's
 * `text_dump.py`/`carve.py` semantics): `N` single page · `N-M` inclusive range · `N-` from N to the
 * end · `-M` from page 1 to M · `rN` the Nth page from the end · comma-separated lists of any of
 * those · `z` the last page. 1-based and inclusive; an out-of-range endpoint is an error rather than
 * a silent clamp.
 *
 * @param selector - the model-supplied selector.
 * @param pageCount - document page count.
 * @returns the page numbers in selector order, de-duplicated and 1-based.
 */
export declare function parsePages(selector: string | undefined, pageCount: number): number[];
export declare function apply(ctx: Context, config: Config): void;
