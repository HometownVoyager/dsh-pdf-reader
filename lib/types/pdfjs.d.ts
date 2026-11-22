/**
 * pdfjs-dist wrapper: bytes → document proxy, per-page text rebuilding with layout,
 * metadata and outline extraction, and user-facing error mapping.
 * @module dsh-pdf-reader/src/pdfjs
 */
/**
 * The resolved standard font directory.
 *
 * Text extraction barely touches it, but rendering does: a page whose fonts are not embedded is
 * drawn from this data, so it becomes a load-bearing path the moment `pdf_render` exists. Exported
 * for the test that pins the resolution and the trailing-slash fix.
 */
export declare function standardFontDataUrl(): string;
/** One extracted page: page number, rebuilt line text, layout signals, and total characters. */
export interface PageText {
    /** 1-based page number. */
    page: number;
    /** Rebuilt text for the page. */
    text: string;
    /** Number of characters in {@link text}. */
    chars: number;
    /** Painted image operators on the page, or -1 when the caller did not ask for the count. */
    images: number;
    /** Whether the producer marked a line break at the end of the last item. */
    endsWithLineBreak: boolean;
}
/** One rendered page: encoded image bytes plus their pixel size. */
export interface RenderedPage {
    /** 1-based page number. */
    page: number;
    /** Pixel width of the rendered image. */
    width: number;
    /** Pixel height of the rendered image. */
    height: number;
    /** Encoded image bytes (PNG or JPEG). */
    bytes: Uint8Array;
    /** Encoding of {@link bytes}. */
    format: 'png' | 'jpeg';
    /** Effective scale applied to the page's PDF points. */
    scale: number;
}
/** Rendering options resolved by the tool layer. */
export interface RenderOptions {
    /** Scale factor applied to PDF points (1 = 72 dpi). */
    scale: number;
    /** Output encoding. */
    format: 'png' | 'jpeg';
    /** JPEG quality 0–100 (ignored for PNG). */
    quality: number;
}
/** Outline item flattened to level + title. */
export interface OutlineItem {
    /** 1-based depth in the bookmark tree. */
    level: number;
    /** Bookmark label. */
    title: string;
}
/** A loaded PDF document plus the task that owns its worker resources. */
export interface LoadedPdf {
    /** Page count. */
    pageCount: number;
    /** True when the file carries an `/Encrypt` dictionary (regardless of whether it opened). */
    encrypted: boolean;
    /** True when pdf.js refuses the document without a password. */
    passwordRequired: boolean;
    /** Metadata info object (title/author/dates/…), absent keys omitted. */
    info: Record<string, unknown>;
    /** Raw XMP packet text, or null when the document has no `/Metadata` stream. */
    xmpRaw: string | null;
    /** Number of AcroForm fields, or null when the information dictionary reports no form. */
    formFieldCount: number | null;
    /** Whether the document's form is XFA (pure XFA cannot be filled field-by-field). */
    isPureXfa: boolean;
    /** Whether the document carries document-level JavaScript actions. */
    hasJSActions: boolean;
    /** Flattened outline tree, or null when the document has no bookmarks. */
    outline: OutlineItem[] | null;
    /** Extract text of one page (1-based). */
    extractPage(pageNumber: number, options?: {
        withImages?: boolean;
    }): Promise<PageText>;
    /** Page size in PDF points at scale 1, with the page's rotation applied. */
    pageSize(pageNumber: number): Promise<{
        width: number;
        height: number;
    }>;
    /** Render one page (1-based) to an encoded image. */
    renderPage(pageNumber: number, options: RenderOptions): Promise<RenderedPage>;
    /** Release worker resources. */
    dispose(): Promise<void>;
}
/**
 * Thrown when the document needs a password. Carries the same user-facing text as
 * {@link describePdfError}, plus the flag the tool layer needs to be honest in its `encrypted`
 * field instead of guessing.
 */
export declare class PdfPasswordError extends Error {
    /** Always `true`; named so the tool layer never has to match on the message. */
    readonly passwordRequired = true;
    constructor();
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
export declare function detectEncryption(bytes: Uint8Array): boolean;
/**
 * Map a pdf.js exception to a user-facing Chinese message.
 * @param error - the exception thrown by pdf.js.
 * @returns a human-readable message describing the failure.
 */
export declare function describePdfError(error: unknown): string;
/**
 * Open a PDF from bytes.
 * @param bytes - raw PDF data.
 * @param password - optional document open password.
 * @returns the loaded document handle.
 * @throws an Error with a user-facing message when the data is not a readable PDF.
 */
export declare function openPdf(bytes: Uint8Array, password?: string): Promise<LoadedPdf>;
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
export declare function rebuildPageText(items: readonly unknown[]): string;
