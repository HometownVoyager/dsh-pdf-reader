/**
 * Keyword search over rebuilt page text: NFKC + case folding normalization, and
 * whitespace-insensitive matching so that split tokens inside one text line
 * (common in PDF text layers) still match. Hits report the original text window
 * for readable snippets.
 * @module dsh-pdf-reader/src/search
 */
/** One match with its context window from the source text. */
export interface SearchHit {
    /** Character offset of the match in the page text. */
    start: number;
    /** Original-text window around the match. */
    snippet: string;
}
/** Search outcome for one page. */
export interface PageSearch {
    /** 1-based page number. */
    page: number;
    /** Number of matches found on this page. */
    count: number;
    /** Up to the per-page cap of snippets. */
    snippets: string[];
}
/**
 * Normalize both sides for matching: NFKC (full/half-width unification) and
 * case folding, with all whitespace removed so token splits in the PDF text
 * layer never break a phrase search.
 * @param input - raw text or query.
 * @returns the normalized comparison string.
 */
export declare function normalizeForMatch(input: string): string;
/**
 * Search one page's text for a normalized query with whitespace-insensitive
 * matching, returning original-text snippets.
 * @param pageText - the rebuilt page text.
 * @param queryNorm - query already normalized by {@link normalizeForMatch}.
 * @param contextChars - characters of context to keep on each side.
 * @param maxSnippets - maximum snippets returned per page.
 * @returns match count and original-text snippets.
 */
export declare function searchPage(pageText: string, queryNorm: string, contextChars: number, maxSnippets: number): PageSearch;
/** Convenience wrapper carrying the page number. */
export declare function searchPageFor(page: number, pageText: string, queryNorm: string, contextChars: number, maxSnippets: number): PageSearch;
