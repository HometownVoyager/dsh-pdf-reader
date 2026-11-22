/**
 * Output handling for the render tool: directory resolution against the session working directory,
 * Windows-safe derived file names, and size-capped writes.
 *
 * The reader is otherwise read-only; this module is only used by `pdf_render`, which produces image
 * files because a rendered page has to land somewhere the model can hand to `read_image`.
 * @module dsh-pdf-reader/src/output
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Resolve a model-supplied directory path (absolute, file:// or cwd-relative) and create it. */
export async function resolveOutputDir(exec: ToolExecution, path: string, label: string): Promise<string> {
  const trimmed = path.trim()
  if (trimmed === '') throw new Error(`${label} 参数不能为空`)
  if (/^https?:\/\//iu.test(trimmed)) throw new Error(`${label} 必须是本地路径，不支持 http(s) 链接`)
  const unwrapped = /^file:\/\//iu.test(trimmed) ? fileURLToPath(trimmed) : trimmed
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  const absolute = resolve(cwd, unwrapped)
  await mkdir(absolute, { recursive: true })
  return absolute
}

/** File name stem of an absolute path (no directory, no extension). */
export function stemOf(absolute: string): string {
  const name = basename(absolute)
  const ext = extname(name)
  return ext === '' ? name : name.slice(0, -ext.length)
}

/** Replace the characters Windows forbids in a file name. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/[. ]+$/gu, '').trim()
  return cleaned === '' ? 'document' : cleaned.slice(0, 80)
}

/** Derive `<dir>/<stem>-pages/` next to a local source. */
export function deriveRenderDir(sourceAbsolute: string): string {
  return join(dirname(sourceAbsolute), `${sanitizeFileName(stemOf(sourceAbsolute))}-pages`)
}

/**
 * Write one rendered image, refusing to overwrite unless allowed.
 * @param absolute - target file path.
 * @param bytes - encoded image bytes.
 * @param overwrite - whether an existing file may be replaced.
 * @param maxBytes - cap for a single image.
 * @returns the written path.
 * @throws an Error when the target exists without `overwrite` or exceeds the cap.
 */
export async function writeImage(absolute: string, bytes: Uint8Array, overwrite: boolean, maxBytes: number): Promise<string> {
  if (bytes.byteLength > maxBytes) {
    throw new Error(`单张渲染图过大（${Math.round(bytes.byteLength / 1024 / 1024)}MB），超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB：请降低 dpi 或改用 jpeg`)
  }
  if (!overwrite) {
    try {
      await stat(absolute)
      throw new Error(`目标文件已存在：${absolute}（如需覆盖请设 overwrite=true，或换一个输出目录）`)
    } catch (error) {
      // Re-throw the explicit conflict; a stat failure means the target does not exist yet.
      if (error instanceof Error && error.message.startsWith('目标文件已存在')) throw error
    }
  }
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
  return absolute
}
