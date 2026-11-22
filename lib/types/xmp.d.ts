/**
 * XMP 包与 PDF 日期的解析：两侧共用的词汇表。
 *
 * 信息字典和 XMP 包是同一批事实的两个来源，阅读器两边都报（查看器可能任一优先），并且都不改写。
 * 日期按 ISO 8601 输出——原来只剥 `D:` 前缀与结尾 `Z`，`D:20260101120000+08'00'` 会被原样透出，
 * 既不是 ISO 8601 也没做校验。
 * @module dsh-pdf-reader/src/xmp
 */
/** XMP elements reported to the model, keyed by the field name used in tool output. */
export declare const XMP_ELEMENTS: ReadonlyArray<{
    key: string;
    element: string;
}>;
/**
 * Extract an XMP element's text, unwrapping the `rdf:Alt`/`rdf:Seq` list form producers use.
 * @param xmp - decoded XMP packet text.
 * @param element - qualified element name, e.g. `dc:title`.
 * @returns the text value, or undefined when the element is absent.
 */
export declare function extractElement(xmp: string, element: string): string | undefined;
/** Read every tracked XMP element from a packet. */
export declare function parseXmp(xmp: string | null): Record<string, string>;
/**
 * Parse a PDF date (`D:YYYYMMDDHHmmSS±HH'mm'`, `D:…Z`, or a truncated form) or an ISO 8601 string.
 *
 * The PDF form omits trailing components (`D:2026` is legal), carries a literal apostrophe in its
 * timezone, and `new Date('D:…')` is `Invalid Date` — hence an explicit parser instead of handing
 * the raw value to `Date.parse`.
 *
 * @param value - the raw date string from the document.
 * @returns the parsed date, or null when the value is neither form.
 */
export declare function parsePdfDate(value: string): Date | null;
/**
 * Normalise a metadata date for the tool result.
 * @param value - raw date string.
 * @returns the ISO 8601 form, or the raw value when it does not parse.
 */
export declare function isoDateOrRaw(value: string): string;
