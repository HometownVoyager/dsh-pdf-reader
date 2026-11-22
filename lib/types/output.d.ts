/**
 * Output handling for the render tool: directory resolution against the session working directory,
 * Windows-safe derived file names, and size-capped writes.
 *
 * The reader is otherwise read-only; this module is only used by `pdf_render`, which produces image
 * files because a rendered page has to land somewhere the model can hand to `read_image`.
 * @module dsh-pdf-reader/src/output
 */
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
/** Resolve a model-supplied directory path (absolute, file:// or cwd-relative) and create it. */
export declare function resolveOutputDir(exec: ToolExecution, path: string, label: string): Promise<string>;
/** File name stem of an absolute path (no directory, no extension). */
export declare function stemOf(absolute: string): string;
/** Replace the characters Windows forbids in a file name. */
export declare function sanitizeFileName(name: string): string;
/** Derive `<dir>/<stem>-pages/` next to a local source. */
export declare function deriveRenderDir(sourceAbsolute: string): string;
/**
 * Write one rendered image, refusing to overwrite unless allowed.
 * @param absolute - target file path.
 * @param bytes - encoded image bytes.
 * @param overwrite - whether an existing file may be replaced.
 * @param maxBytes - cap for a single image.
 * @returns the written path.
 * @throws an Error when the target exists without `overwrite` or exceeds the cap.
 */
export declare function writeImage(absolute: string, bytes: Uint8Array, overwrite: boolean, maxBytes: number): Promise<string>;
