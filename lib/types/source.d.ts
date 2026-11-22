/**
 * Source resolution for PDF tools: local files (absolute, or relative to the session
 * working directory) and remote http(s) URLs (fetched into memory, never written to disk).
 * @module dsh-pdf-reader/src/source
 */
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
/** Deployment caps shared by all PDF tools (resolved plugin config). */
export interface SourceCaps {
    /** Maximum local file size in bytes. */
    maxFileBytes: number;
    /** Maximum downloaded body size in bytes. */
    maxDownloadBytes: number;
    /** Download timeout in milliseconds. */
    downloadTimeoutMs: number;
    /** Regex sources allowed as URL hosts; empty means any host. */
    allowedHosts: readonly string[];
}
/** A PDF resolved to its bytes, whatever the original input form. */
export interface ResolvedSource {
    /** Raw PDF bytes. */
    bytes: Uint8Array;
    /** Stable user-facing name (file path or URL). */
    displayName: string;
    /** Absolute local path, or null for a downloaded source. */
    localPath: string | null;
}
/**
 * Resolve a model-supplied source string to PDF bytes.
 * @param source - a local path (or file:// URL), or an http(s) URL.
 * @param exec - the tool execution supplying the session cwd and cancellation.
 * @param caps - resolved deployment caps.
 * @returns PDF bytes plus a display name.
 * @throws an Error with a user-facing Chinese message on any failure.
 */
export declare function resolveSource(source: string, exec: ToolExecution, caps: SourceCaps): Promise<ResolvedSource>;
