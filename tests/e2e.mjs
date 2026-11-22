// End-to-end verification of the compiled plugin: register the three tools on a
// minimal ctx, then exercise every function point and error path.
// Usage: node tests/e2e.mjs
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const CWD = dirname(HERE)

const registered = new Map()
const ctx = {
  effect: (fn) => fn(),
  tools: {
    register: (tool) => {
      registered.set(tool.name, tool)
      return () => registered.delete(tool.name)
    },
  },
}
apply(ctx, {
  maxCharsPerCall: 20000,
  maxPagesPerCall: 100,
  maxSearchMatches: 50,
  previewChars: 120,
  contextChars: 60,
  maxFileBytes: 200 * 1024 * 1024,
  maxDownloadBytes: 100 * 1024 * 1024,
  downloadTimeoutMs: 20000,
  allowedHosts: [],
})

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: CWD } } } }

async function call(name, args) {
  const tool = registered.get(name)
  if (tool === undefined) throw new Error(`tool not registered: ${name}`)
  return tool.execute(args, exec)
}

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name} ${detail}`)
  }
}

// ---- fixtures ----
const chinese = 'tests/fixtures/gen-chinese.pdf'
const letter = 'tests/fixtures/2026年元旦、寒假致威海校区全体同学的一封信.pdf'
const lecture = 'tests/fixtures/10.1 Curves Defined by Parametric Equations(由参数方程定义的曲线).pdf'

// ---- T1 inspect: Chinese letter ----
{
  const r = await call('pdf_inspect', { source: letter })
  check('T1 inspect letter meta/pages', r.page_count >= 2 && r.pages.length === r.page_count
    && typeof r.pages[0].preview === 'string' && r.pages[0].preview.length > 0,
    JSON.stringify({ page_count: r.page_count, pages: r.pages.length, meta: r.metadata }))
}

// ---- T2 inspect: generated Chinese PDF ----
{
  const r = await call('pdf_inspect', { source: chinese })
  check('T2 inspect gen-chinese', r.page_count === 3 && r.pages[0].chars > 0 && r.pages[0].preview?.includes('第一章')
    && r.encrypted === false && r.inspected_pages === 3 && r.pages_truncated === false
    && r.scanned_pages === 0 && r.scanned_likely === false,
    JSON.stringify({ page_count: r.page_count, p1: r.pages[0], encrypted: r.encrypted, inspected: r.inspected_pages, scanned: r.scanned_pages }))
}

// ---- T2b inspect honours the page budget (P0：maxPagesPerCall 语义对齐) ----
{
  const r = await call('pdf_inspect', { source: lecture })
  check('T2b inspect 只扫描 maxPagesPerCall 页并标记截断', r.inspected_pages <= 100 && r.pages.length === r.page_count
    && r.pages_truncated === (r.page_count > r.inspected_pages),
    JSON.stringify({ pages: r.page_count, inspected: r.inspected_pages, truncated: r.pages_truncated }))
}

// ---- T3 read full ----
{
  const r = await call('pdf_read', { source: chinese })
  const all = (r.pages ?? []).map((p) => p.text).join('\n')
  check('T3 read full 3 pages', r.page_count === 3 && r.pages.length === 3 && r.truncated === false
    && all.includes('第三章 结论') && all.includes('第一章 引言'), JSON.stringify({ len: r.pages.length, total: r.total_chars }))
}

// ---- T4 read single page ----
{
  const r = await call('pdf_read', { source: chinese, page: 2 })
  check('T4 read page 2', r.mode === 'page' && r.pages.length === 1 && r.pages[0].page === 2
    && r.pages[0].text.includes('第二章') && !r.pages[0].text.includes('第一章'),
    JSON.stringify({ mode: r.mode, pages: r.pages.map((p) => [p.page, p.chars]) }))
}

// ---- T5 read range ----
{
  const r = await call('pdf_read', { source: chinese, range: '1-2' })
  check('T5 read range 1-2', r.mode === 'range' && r.pages.length === 2 && r.pages[0].page === 1 && r.pages[1].page === 2,
    JSON.stringify({ mode: r.mode, pages: r.pages.map((p) => p.page) }))
}

// ---- T6 read real lecture (7 pages) ----
{
  const r = await call('pdf_read', { source: lecture })
  const all = (r.pages ?? []).map((p) => p.text).join('\n')
  check('T6 read lecture 7 pages', r.page_count === 7 && r.pages.length === 7
    && all.includes('Parametric'), JSON.stringify({ pages: r.pages.length, total: r.total_chars, head: all.slice(0, 80) }))
}

// ---- T7 find Chinese query ----
{
  const r = await call('pdf_find', { source: chinese, query: '量子纠缠' })
  check('T7 find 量子纠缠', r.total_matches >= 1 && r.matches.some((m) => m.page === 1 && m.count >= 1),
    JSON.stringify({ total: r.total_matches, matches: r.matches }))
}

// ---- T8 find case+space insensitive ----
{
  const r = await call('pdf_find', { source: lecture, query: 'parametric equations' })
  check('T8 find case/space tolerant', r.total_matches >= 1 && r.matches.some((m) => m.page === 1),
    JSON.stringify({ total: r.total_matches, matches: r.matches }))
}

// ---- T9 find cross-space Chinese (letter: "马跃千山" vs "马跃 千山") ----
{
  const r = await call('pdf_find', { source: letter, query: '马跃千山' })
  check('T9 find whitespace-tolerant Chinese', r.total_matches >= 1 && r.matches[0].page === 1,
    JSON.stringify({ total: r.total_matches, matches: r.matches }))
}

// ---- T10 truncation ----
{
  const r = await call('pdf_read', { source: chinese, max_chars: 100 })
  const chars = (r.pages ?? []).reduce((acc, p) => acc + p.text.length, 0)
  check('T10 truncated at 100 chars', r.truncated === true && chars <= 100
    && r.chars_per_page.length >= 1 && r.chars_per_page[0].page === 1 && r.chars_per_page[1].page === 2,
    JSON.stringify({ truncated: r.truncated, chars, perPage: r.chars_per_page }))
}

// ---- T11 missing file ----
{
  try {
    await call('pdf_read', { source: 'tests/fixtures/does-not-exist.pdf' })
    check('T11 missing file errors', false, 'no error thrown')
  } catch (error) {
    check('T11 missing file errors', String(error.message).includes('找不到文件'), error.message)
  }
}

// ---- T12 out-of-range ----
{
  try {
    await call('pdf_read', { source: chinese, range: '1-999' })
    check('T12 range out of page count', false, 'no error thrown')
  } catch (error) {
    check('T12 range out of page count', String(error.message).includes('超出文档页数'), error.message)
  }
}

// ---- T13 page+range conflict ----
{
  try {
    await call('pdf_read', { source: chinese, page: 1, range: '1-2' })
    check('T13 page+range conflict', false, 'no error thrown')
  } catch (error) {
    check('T13 page+range conflict', String(error.message).includes('不能同时指定'), error.message)
  }
}

// ---- T14 URL download ----
{
  const pdfBytes = await readFile(join(FIXTURES, 'gen-chinese.pdf'))
  const server = createServer((req, res) => {
    if (req.url === '/gen.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdfBytes.length })
      res.end(pdfBytes)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const r = await call('pdf_read', { source: `http://127.0.0.1:${port}/gen.pdf` })
    const all = (r.pages ?? []).map((p) => p.text).join('\n')
    check('T14 URL download', r.page_count === 3 && all.includes('第一章 引言'),
      JSON.stringify({ pages: r.page_count, head: all.slice(0, 60) }))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ---- T15 image-only (no text layer) ----
{
  const r = await call('pdf_read', { source: 'tests/fixtures/gen-image-only.pdf' })
  check('T15 image-only reports empty text', r.page_count === 1 && r.pages.length === 1 && r.pages[0].chars === 0,
    JSON.stringify({ pages: r.pages }))
  const i = await call('pdf_inspect', { source: 'tests/fixtures/gen-image-only.pdf' })
  check('T15b image-only inspect chars 0', i.pages.length === 1 && i.pages[0].chars === 0, JSON.stringify(i.pages))
}

// ---- T16 page-set syntax (P0：D6 的可用性悬崖) ----
{
  const r = await call('pdf_read', { source: chinese, range: '3,1' })
  check('T16 逗号页码集合按选择器顺序返回', r.pages.length === 2 && r.pages[0].page === 3 && r.pages[1].page === 1,
    JSON.stringify(r.pages.map((p) => p.page)))
  const z = await call('pdf_read', { source: chinese, range: 'z' })
  check('T16b z = 末页', z.pages.length === 1 && z.pages[0].page === 3, JSON.stringify(z.pages.map((p) => p.page)))
  const open = await call('pdf_read', { source: chinese, range: '-2' })
  check('T16c -2 = 从首页到第 2 页', open.pages.length === 2 && open.pages[1].page === 2, JSON.stringify(open.pages.map((p) => p.page)))
  const tail = await call('pdf_read', { source: chinese, range: '2-' })
  check('T16d 2- = 第 2 页到末页', tail.pages.length === 2 && tail.pages[0].page === 2, JSON.stringify(tail.pages.map((p) => p.page)))
}

// ---- T17 pdf_find 的上限语义（P0：D8） ----
{
  const r = await call('pdf_find', { source: chinese, query: '第', max_matches: 3 })
  check('T17 total_matches 不超过 max_matches', r.total_matches <= 3, JSON.stringify({ total: r.total_matches }))
  check('T17b 每条命中都带 count 与 reported', r.matches.every((m) => Number.isInteger(m.count) && Number.isInteger(m.reported) && m.reported <= m.count),
    JSON.stringify(r.matches))
  check('T17c 达到上限时 truncated=true', r.truncated === true, JSON.stringify(r.truncated))
  const none = await call('pdf_find', { source: chinese, query: '这个词肯定不存在xyzzy' })
  check('T17d 无命中时 total=0', none.total_matches === 0 && none.matches.length === 0)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail === 0 ? 0 : 1)
