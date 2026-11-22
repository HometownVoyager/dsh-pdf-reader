/**
 * pdfjs-dist wrapper: bytes → document proxy, per-page text rebuilding with layout,
 * metadata and outline extraction, and user-facing error mapping.
 * @module dsh-pdf-reader/src/pdfjs
 */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
/** Standard non-embedded font data lives inside the pdfjs-dist package (trailing slash required). */
const STANDARD_FONT_DATA_URL = (() => {
    const resolved = import.meta.resolve('pdfjs-dist/standard_fonts');
    return resolved.endsWith('/') ? resolved : `${resolved}/`;
})();
/**
 * The resolved standard font directory.
 *
 * Text extraction barely touches it, but rendering does: a page whose fonts are not embedded is
 * drawn from this data, so it becomes a load-bearing path the moment `pdf_render` exists. Exported
 * for the test that pins the resolution and the trailing-slash fix.
 */
export function standardFontDataUrl() {
    return STANDARD_FONT_DATA_URL;
}
/**
 * Thrown when the document needs a password. Carries the same user-facing text as
 * {@link describePdfError}, plus the flag the tool layer needs to be honest in its `encrypted`
 * field instead of guessing.
 */
export class PdfPasswordError extends Error {
    /** Always `true`; named so the tool layer never has to match on the message. */
    passwordRequired = true;
    constructor() {
        super('该 PDF 已加密，需要密码才能打开');
        this.name = 'PdfPasswordError';
    }
}
/**
 * Detect the `/Encrypt` dictionary by scanning the raw trailer.
 *
 * This deliberately does not trust a pdf.js document property: `isEncrypted` exists inside the
 * worker's local scope and is not part of the main-thread `GetDoc` payload, so reading it off the
 * document proxy always yielded `false` (report D1). The trailer scan is the same evidence the
 * worker itself starts from.
 *
 * @param bytes - raw PDF bytes.
 * @returns whether an `/Encrypt` dictionary is present.
 */
export function detectEncryption(bytes) {
    const limit = Math.min(bytes.byteLength, 4 * 1024 * 1024);
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, limit));
    return /\/Encrypt\b/u.test(text);
}
/**
 * Map a pdf.js exception to a user-facing Chinese message.
 * @param error - the exception thrown by pdf.js.
 * @returns a human-readable message describing the failure.
 */
export function describePdfError(error) {
    if (error instanceof PdfPasswordError)
        return error.message;
    if (error instanceof Error) {
        switch (error.name) {
            case 'InvalidPDFException':
            case 'FormatError':
                return '该文件不是有效或受支持的 PDF（结构损坏或格式异常）';
            case 'PasswordException':
                return '该 PDF 已加密，需要密码才能打开：请用 password 参数提供文档打开口令（部分文件使用空口令即可打开，若提示错误请向文件提供方索取口令）';
            case 'MissingPDFException':
                return 'PDF 文件不存在';
        }
    }
    return `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`;
}
/**
 * Open a PDF from bytes.
 * @param bytes - raw PDF data.
 * @param password - optional document open password.
 * @returns the loaded document handle.
 * @throws an Error with a user-facing message when the data is not a readable PDF.
 */
export async function openPdf(bytes, password) {
    const encrypted = detectEncryption(bytes);
    let task;
    let doc;
    try {
        task = getDocument({
            data: bytes,
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
            useSystemFonts: true,
            ...(password !== undefined && password !== '' ? { password } : {}),
        });
        doc = await task.promise;
    }
    catch (error) {
        // Release the worker on the failure path too: the old code only reached `task.destroy()`
        // through `dispose()`, which a rejected open never returned, so every damaged or locked file
        // leaked a worker (report D5).
        await task?.destroy().catch(() => { });
        if (error instanceof Error && error.name === 'PasswordException')
            throw new PdfPasswordError();
        throw new Error(describePdfError(error));
    }
    const pageCount = doc.numPages;
    let info = {};
    let xmpRaw = null;
    let outline = null;
    try {
        const meta = await doc.getMetadata();
        info = (meta.info ?? {});
        // XMP is the richer source when the info dictionary is empty, and it is kept verbatim either
        // way: pdfjs decodes the (possibly Flate-compressed) packet, so `getRaw()` is the packet text.
        const metadata = meta.metadata;
        const raw = typeof metadata?.getRaw === 'function' ? metadata.getRaw() : null;
        if (typeof raw === 'string' && raw.trim() !== '')
            xmpRaw = raw;
    }
    catch {
        info = {};
    }
    const formFieldCount = await countFormFields(doc);
    let isPureXfa = false;
    try {
        isPureXfa = doc.isPureXfa === true;
    }
    catch {
        // A document whose AcroForm cannot be read reports "not pure XFA" rather than failing the open.
        isPureXfa = false;
    }
    let hasJSActions = false;
    try {
        const probe = doc.hasJSActions;
        hasJSActions = typeof probe === 'function' ? (await probe.call(doc)) === true : false;
    }
    catch {
        hasJSActions = false;
    }
    try {
        const raw = await doc.getOutline();
        if (raw !== null && raw.length > 0)
            outline = flattenOutline(raw, 1);
    }
    catch {
        outline = null;
    }
    return {
        pageCount,
        encrypted,
        passwordRequired: false,
        info,
        xmpRaw,
        formFieldCount,
        isPureXfa,
        hasJSActions,
        outline,
        async extractPage(pageNumber, options) {
            const raw = await doc.getPage(pageNumber);
            const content = await raw.getTextContent();
            const text = rebuildPageText(content.items);
            // Image operators are only counted when asked: the operator list is the expensive part, and
            // the scanned-page triage only needs it for pages that produced almost no text.
            let images = -1;
            if (options?.withImages === true) {
                try {
                    const operators = await raw.getOperatorList();
                    images = operators.fnArray.filter((fn) => IMAGE_OPS.has(fn)).length;
                }
                catch {
                    images = 0;
                }
            }
            // Page proxies hold a reference to the page's operator list; releasing them keeps a long
            // sequential read from growing memory linearly in the page count.
            raw.cleanup();
            const last = content.items.at(-1);
            return { page: pageNumber, chars: text.length, text, images, endsWithLineBreak: last?.hasEOL === true };
        },
        async pageSize(pageNumber) {
            const raw = await doc.getPage(pageNumber);
            const viewport = raw.getViewport({ scale: 1 });
            raw.cleanup();
            return { width: viewport.width, height: viewport.height };
        },
        async renderPage(pageNumber, options) {
            const raw = await doc.getPage(pageNumber);
            const viewport = raw.getViewport({ scale: options.scale });
            const width = Math.max(1, Math.ceil(viewport.width));
            const height = Math.max(1, Math.ceil(viewport.height));
            const canvas = await createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.fillStyle = 'white';
            context.fillRect(0, 0, width, height);
            try {
                // pdfjs v6 takes the canvas explicitly; `canvas: null` is its documented way to render into
                // a caller-supplied context (the DOM type does not describe a Node canvas).
                const params = { canvas: null, canvasContext: context, viewport };
                await raw.render(params).promise;
            }
            finally {
                raw.cleanup();
            }
            const bytes = options.format === 'png'
                ? canvas.toBuffer('image/png')
                : canvas.toBuffer('image/jpeg', Math.round(options.quality));
            return { page: pageNumber, width, height, bytes: new Uint8Array(bytes), format: options.format, scale: options.scale };
        },
        async dispose() {
            await task?.destroy().catch(() => { });
        },
    };
}
/** pdf.js operator codes that paint an image (used by the scanned-page triage). */
const IMAGE_OPS = new Set([
    OPS.paintImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
].filter((code) => typeof code === 'number'));
/** Count AcroForm fields through pdf.js, returning null when the document has no form. */
async function countFormFields(doc) {
    if (typeof doc.getFieldObjects !== 'function')
        return null;
    try {
        const fields = await doc.getFieldObjects();
        return fields === null ? null : Object.keys(fields).length;
    }
    catch {
        // A malformed AcroForm must not fail the whole open; the count is reported as unknown.
        return null;
    }
}
/**
 * Load the canvas backend on demand.
 *
 * `@napi-rs/canvas` is an optional dependency of pdfjs-dist: it is present in this deployment, but a
 * stripped install would not have it, and text extraction must keep working there. The failure is
 * therefore reported as an actionable error rather than crashing at import time.
 */
async function createCanvas(width, height) {
    let backend;
    try {
        backend = await import('@napi-rs/canvas');
    }
    catch (error) {
        throw new Error(`渲染需要 @napi-rs/canvas（pdfjs-dist 的可选依赖），当前环境无法加载：${error instanceof Error ? error.message : String(error)}。可用 pdf_read 提取文本，或安装 @napi-rs/canvas 后重试。`);
    }
    return backend.createCanvas(width, height);
}
/** Flatten the pdf.js outline tree into level-tagged items. */
function flattenOutline(items, level) {
    const result = [];
    for (const item of items) {
        if (typeof item?.title === 'string')
            result.push({ level, title: item.title });
        if (Array.isArray(item?.items) && item.items.length > 0)
            result.push(...flattenOutline(item.items, level + 1));
    }
    return result;
}
/**
 * Rebuild readable text from pdf.js text items using their geometry:
 * items sharing a baseline (within a tolerance) form a line in x order. Word separation uses
 * pdf.js's own `width` when available and only falls back to the transform matrix; a fabricated
 * width (matrix scale × character count, i.e. assuming a monospace font) inserted or dropped
 * spaces in every proportional face (report D3). Items the producer marked `hasEOL` end their line.
 *
 * @param items - the raw pdf.js text content items.
 * @returns the rebuilt page text.
 */
export function rebuildPageText(items) {
    if (items.length === 0)
        return '';
    const clusters = [];
    let pendingBreak = false;
    for (const raw of items) {
        const item = raw;
        if (typeof item?.str !== 'string' || item.str === '')
            continue;
        const transform = item.transform;
        if (!Array.isArray(transform) || transform.length < 6)
            continue;
        const y = transform[5];
        const x = transform[4];
        const fontSize = Math.abs(transform[3]) || Math.abs(Number(item.height ?? 0)) || 1;
        // Tolerance stays proportional but is clamped: a 0.2 × font size tolerance on 60pt type is
        // ±12pt, wide enough to merge adjacent lines (report D4).
        const tolerance = Math.min(4, Math.max(1, fontSize * 0.15));
        const declared = Number(item.width);
        const width = Number.isFinite(declared) && declared > 0 ? declared : undefined;
        const segment = { x, str: item.str, width, fontSize };
        const cluster = pendingBreak ? undefined : clusters.find((c) => Math.abs(c.y - y) <= tolerance);
        if (cluster === undefined)
            clusters.push({ y, segments: [segment] });
        else
            cluster.segments.push(segment);
        pendingBreak = item.hasEOL === true;
    }
    clusters.sort((a, b) => b.y - a.y);
    const lines = clusters.map((cluster) => {
        cluster.segments.sort((a, b) => a.x - b.x);
        let line = '';
        for (let i = 0; i < cluster.segments.length; i++) {
            const segment = cluster.segments[i];
            if (line !== '') {
                const prev = cluster.segments[i - 1];
                // Without a real width the gap is unknown, so fall back to the previous segment's own
                // declared width and, failing that, to the font size — never to a per-character guess.
                const prevWidth = prev.width ?? (prev.str.length * prev.fontSize * 0.5);
                const gap = segment.x - (prev.x + prevWidth);
                const separator = /(?:^\s|\s$)/u.test(line) || /^\s/u.test(segment.str)
                    ? ''
                    : gap > prev.fontSize * 0.33 ? ' ' : '';
                line += separator;
            }
            line += segment.str;
        }
        return line;
    });
    return lines.join('\n');
}
//# sourceMappingURL=pdfjs.js.map