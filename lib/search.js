/**
 * Keyword search over rebuilt page text: NFKC + case folding normalization, and
 * whitespace-insensitive matching so that split tokens inside one text line
 * (common in PDF text layers) still match. Hits report the original text window
 * for readable snippets.
 * @module dsh-pdf-reader/src/search
 */
/**
 * Normalize both sides for matching: NFKC (full/half-width unification) and
 * case folding, with all whitespace removed so token splits in the PDF text
 * layer never break a phrase search.
 * @param input - raw text or query.
 * @returns the normalized comparison string.
 */
export function normalizeForMatch(input) {
    return input.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}
/**
 * Search one page's text for a normalized query with whitespace-insensitive
 * matching, returning original-text snippets.
 * @param pageText - the rebuilt page text.
 * @param queryNorm - query already normalized by {@link normalizeForMatch}.
 * @param contextChars - characters of context to keep on each side.
 * @param maxSnippets - maximum snippets returned per page.
 * @returns match count and original-text snippets.
 */
export function searchPage(pageText, queryNorm, contextChars, maxSnippets) {
    if (queryNorm === '' || pageText === '')
        return { page: 0, count: 0, snippets: [] };
    // Map every original character to its normalized form; strip whitespace into a
    // parallel index so match offsets translate back to original positions.
    const normChars = [];
    const originIndices = [];
    for (let i = 0; i < pageText.length; i++) {
        const ch = pageText[i];
        if (/\s/u.test(ch))
            continue;
        normChars.push(ch.normalize('NFKC').toLowerCase());
        originIndices.push(i);
    }
    const stripped = normChars.join('');
    let count = 0;
    const snippets = [];
    let from = 0;
    while (from + queryNorm.length <= stripped.length) {
        const at = stripped.indexOf(queryNorm, from);
        if (at === -1)
            break;
        count++;
        const start = originIndices[at];
        const endOrigin = at + queryNorm.length - 1 < originIndices.length
            ? originIndices[at + queryNorm.length - 1]
            : pageText.length;
        const windowStart = Math.max(0, start - contextChars);
        const windowEnd = Math.min(pageText.length, endOrigin + contextChars);
        let snippet = pageText.slice(windowStart, windowEnd).replace(/\s+/gu, ' ');
        if (windowStart > 0)
            snippet = `…${snippet}`;
        if (windowEnd < pageText.length)
            snippet = `${snippet}…`;
        if (snippets.length < maxSnippets)
            snippets.push(snippet);
        from = at + queryNorm.length;
    }
    return { page: 0, count, snippets };
}
/** Convenience wrapper carrying the page number. */
export function searchPageFor(page, pageText, queryNorm, contextChars, maxSnippets) {
    return { ...searchPage(pageText, queryNorm, contextChars, maxSnippets), page };
}
//# sourceMappingURL=search.js.map