// Smoke: verify pdfjs-dist legacy build works in plain Node 24 (no worker config).
// Usage: node tests/smoke.mjs <pdf-path> [maxPages]
import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const path = process.argv[2]
const maxPages = Number(process.argv[3] ?? 2)
const data = new Uint8Array(await readFile(path))
// pdfjs-dist 6 起 PDFDocumentProxy.destroy() 已移除，销毁走 loadingTask.destroy()
const loadingTask = getDocument({ data })
const doc = await loadingTask.promise
console.log('pages:', doc.numPages)
const meta = await doc.getMetadata()
console.log('info title:', meta.info?.Title)
console.log('info author:', meta.info?.Author)
const outline = await doc.getOutline()
console.log('outline:', JSON.stringify(outline?.slice(0, 5).map((o) => o.title) ?? null))
for (let p = 1; p <= Math.min(maxPages, doc.numPages); p++) {
  const page = await doc.getPage(p)
  const tc = await page.getTextContent()
  const text = tc.items.map((i) => i.str).join('')
  console.log(`page ${p}: items=${tc.items.length} chars=${text.length}`)
  console.log('  head:', JSON.stringify(text.slice(0, 120)))
}
await loadingTask.destroy()
