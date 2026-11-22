/**
 * XMP 包与 PDF 日期的解析：两侧共用的词汇表。
 *
 * 信息字典和 XMP 包是同一批事实的两个来源，阅读器两边都报（查看器可能任一优先），并且都不改写。
 * 日期按 ISO 8601 输出——原来只剥 `D:` 前缀与结尾 `Z`，`D:20260101120000+08'00'` 会被原样透出，
 * 既不是 ISO 8601 也没做校验。
 * @module dsh-pdf-reader/src/xmp
 */
/** XMP elements reported to the model, keyed by the field name used in tool output. */
export const XMP_ELEMENTS = [
    { key: 'title', element: 'dc:title' },
    { key: 'creator', element: 'dc:creator' },
    { key: 'description', element: 'dc:description' },
    { key: 'keywords', element: 'pdf:Keywords' },
    { key: 'producer', element: 'pdf:Producer' },
    { key: 'created', element: 'xmp:CreateDate' },
    { key: 'modified', element: 'xmp:ModifyDate' },
    { key: 'metadata_date', element: 'xmp:MetadataDate' },
];
/**
 * Extract an XMP element's text, unwrapping the `rdf:Alt`/`rdf:Seq` list form producers use.
 * @param xmp - decoded XMP packet text.
 * @param element - qualified element name, e.g. `dc:title`.
 * @returns the text value, or undefined when the element is absent.
 */
export function extractElement(xmp, element) {
    const name = element.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const outer = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'u').exec(xmp);
    if (outer === null)
        return undefined;
    const inner = outer[1];
    const listItem = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/u.exec(inner);
    const raw = listItem === null ? inner : listItem[1];
    const text = raw.replace(/<[^>]*>/gu, '').trim();
    return text === '' ? undefined : unescapeXml(text);
}
/** Read every tracked XMP element from a packet. */
export function parseXmp(xmp) {
    if (xmp === null)
        return {};
    const out = {};
    for (const { key, element } of XMP_ELEMENTS) {
        const value = extractElement(xmp, element);
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
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
export function parsePdfDate(value) {
    const trimmed = value.trim();
    if (trimmed === '')
        return null;
    const pdf = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?(\d{2})?'?)?$/u.exec(trimmed);
    if (pdf !== null) {
        const [, year, month, day, hour, minute, second, zulu, sign, offHour, offMinute] = pdf;
        const parts = [year, month ?? '01', day ?? '01', hour ?? '00', minute ?? '00', second ?? '00'].map((part) => Number(part));
        if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 60)
            return null;
        const base = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
        if (zulu !== undefined || sign === undefined)
            return new Date(base);
        const delta = (sign === '-' ? -1 : 1) * (Number(offHour ?? '0') * 60 + Number(offMinute ?? '0'));
        return new Date(base - delta * 60_000);
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
/**
 * Normalise a metadata date for the tool result.
 * @param value - raw date string.
 * @returns the ISO 8601 form, or the raw value when it does not parse.
 */
export function isoDateOrRaw(value) {
    const parsed = parsePdfDate(value);
    return parsed === null ? value : parsed.toISOString();
}
function unescapeXml(value) {
    return value
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&amp;/gu, '&');
}
//# sourceMappingURL=xmp.js.map