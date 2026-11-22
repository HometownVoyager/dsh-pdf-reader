/**
 * Source resolution for PDF tools: local files (absolute, or relative to the session
 * working directory) and remote http(s) URLs (fetched into memory, never written to disk).
 * @module dsh-pdf-reader/src/source
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
/**
 * Resolve a model-supplied source string to PDF bytes.
 * @param source - a local path (or file:// URL), or an http(s) URL.
 * @param exec - the tool execution supplying the session cwd and cancellation.
 * @param caps - resolved deployment caps.
 * @returns PDF bytes plus a display name.
 * @throws an Error with a user-facing Chinese message on any failure.
 */
export async function resolveSource(source, exec, caps) {
    const trimmed = source.trim();
    if (trimmed === '')
        throw new Error('source 参数不能为空');
    if (/^https?:\/\//i.test(trimmed))
        return downloadUrl(trimmed, exec, caps);
    if (/^file:\/\//i.test(trimmed))
        return readLocal(fileURLToPath(trimmed), exec, caps);
    const cwd = exec.agent?.session.header.cwd ?? process.cwd();
    return readLocal(resolve(cwd, trimmed), exec, caps);
}
async function readLocal(absolute, exec, caps) {
    exec.signal.throwIfAborted();
    let size;
    try {
        size = (await stat(absolute)).size;
    }
    catch {
        throw new Error(`找不到文件：${absolute}（请确认路径正确，或改用 http(s) 链接）`);
    }
    if (size > caps.maxFileBytes) {
        throw new Error(`文件过大（${Math.round(size / 1024 / 1024)}MB），超过上限 ${Math.round(caps.maxFileBytes / 1024 / 1024)}MB`);
    }
    exec.signal.throwIfAborted();
    const bytes = new Uint8Array(await readFile(absolute, { signal: exec.signal }));
    return { bytes, displayName: absolute, localPath: absolute };
}
async function downloadUrl(url, exec, caps) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`不支持的链接协议：${parsed.protocol}（仅支持 http/https）`);
    }
    if (caps.allowedHosts.length > 0 && !caps.allowedHosts.some((pattern) => new RegExp(pattern, 'i').test(parsed.hostname))) {
        throw new Error(`链接主机 ${parsed.hostname} 不在允许列表内`);
    }
    const timeout = AbortSignal.timeout(caps.downloadTimeoutMs);
    const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout]);
    let response;
    try {
        response = await fetch(url, { signal, redirect: 'follow' });
    }
    catch (error) {
        if (signal.aborted && timeout.aborted)
            throw new Error(`下载超时（${caps.downloadTimeoutMs}ms）：${url}`);
        if (exec.signal?.aborted ?? false)
            throw error;
        throw new Error(`下载失败：${url}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (!response.ok)
        throw new Error(`下载失败：${url}（HTTP ${response.status}）`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > caps.maxDownloadBytes) {
        throw new Error(`下载内容过大（${Math.round(declared / 1024 / 1024)}MB），超过上限 ${Math.round(caps.maxDownloadBytes / 1024 / 1024)}MB`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > caps.maxDownloadBytes) {
        throw new Error(`下载内容过大（${Math.round(buffer.byteLength / 1024 / 1024)}MB），超过上限 ${Math.round(caps.maxDownloadBytes / 1024 / 1024)}MB`);
    }
    return { bytes: buffer, displayName: url, localPath: null };
}
//# sourceMappingURL=source.js.map