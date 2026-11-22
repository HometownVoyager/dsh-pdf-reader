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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { openPdf, describePdfError } from './pdfjs.js';
import { resolveSource } from './source.js';
import { normalizeForMatch, searchPageFor } from './search.js';
import { isoDateOrRaw, parsePdfDate, parseXmp } from './xmp.js';
import { deriveRenderDir, resolveOutputDir, sanitizeFileName, stemOf, writeImage } from './output.js';
export const name = '@dsh-external/dsh-pdf-reader';
export const inject = ['tools'];
export const Config = z.object({
    maxCharsPerCall: z.number().default(20000),
    maxPagesPerCall: z.number().default(100),
    maxSearchMatches: z.number().default(50),
    previewChars: z.number().default(120),
    contextChars: z.number().default(60),
    maxFileBytes: z.number().default(200 * 1024 * 1024),
    maxDownloadBytes: z.number().default(100 * 1024 * 1024),
    downloadTimeoutMs: z.number().default(30000),
    allowedHosts: z.array(z.string()).default([]),
    maxRenderPagesPerCall: z.number().default(10),
    maxRenderPixelsPerPage: z.number().default(4_000_000),
    maxRenderBytesPerCall: z.number().default(40 * 1024 * 1024),
    defaultRenderDpi: z.number().default(96),
    maxInlineImages: z.number().default(3),
    scannedCharsThreshold: z.number().default(40),
});
const SOURCE_DESC = 'PDF 来源：本地文件路径（绝对路径或相对会话工作目录）、file:// 链接或 http(s) 网址';
const PAGE_GRAMMAR = '页码语法：12 单页、12-35 区间、12- 到末页、-35 从首页、r2 倒数第 2 页、z 末页，可逗号组合如 "3,7,10-"';
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
export function parsePages(selector, pageCount) {
    const text = selector?.trim() ?? '';
    if (text === '')
        return [];
    const pages = [];
    const seen = new Set();
    const push = (page, token) => {
        if (!Number.isInteger(page) || page < 1 || page > pageCount) {
            throw new Error(`页码范围 ${token} 解析出第 ${page} 页，超出文档页数（共 ${pageCount} 页）`);
        }
        if (seen.has(page))
            return;
        seen.add(page);
        pages.push(page);
    };
    for (const part of text.split(',')) {
        const token = part.trim();
        if (token === '')
            continue;
        if (/^z$/iu.test(token)) {
            push(pageCount, token);
            continue;
        }
        const fromEnd = /^r\s*(\d+)$/iu.exec(token);
        if (fromEnd !== null) {
            push(pageCount - Number(fromEnd[1]) + 1, token);
            continue;
        }
        const openStart = /^-\s*(\d+)$/u.exec(token);
        if (openStart !== null) {
            const last = Number(openStart[1]);
            for (let p = 1; p <= last; p++)
                push(p, token);
            continue;
        }
        const openEnd = /^(\d+)\s*-$/u.exec(token);
        if (openEnd !== null) {
            for (let p = Number(openEnd[1]); p <= pageCount; p++)
                push(p, token);
            continue;
        }
        const range = /^(\d+)\s*-\s*(\d+)$/u.exec(token);
        if (range !== null) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (last < first)
                throw new Error(`页码范围 ${token} 的结束页小于起始页`);
            for (let p = first; p <= last; p++)
                push(p, token);
            continue;
        }
        const single = /^(\d+)$/u.exec(token);
        if (single === null) {
            throw new Error(`页码范围格式无效：${token}（可用：12 单页、12-35 区间、12- 到末页、-35 从首页、r2 倒数第 2 页、z 末页，或逗号分隔的组合如 3,7,10-）`);
        }
        push(Number(single[1]), token);
    }
    return pages;
}
/** Open the source and return the handle; `finally` must call {@link CallContext#dispose}. */
async function openSource(source, exec, caps, password) {
    const resolved = await resolveSource(source, exec, caps);
    const pdf = await openPdf(resolved.bytes, password);
    return {
        displayName: resolved.displayName,
        localPath: resolved.localPath,
        pageCount: pdf.pageCount,
        encrypted: pdf.encrypted,
        info: pdf.info,
        xmpRaw: pdf.xmpRaw,
        formFieldCount: pdf.formFieldCount,
        isPureXfa: pdf.isPureXfa,
        hasJSActions: pdf.hasJSActions,
        outline: pdf.outline,
        extract: (pageNumber, options) => pdf.extractPage(pageNumber, options),
        pageSize: (pageNumber) => pdf.pageSize(pageNumber),
        render: (pageNumber, options) => pdf.renderPage(pageNumber, options),
        dispose: () => pdf.dispose(),
    };
}
/** Extract one page, translating pdf.js failures into user-facing errors. */
async function extractOne(pdf, page, signal, options) {
    try {
        const result = await pdf.extract(page, options);
        signal.throwIfAborted();
        return result;
    }
    catch (error) {
        throw new Error(describePdfError(error));
    }
}
/** Select page numbers capped by `maxPagesPerCall`. */
function selectPages(selector, pageCount, maxPages) {
    const pages = parsePages(selector, pageCount);
    if (pages.length > maxPages) {
        throw new Error(`本次读取 ${pages.length} 页超过单次上限 ${maxPages} 页，请缩小页码范围分段读取`);
    }
    return pages;
}
export function apply(ctx, config) {
    const caps = {
        maxFileBytes: config.maxFileBytes,
        maxDownloadBytes: config.maxDownloadBytes,
        downloadTimeoutMs: config.downloadTimeoutMs,
        allowedHosts: config.allowedHosts,
    };
    // ---------- pdf_inspect：概览 ----------
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'pdf_inspect',
        description: [
            '查看 PDF 文档概览：页数、元数据（信息字典 + XMP）、目录结构、每页内容量与扫描件三态信号，用于决定如何提取正文。',
            `预览扫描受单次页数上限（${config.maxPagesPerCall} 页）约束，超出部分只报页号并在 pages_truncated 标出。`,
            'scanned_likely / pages[].scanned_likely 表示「该页几乎没有文本层但画了图」——这类页的答案是 pdf_render 渲染成图而不是反复重试文本提取（本插件不做 OCR）。',
            'form_field_count / xfa / js_actions 给出表单与脚本的三态信号；encrypted=true 时用 password 参数提供口令即可读取。',
        ].join(''),
        parameters: {
            source: { type: 'string', required: true, description: SOURCE_DESC },
            max_levels: { type: 'number', description: '目录大纲的最大层级深度（默认 3）' },
            password: { type: 'string', description: 'PDF 打开口令（仅当文档加密时需要）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true },
                    page_count: { type: 'integer', required: true },
                    encrypted: { type: 'boolean', required: true, description: '文档是否含 /Encrypt 字典（真实探测，不再恒为 false）' },
                    inspected_pages: { type: 'integer', required: true, description: '实际提取了预览的页数' },
                    pages_truncated: { type: 'boolean', required: true, description: '是否因页数上限而只报了部分页的内容量' },
                    scanned_pages: { type: 'integer', required: true, description: '被判为「疑似扫描页」的页数' },
                    scanned_likely: { type: 'boolean', required: true, description: '已检查的页里是否多数疑似扫描页（整份文档像扫描件）' },
                    form_field_count: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true, description: 'AcroForm 字段数；文档无表单时为 null' },
                    xfa: { type: 'boolean', required: true, description: '是否为纯 XFA 表单（这类表单不能按字段名逐个填）' },
                    js_actions: { type: 'boolean', required: true, description: '是否带文档级 JavaScript 动作' },
                    warnings: { type: 'array', required: true, items: { type: 'string' }, description: '元数据层面的提示（如无法解析的日期）' },
                    metadata: {
                        type: 'object',
                        additionalProperties: false,
                        required: true,
                        properties: {
                            title: { type: 'string' },
                            author: { type: 'string' },
                            subject: { type: 'string' },
                            keywords: { type: 'string' },
                            created: { type: 'string', description: 'ISO 8601（能解析时）' },
                            modified: { type: 'string', description: 'ISO 8601（能解析时）' },
                            producer: { type: 'string' },
                            creator: { type: 'string' },
                            xmp_present: { type: 'boolean', required: true },
                            xmp: {
                                type: 'object',
                                additionalProperties: false,
                                required: true,
                                description: 'XMP 包里的同名事实；与信息字典不一致时以两者并列呈现',
                                properties: {
                                    title: { type: 'string' },
                                    creator: { type: 'string' },
                                    description: { type: 'string' },
                                    keywords: { type: 'string' },
                                    producer: { type: 'string' },
                                    created: { type: 'string' },
                                    modified: { type: 'string' },
                                    metadata_date: { type: 'string' },
                                },
                            },
                        },
                    },
                    outline: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                level: { type: 'integer', required: true },
                                title: { type: 'string', required: true },
                            },
                        },
                    },
                    pages: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                page: { type: 'integer', required: true },
                                chars: { type: 'integer', required: true, description: '页字符数；-1 表示未扫描（超出页数预算）' },
                                images: { type: 'integer', required: true, description: '页面绘制的图片数；-1 表示未统计（文本充足或未扫描）' },
                                scanned_likely: { type: 'boolean', required: true },
                                preview: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderInspect(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            return inspectPdf(args, exec, caps, config);
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `Inspect ${basename(args.source)}`,
            kind: 'read',
            ...isLocalPath(args.source) ? { locations: [{ path: args.source }] } : {},
        }),
    })), 'pdf_inspect');
    // ---------- pdf_render：页面渲染成图片 ----------
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'pdf_render',
        description: [
            '把 PDF 页面渲染成 PNG/JPEG 文件（pdfjs + @napi-rs/canvas），用于「渲染出来目视检查」：版式、公式、图表、盖章位置、以及无文本层的扫描页。',
            '产出写到 output 目录（缺省 <原名>-pages/），返回每页图片路径与像素尺寸；用 read_image 工具查看这些文件即可目视检查。',
            `range 语法同 pdf_read；省略时渲染前 ${config.maxRenderPagesPerCall} 页并在 truncated 标出。dpi 缺省 ${config.defaultRenderDpi}（1 point = dpi/72 像素），单页像素上限 ${config.maxRenderPixelsPerPage}。`,
            'inline=true 时最多把前几张图直接内联进结果（需要宿主提供附件服务）；未提供时会如实提示并仍然落盘。',
            '本工具不做 OCR：扫描页渲染出来是给人（或视觉模型）看的图，不是文本。',
        ].join(''),
        parameters: {
            source: { type: 'string', required: true, description: SOURCE_DESC },
            range: { type: 'string', description: `要渲染的页面（${PAGE_GRAMMAR}）；省略则渲染前 ${config.maxRenderPagesPerCall} 页` },
            page: { type: 'number', description: '要渲染的单页页码（与 range 二选一）' },
            dpi: { type: 'number', description: `渲染分辨率（缺省 ${config.defaultRenderDpi}）` },
            scale: { type: 'number', description: '直接给缩放系数（1 = 72dpi），与 dpi 二选一，优先 scale' },
            format: { type: 'string', enum: ['png', 'jpeg'], description: '输出格式（缺省 png；jpeg 体积更小）' },
            quality: { type: 'number', description: 'JPEG 质量 0-100（缺省 80，仅 format=jpeg 有效）' },
            output: { type: 'string', description: '输出目录（缺省 <源文件同目录>/<原名>-pages/；http(s) 来源必须显式指定）' },
            overwrite: { type: 'boolean', description: '允许覆盖已存在的图片文件' },
            inline: { type: 'boolean', description: `把前 ${config.maxInlineImages} 张渲染图内联进结果（默认 false，仅落盘）` },
            password: { type: 'string', description: 'PDF 打开口令（仅当文档加密时需要）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true },
                    page_count: { type: 'integer', required: true },
                    output_dir: { type: 'string', required: true },
                    rendered: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                page: { type: 'integer', required: true },
                                path: { type: 'string', required: true },
                                width: { type: 'integer', required: true },
                                height: { type: 'integer', required: true },
                                bytes: { type: 'integer', required: true },
                                inline: {
                                    type: 'object',
                                    additionalProperties: false,
                                    description: '内联成功时的附件引用（attachment_id 由附件服务签发，本插件只是转交）',
                                    properties: {
                                        attachment_id: { type: 'string', required: true },
                                        media_type: { type: 'string', required: true },
                                        bytes: { type: 'integer', required: true },
                                        width: { type: 'integer', required: true },
                                        height: { type: 'integer', required: true },
                                        name: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    scale: { type: 'number', required: true },
                    dpi: { type: 'number', required: true },
                    format: { type: 'string', required: true },
                    total_bytes: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                    inline_images: { type: 'integer', required: true, description: '实际内联进结果的图片数' },
                    warnings: { type: 'array', required: true, items: { type: 'string' } },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderRender(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            return renderPdf(ctx, args, exec, caps, config);
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `Render ${basename(args.source)}${args.page !== undefined ? ` (p${args.page})` : args.range !== undefined ? ` (${args.range})` : ''}`,
            kind: 'read',
            ...isLocalPath(args.source) ? { locations: [{ path: args.source }] } : {},
        }),
    })), 'pdf_render');
    // ---------- pdf_read：正文提取 ----------
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'pdf_read',
        description: [
            '提取 PDF 正文文本：支持单页（page）、页码集合（range）；不指定时返回全文，超长自动截断并在结果中提示每页字数以便继续按页读取。',
            'range 语法：12 单页、12-35 区间、12- 到末页、-35 从首页、r2 倒数第 2 页、z 末页，可逗号组合如 "3,7,10-"；1-based 闭区间。',
            '无文本层（扫描件）返回空文本而不是损坏：这类页请改用 pdf_render 渲染成图片目视检查，本插件不做 OCR。加密文档需用 password 提供打开口令。',
        ].join(''),
        parameters: {
            source: { type: 'string', required: true, description: SOURCE_DESC },
            page: { type: 'number', description: '要读取的单页页码（与 range 二选一）' },
            range: { type: 'string', description: '页码范围（与 page 二选一），如 "12-35"、"3,7,10-"、"-5"、"z"；省略则读取全文' },
            password: { type: 'string', description: 'PDF 打开口令（仅当文档加密时需要）' },
            max_chars: { type: 'number', description: `本次返回的最大字符数（默认与上限 ${config.maxCharsPerCall}）` },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true },
                    page_count: { type: 'integer', required: true },
                    mode: { type: 'string', required: true },
                    requested: { type: 'string', required: true },
                    pages: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                page: { type: 'integer', required: true },
                                chars: { type: 'integer', required: true },
                                text: { type: 'string', required: true },
                            },
                        },
                    },
                    total_chars: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                    chars_per_page: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                page: { type: 'integer', required: true },
                                chars: { type: 'integer', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            return readPdf(args, exec, caps, config);
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `Read ${basename(args.source)}${args.page !== undefined ? ` (p${args.page})` : args.range !== undefined ? ` (${args.range})` : ' (full)'}`,
            kind: 'read',
            ...isLocalPath(args.source) ? { locations: [{ path: args.source }] } : {},
        }),
    })), 'pdf_read');
    // ---------- pdf_find：关键词搜索 ----------
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'pdf_find',
        description: [
            '在 PDF 中搜索关键词：大小写不敏感、全半角与空白容错，返回命中页码、每页次数与上下文片段。',
            'range 语法同 pdf_read（12 / 12-35 / 12- / -35 / z / 逗号组合）。',
            'total_matches 为已统计页的实际命中总数；truncated 表示因上限只报了一部分，两者含义分开。',
        ].join(''),
        parameters: {
            source: { type: 'string', required: true, description: SOURCE_DESC },
            query: { type: 'string', required: true, description: '要搜索的关键词或短语' },
            page: { type: 'number', description: '只搜索单页（与 range 二选一）' },
            range: { type: 'string', description: '只搜索页码范围，如 "12-35"、"3,7,10-"（与 page 二选一）' },
            password: { type: 'string', description: 'PDF 打开口令（仅当文档加密时需要）' },
            max_matches: { type: 'number', description: `返回命中数上限（默认 ${config.maxSearchMatches}）` },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true },
                    page_count: { type: 'integer', required: true },
                    query: { type: 'string', required: true },
                    matches: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                page: { type: 'integer', required: true },
                                count: { type: 'integer', required: true, description: '该页实际命中总数' },
                                reported: { type: 'integer', required: true, description: '该页计入 total_matches 的命中数（受全局上限约束）' },
                                snippets: {
                                    type: 'array',
                                    required: true,
                                    items: { type: 'string' },
                                },
                            },
                        },
                    },
                    total_matches: { type: 'integer', required: true },
                    searched_pages: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderFind(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            return findPdf(args, exec, caps, config);
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `Find "${args.query}" in ${basename(args.source)}`,
            kind: 'search',
            ...isLocalPath(args.source) ? { locations: [{ path: args.source }] } : {},
        }),
    })), 'pdf_find');
}
/**
 * Inspect a PDF: page count, metadata (dictionary + XMP), outline, and a bounded per-page preview.
 *
 * The preview budget is `maxPagesPerCall` — the same configured page budget every other call
 * honours — instead of the old behaviour of extracting every page and only budgeting the
 * *previews*, which serially extracted an unbounded number of pages (report D2). Pages beyond the
 * budget are reported with their number only, and `pages_truncated` says so.
 *
 * Each scanned page is also triaged: a page whose text is below `scannedCharsThreshold` **and** that
 * paints an image is reported as `scanned_likely`, because "no text layer" has two very different
 * causes (a scan, or a genuinely image-only page) and the answer for both is `pdf_render`, not a
 * retry of text extraction.
 */
async function inspectPdf(args, exec, caps, config) {
    if (args.source.trim() === '')
        throw new Error('source 参数不能为空');
    const pdf = await openSource(args.source, exec, caps, args.password);
    try {
        const maxLevels = Math.max(1, args.max_levels ?? 3);
        const previewLimit = config.previewChars;
        const budget = Math.max(0, config.maxPagesPerCall);
        const scanned = Math.min(pdf.pageCount, budget);
        const pages = [];
        for (let p = 1; p <= scanned; p++) {
            exec.signal.throwIfAborted();
            // Ask for image operators only when the page looks text-poor: the operator list is the
            // expensive part, and this is the only signal that separates a scan from an empty page.
            const cheap = await extractOne(pdf, p, exec.signal);
            let images = -1;
            if (cheap.chars < config.scannedCharsThreshold) {
                const withImages = await extractOne(pdf, p, exec.signal, { withImages: true });
                images = withImages.images;
            }
            pages.push({
                page: p,
                chars: cheap.chars,
                images,
                scanned_likely: images > 0 && cheap.chars < config.scannedCharsThreshold,
                ...(cheap.text === '' ? {} : { preview: cheap.text.slice(0, previewLimit) }),
            });
        }
        for (let p = scanned + 1; p <= pdf.pageCount; p++)
            pages.push({ page: p, chars: -1, images: -1, scanned_likely: false });
        const scannedPages = pages.filter((entry) => entry.scanned_likely).length;
        const metadata = toMetadata(pdf.info);
        const xmp = parseXmp(pdf.xmpRaw);
        const warnings = [];
        for (const field of ['created', 'modified']) {
            const raw = metadata[field];
            if (raw !== undefined && parsePdfDate(raw) === null)
                warnings.push(`${field === 'created' ? '创建时间' : '修改时间'}无法解析为日期，已原样回报：${raw}`);
        }
        return {
            source: pdf.displayName,
            page_count: pdf.pageCount,
            encrypted: pdf.encrypted,
            metadata: { ...metadata, xmp, xmp_present: pdf.xmpRaw !== null },
            outline: (pdf.outline ?? []).filter((item) => item.level <= maxLevels),
            form_field_count: pdf.formFieldCount,
            xfa: pdf.isPureXfa,
            js_actions: pdf.hasJSActions,
            scanned_pages: scannedPages,
            scanned_likely: scanned > 0 && scannedPages > 0 && scannedPages * 2 >= scanned,
            pages,
            pages_truncated: pdf.pageCount > scanned,
            inspected_pages: scanned,
            warnings,
        };
    }
    finally {
        await pdf.dispose();
    }
}
async function readPdf(args, exec, caps, config) {
    if (args.page !== undefined && args.range !== undefined)
        throw new Error('page 与 range 不能同时指定');
    const pdf = await openSource(args.source, exec, caps, args.password);
    try {
        const selector = args.range ?? (args.page !== undefined ? String(args.page) : undefined);
        const pagesToRead = selector === undefined
            ? [...Array(pdf.pageCount)].map((_, i) => i + 1)
            : parsePages(selector, pdf.pageCount);
        if (pagesToRead.length === 0)
            throw new Error('页码范围为空，请检查 range 参数');
        if (pagesToRead.length > config.maxPagesPerCall) {
            throw new Error(`本次读取 ${pagesToRead.length} 页超过单次上限 ${config.maxPagesPerCall} 页，请缩小页码范围分段读取`);
        }
        const requestedMax = args.max_chars ?? config.maxCharsPerCall;
        if (!Number.isFinite(requestedMax) || requestedMax <= 0)
            throw new Error('max_chars 必须为正数');
        const maxChars = Math.floor(Math.min(requestedMax, config.maxCharsPerCall));
        const mode = selector === undefined ? 'full' : args.page !== undefined ? 'page' : 'range';
        const requested = selector ?? `1-${pdf.pageCount}`;
        const charsPerPage = [];
        // Projected to the schema's three fields: the extractor also reports layout signals that the
        // read result does not declare.
        const pages = [];
        let total = 0;
        let truncated = false;
        for (const p of pagesToRead) {
            exec.signal.throwIfAborted();
            const pageText = await extractOne(pdf, p, exec.signal);
            const remaining = maxChars - total;
            if (pageText.text.length <= remaining) {
                // Only pages actually returned are reported, so `chars_per_page` never describes a page
                // the caller cannot see (the old code disagreed with itself about the last page's length).
                charsPerPage.push({ page: p, chars: pageText.chars });
                pages.push({ page: pageText.page, chars: pageText.chars, text: pageText.text });
                total += pageText.chars;
                continue;
            }
            if (remaining > 0) {
                charsPerPage.push({ page: p, chars: pageText.chars });
                pages.push({ page: p, chars: remaining, text: pageText.text.slice(0, remaining) });
                total += remaining;
            }
            truncated = true;
            break;
        }
        return {
            source: pdf.displayName,
            page_count: pdf.pageCount,
            mode,
            requested,
            pages,
            total_chars: total,
            truncated,
            chars_per_page: charsPerPage,
        };
    }
    finally {
        await pdf.dispose();
    }
}
async function findPdf(args, exec, caps, config) {
    if (args.page !== undefined && args.range !== undefined)
        throw new Error('page 与 range 不能同时指定');
    const query = args.query.trim();
    if (query === '')
        throw new Error('query 不能为空');
    const queryNorm = normalizeForMatch(query);
    if (queryNorm === '')
        throw new Error('query 输入无效（全部为空白字符）');
    const pdf = await openSource(args.source, exec, caps, args.password);
    try {
        const selector = args.range ?? (args.page !== undefined ? String(args.page) : undefined);
        const pagesToSearch = selector === undefined
            ? [...Array(pdf.pageCount)].map((_, i) => i + 1)
            : parsePages(selector, pdf.pageCount);
        if (pagesToSearch.length === 0)
            throw new Error('页码范围为空，请检查 range 参数');
        if (pagesToSearch.length > config.maxPagesPerCall) {
            throw new Error(`本次搜索 ${pagesToSearch.length} 页超过单次上限 ${config.maxPagesPerCall} 页，请缩小页码范围`);
        }
        const maxMatches = Math.max(1, Math.min(args.max_matches ?? config.maxSearchMatches, config.maxSearchMatches));
        const matches = [];
        let total = 0;
        let truncated = false;
        let searched = 0;
        for (const p of pagesToSearch) {
            exec.signal.throwIfAborted();
            if (total >= maxMatches)
                break;
            searched++;
            const pageText = await extractOne(pdf, p, exec.signal);
            const result = searchPageFor(p, pageText.text, queryNorm, config.contextChars, 5);
            if (result.count === 0)
                continue;
            // Keep the per-page count honest even when only some hits fit the output budget: report
            // `reported` next to `count` and stop adding once the global cap is reached.
            const room = maxMatches - total;
            if (room <= 0)
                break;
            const reported = Math.min(result.count, room);
            matches.push({ page: p, count: result.count, reported, snippets: result.snippets.slice(0, Math.max(1, Math.min(5, room))) });
            total += reported;
            if (reported < result.count)
                truncated = true;
            else if (result.snippets.length < result.count)
                truncated = true;
        }
        if (searched < pagesToSearch.length)
            truncated = true;
        return {
            source: pdf.displayName,
            page_count: pdf.pageCount,
            query,
            matches,
            total_matches: total,
            searched_pages: searched,
            truncated,
        };
    }
    finally {
        await pdf.dispose();
    }
}
/**
 * Render pages to image files, optionally inlining the first few into the result.
 *
 * The images are written first and inlined second: the file path is what `read_image` and any
 * later review needs, and the inline copy is a convenience that depends on a service the
 * deployment may not mount. Both outcomes are reported, so a missing attachment service never
 * silently degrades into "rendered nothing".
 */
async function renderPdf(ctx, args, exec, caps, config) {
    if (args.page !== undefined && args.range !== undefined)
        throw new Error('page 与 range 不能同时指定');
    if (args.source.trim() === '')
        throw new Error('source 参数不能为空');
    const requestedScale = args.scale ?? (args.dpi ?? config.defaultRenderDpi) / 72;
    if (!Number.isFinite(requestedScale) || requestedScale <= 0)
        throw new Error('scale/dpi 必须为正数');
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = Math.min(100, Math.max(1, Math.floor(args.quality ?? 80)));
    const pdf = await openSource(args.source, exec, caps, args.password);
    const warnings = [];
    try {
        const selector = args.range ?? (args.page !== undefined ? String(args.page) : undefined);
        if (selector === undefined) {
            const limit = Math.min(pdf.pageCount, config.maxRenderPagesPerCall);
            if (pdf.pageCount > limit)
                warnings.push(`未指定 range：只渲染前 ${limit} 页（共 ${pdf.pageCount} 页），可用 range 指定其余页面`);
            return await renderSelection(ctx, pdf, [...Array(limit)].map((_, index) => index + 1), requestedScale, format, quality, args, exec, config, warnings);
        }
        const pages = parsePages(selector, pdf.pageCount);
        if (pages.length === 0)
            throw new Error('页码范围为空，请检查 range 参数');
        if (pages.length > config.maxRenderPagesPerCall) {
            throw new Error(`本次要渲染 ${pages.length} 页，超过单次上限 ${config.maxRenderPagesPerCall} 页，请缩小范围分段渲染`);
        }
        return await renderSelection(ctx, pdf, pages, requestedScale, format, quality, args, exec, config, warnings);
    }
    finally {
        await pdf.dispose();
    }
}
async function renderSelection(ctx, pdf, pages, scale, format, quality, args, exec, config, warnings) {
    const outDir = args.output === undefined || args.output.trim() === ''
        ? await resolveOutDirFor(pdf, exec)
        : await resolveOutputDir(exec, args.output, 'output');
    const stem = sanitizeFileName(stemOf(pdf.localPath ?? 'document'));
    const rendered = [];
    let totalBytes = 0;
    let truncated = false;
    for (const page of pages) {
        exec.signal.throwIfAborted();
        const size = await pdf.pageSize(page);
        const width = Math.max(1, Math.ceil(size.width * scale));
        const height = Math.max(1, Math.ceil(size.height * scale));
        if (width * height > config.maxRenderPixelsPerPage) {
            const maxDpi = Math.floor(Math.sqrt(config.maxRenderPixelsPerPage / (size.width * size.height)) * 72);
            throw new Error(`第 ${page} 页按 ${Math.round(scale * 72)}dpi 渲染为 ${width}×${height} 像素，超过单页上限 ${config.maxRenderPixelsPerPage}；请把 dpi 降到 ${Math.max(1, maxDpi)} 或更小（也可用 format=jpeg 减小体积）`);
        }
        const image = await pdf.render(page, { scale, format, quality });
        const target = join(outDir, `${stem}-p${page}.${format === 'png' ? 'png' : 'jpg'}`);
        await writeImage(target, image.bytes, args.overwrite === true, config.maxRenderBytesPerCall);
        rendered.push({ page, path: target, width: image.width, height: image.height, bytes: image.bytes.byteLength });
        totalBytes += image.bytes.byteLength;
        if (totalBytes > config.maxRenderBytesPerCall) {
            // The files already written stay; the rest is reported rather than failing the whole call.
            truncated = true;
            warnings.push(`累计渲染体积 ${Math.round(totalBytes / 1024 / 1024)}MB 超过单次上限，已停止渲染剩余页面（可用 format=jpeg、降低 dpi 或分段渲染）`);
            break;
        }
    }
    let inlineCount = 0;
    if (args.inline === true) {
        const attachments = ctx.get('attachments');
        if (attachments === undefined || typeof attachments.saveImage !== 'function') {
            warnings.push('宿主未挂载附件服务（attachments），渲染图只落盘未内联；用 read_image 查看这些文件');
        }
        else {
            const limit = Math.max(0, Math.min(config.maxInlineImages, rendered.length));
            for (const entry of rendered.slice(0, limit)) {
                const bytes = await readFileBytes(entry.path);
                const ref = await attachments.saveImage({
                    data: bytes,
                    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
                    name: `${stem}-p${entry.page}.${format === 'png' ? 'png' : 'jpg'}`,
                });
                entry.inline = {
                    attachment_id: String(ref.attachmentId),
                    media_type: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...(ref.name === undefined ? {} : { name: ref.name }),
                };
                inlineCount++;
            }
            if (rendered.length > limit)
                warnings.push(`内联上限为 ${limit} 张，其余 ${rendered.length - limit} 张只落盘`);
        }
    }
    const inlineTip = inlineCount > 0 ? `；已内联 ${inlineCount} 张` : '；用 read_image 查看';
    return {
        source: pdf.displayName,
        page_count: pdf.pageCount,
        output_dir: outDir,
        rendered,
        scale,
        dpi: Math.round(scale * 72),
        format,
        total_bytes: totalBytes,
        truncated: truncated || pages.length < pdf.pageCount,
        inline_images: inlineCount,
        warnings,
        summary: `渲染第 ${pages.join('、')} 页 → ${rendered.length} 张 ${format.toUpperCase()}（${Math.round(scale * 72)}dpi，共 ${Math.round(totalBytes / 1024)}KB）${inlineTip}`,
    };
}
/** Resolve the default render directory, which requires a local source. */
async function resolveOutDirFor(pdf, exec) {
    if (pdf.localPath === null)
        throw new Error('来源是 http(s) 链接，必须显式给 output 目录才能写渲染图');
    const dir = deriveRenderDir(pdf.localPath);
    await mkdir(dir, { recursive: true });
    return dir;
}
async function readFileBytes(path) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(path));
}
/** Build the model-facing content: the text summary plus one image block per inlined render. */
function renderRender(value) {
    const lines = [
        `PDF 渲染：${value.source}`,
        value.summary,
        `输出目录：${value.output_dir}`,
    ];
    for (const entry of value.rendered) {
        lines.push(`第 ${entry.page} 页：${entry.path}（${entry.width}×${entry.height}px，${Math.round(entry.bytes / 1024)}KB）`);
    }
    for (const warning of value.warnings)
        lines.push(`注意：${warning}`);
    if (value.inline_images === 0)
        lines.push('（用 read_image 工具打开上面的图片路径即可目视检查；本工具不做 OCR）');
    const blocks = [{ type: 'text', text: lines.join('\n') }];
    for (const entry of value.rendered) {
        if (entry.inline === undefined)
            continue;
        // The reference belongs to the attachment service and is passed back unchanged; this plugin
        // never interprets it, so the plain-JSON mirror in the result is re-branded at this boundary.
        blocks.push({
            type: 'image',
            attachment: {
                attachmentId: entry.inline.attachment_id,
                mediaType: entry.inline.media_type,
                bytes: entry.inline.bytes,
                width: entry.inline.width,
                height: entry.inline.height,
                ...(entry.inline.name === undefined ? {} : { name: entry.inline.name }),
            },
        });
    }
    return blocks;
}
function isLocalPath(source) {
    return !/^(?:https?|file):/i.test(source);
}
/**
 * Project the information dictionary into the tool's field vocabulary.
 *
 * Dates are normalised to ISO 8601: the raw PDF form (`D:20260101120000+08'00'`) is neither ISO nor
 * validated, and a value that cannot be parsed is passed through unchanged so the caller sees what
 * the file actually says (the inspect result also warns about it).
 */
function toMetadata(info) {
    const pick = (key, raw) => {
        if (typeof raw !== 'string' || raw === '')
            return undefined;
        return key === 'CreationDate' || key === 'ModDate' ? isoDateOrRaw(raw) : raw;
    };
    const mapping = {
        title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords',
        created: 'CreationDate', modified: 'ModDate', producer: 'Producer', creator: 'Creator',
    };
    const out = {};
    for (const [field, key] of Object.entries(mapping)) {
        const value = pick(key, info[key]);
        if (value !== undefined)
            out[field] = value;
    }
    return out;
}
function basename(source) {
    const trimmed = source.trim();
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    return trimmed.split(/[\\/]/u).at(-1) ?? trimmed;
}
function renderInspect(value) {
    const lines = [];
    const meta = value.metadata;
    const metaBits = [
        meta.title !== undefined ? `标题：${meta.title}` : undefined,
        meta.author !== undefined ? `作者：${meta.author}` : undefined,
        meta.subject !== undefined ? `主题：${meta.subject}` : undefined,
        meta.created !== undefined ? `创建：${meta.created}` : undefined,
        meta.producer !== undefined ? `生成器：${meta.producer}` : undefined,
    ].filter((b) => b !== undefined);
    lines.push(`PDF 概览：${value.source}`);
    lines.push(`页数：${value.page_count}${value.encrypted ? '（已加密 /Encrypt，需用 password 提供口令）' : ''}`);
    if (metaBits.length > 0)
        lines.push(`元数据：${metaBits.join('；')}`);
    if (meta.xmp_present) {
        const xmpBits = Object.entries(meta.xmp).map(([key, entry]) => `${key}=${entry}`);
        lines.push(`XMP：${xmpBits.length === 0 ? '存在但无可识别字段' : xmpBits.join('；')}`);
        if (meta.title !== undefined && meta.xmp.title !== undefined && meta.xmp.title !== meta.title) {
            lines.push(`注意：信息字典与 XMP 的标题不一致（字典「${meta.title}」/ XMP「${meta.xmp.title}」）——查看器可能任选其一。`);
        }
    }
    const formBits = [
        value.form_field_count === null ? undefined : `表单字段 ${value.form_field_count} 个`,
        value.xfa ? '纯 XFA 表单（不能按字段名逐个填写）' : undefined,
        value.js_actions ? '含文档级 JavaScript' : undefined,
    ].filter((bit) => bit !== undefined);
    if (formBits.length > 0)
        lines.push(`结构信号：${formBits.join('；')}`);
    for (const warning of value.warnings)
        lines.push(`注意：${warning}`);
    if (value.outline.length > 0) {
        lines.push('目录：');
        for (const item of value.outline)
            lines.push(`${'  '.repeat(item.level - 1)}- ${item.title}`);
    }
    lines.push(`每页内容（已检查 ${value.inspected_pages} 页）：`);
    for (const entry of value.pages) {
        if (entry.chars < 0) {
            lines.push(`第 ${entry.page} 页（未检查：超出单次页数上限）`);
            continue;
        }
        const flags = entry.scanned_likely ? `，疑似扫描页（${entry.images} 张图、无文本层）` : '';
        lines.push(`第 ${entry.page} 页（${entry.chars} 字符${flags}）${entry.preview !== undefined ? `：${entry.preview.replace(/\n/gu, ' ')}` : ''}`);
    }
    if (value.pages_truncated) {
        lines.push(`[已截断] 仅检查前 ${value.inspected_pages} 页的内容量。可用 pdf_read 的 range="N-M" 分段读取其余页面。`);
    }
    if (value.scanned_pages > 0) {
        lines.push(`（${value.scanned_pages} 页疑似扫描页：渲染这些页并用视觉检查比反复提取文本有用——用 pdf_render 的 range 指定页码，再用 read_image 打开产出的图片；本插件不做 OCR。）`);
    }
    else if (value.inspected_pages > 0 && value.pages.every((p) => p.chars <= 0 && p.images === 0)) {
        lines.push('（全部页面均无文本层也没有图：该文档可能是空文档或纯矢量图，反复重试提取不会有新结果。）');
    }
    return lines.join('\n');
}
function renderRead(value) {
    const lines = [];
    lines.push(`PDF 文本（${value.source}）`);
    lines.push(`范围：${value.mode === 'full' ? '全文' : `第 ${value.requested} 页`}；共 ${value.page_count} 页；本次返回 ${value.total_chars} 字符`);
    if (value.pages.length === 0)
        lines.push('（未提取到文本：该文档可能为扫描件，无文本层——用 pdf_render 渲染成图片再看，本插件不做 OCR）');
    for (const page of value.pages) {
        if (page.text.length === 0)
            continue;
        lines.push(`\n—— 第 ${page.page} 页（${page.chars} 字符）——`);
        lines.push(page.text);
    }
    if (value.truncated) {
        const perPage = value.chars_per_page.map((e) => `第${e.page}页 ${e.chars}字符`).join('、');
        lines.push(`\n[已截断] 内容超过本次上限，完整各页字数：${perPage}。可用 range="开始页-结束页" 分段继续读取。`);
    }
    return lines.join('\n');
}
function renderFind(value) {
    const lines = [];
    lines.push(`关键词搜索：${value.query}`);
    lines.push(`文档：${value.source}（共 ${value.page_count} 页，搜索了 ${value.searched_pages} 页）`);
    if (value.total_matches === 0) {
        lines.push(value.searched_pages === 0 ? '未搜索任何页（可能命中了首页前的全局上限）。' : '未找到匹配。');
        return lines.join('\n');
    }
    lines.push(`命中 ${value.total_matches} 处${value.truncated ? '（已达上限或每页仅显示部分片段）' : ''}：`);
    for (const match of value.matches) {
        const shown = match.count === match.reported ? `${match.count} 处` : `${match.count} 处，其中 ${match.reported} 处计入本次上限`;
        lines.push(`第 ${match.page} 页（${shown}）`);
        for (const snippet of match.snippets)
            lines.push(`  ${snippet}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=index.js.map