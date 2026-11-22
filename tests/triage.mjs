/**
 * pdf_inspect 三态信号与元数据测试：XMP 保留、D: 日期真解析、表单/XFA/脚本信号、扫描页 triage，
 * 外加「两个插件共用同一套页码语法」的跨插件核对。
 * 用法：node tests/triage.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { parsePages } from '../lib/index.js'
import { loadReaderTools, makeChecker } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const tmp = join(here, 'tmp', 'triage')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const { check, done } = makeChecker('pdf-reader · 三态信号与元数据')
const env = await loadReaderTools()
const chinese = join(fixtures, 'gen-chinese.pdf')
const imageOnly = join(fixtures, 'gen-image-only.pdf')

/** Build a one-page PDF with an XMP packet and an exact `D:` creation date written into the Info dict. */
async function makeMetadataPdf(file, options = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([300, 400])
  page.drawText('metadata fixture', { x: 30, y: 350, size: 12, font })
  doc.setTitle(options.title ?? '字典标题')
  doc.setAuthor('字典作者')
  if (options.rawDate !== undefined) {
    // pdf-lib always writes `D:…Z`; the forms worth testing come from other producers, so the Info
    // entry is set literally (patching the bytes instead would shift every xref offset).
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict)
    info.set(PDFName.of('CreationDate'), PDFString.of(options.rawDate))
  }
  if (options.packet !== undefined) {
    const stream = doc.context.stream(new TextEncoder().encode(options.packet), { Type: 'Metadata', Subtype: 'XML' })
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream))
  }
  writeFileSync(file, await doc.save({ useObjectStreams: false, updateFieldAppearances: false }))
  return file
}

const XMP_PACKET = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">'
  + '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP 标题</rdf:li></rdf:Alt></dc:title>'
  + '<dc:creator><rdf:Seq><rdf:li>XMP 作者</rdf:li></rdf:Seq></dc:creator>'
  + '<pdf:Producer>XMP 生成器</pdf:Producer>'
  + '<xmp:CreateDate>2026-01-02T03:04:05+08:00</xmp:CreateDate>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'

console.log('== XMP 不再被丢弃，并与信息字典并列呈现 ==')
{
  const file = await makeMetadataPdf(join(tmp, 'xmp.pdf'), { packet: XMP_PACKET })
  const result = await env.call('pdf_inspect', { source: file })
  check('xmp_present=true', result.metadata.xmp_present === true)
  check('读到 XMP 标题', result.metadata.xmp.title === 'XMP 标题', JSON.stringify(result.metadata.xmp))
  check('读到 XMP 作者（rdf:Seq 形式）', result.metadata.xmp.creator === 'XMP 作者', JSON.stringify(result.metadata.xmp))
  check('读到 XMP 生成器与创建时间（这两个 pdfjs 的 get() 拿不到，靠解析原文）', result.metadata.xmp.producer === 'XMP 生成器' && result.metadata.xmp.created === '2026-01-02T03:04:05+08:00', JSON.stringify(result.metadata.xmp))
  check('信息字典同时回报，两者并列', result.metadata.title === '字典标题' && result.metadata.author === '字典作者')
  const text = env.text('pdf_inspect', result)
  check('渲染文案提示字典与 XMP 标题不一致', text.includes('信息字典与 XMP 的标题不一致'), text)
  const plain = await makeMetadataPdf(join(tmp, 'no-xmp.pdf'))
  const plainResult = await env.call('pdf_inspect', { source: plain })
  check('没有 XMP 包时 xmp_present=false 且 xmp 为空', plainResult.metadata.xmp_present === false && Object.keys(plainResult.metadata.xmp).length === 0)
}

console.log('== D: 日期真解析（ISO 8601 输出 + 无法解析时如实回报） ==')
{
  const offset = await makeMetadataPdf(join(tmp, 'date-offset.pdf'), { rawDate: "D:20260102030405+08'00'" })
  const result = await env.call('pdf_inspect', { source: offset })
  check("+08'00' 换算为 UTC ISO", result.metadata.created === '2026-01-01T19:04:05.000Z', String(result.metadata.created))
  const zulu = await makeMetadataPdf(join(tmp, 'date-z.pdf'), { rawDate: 'D:20260304050607Z' })
  check('Z 形式也转成 ISO', (await env.call('pdf_inspect', { source: zulu })).metadata.created === '2026-03-04T05:06:07.000Z')
  const partial = await makeMetadataPdf(join(tmp, 'date-partial.pdf'), { rawDate: 'D:2026' })
  check('不完整日期按 1 月 1 日 00:00 UTC 补齐（PDF 允许省略尾部）', (await env.call('pdf_inspect', { source: partial })).metadata.created === '2026-01-01T00:00:00.000Z')
  const broken = await makeMetadataPdf(join(tmp, 'date-broken.pdf'), { rawDate: 'D:not-a-date' })
  const brokenResult = await env.call('pdf_inspect', { source: broken })
  check('无法解析时原样回报而不是编一个日期', brokenResult.metadata.created === 'D:not-a-date', String(brokenResult.metadata.created))
  check('无法解析时给出 warning', brokenResult.warnings.some((line) => line.includes('无法解析')), JSON.stringify(brokenResult.warnings))
}

console.log('== 结构信号：表单字段数 / XFA / JavaScript ==')
{
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  const form = doc.getForm()
  form.createTextField('a').addToPage(page, { x: 10, y: 300, width: 100, height: 20 })
  form.createTextField('b').addToPage(page, { x: 10, y: 260, width: 100, height: 20 })
  form.createCheckBox('c').addToPage(page, { x: 10, y: 220, width: 16, height: 16 })
  const withForm = join(tmp, 'form.pdf')
  writeFileSync(withForm, await doc.save({ updateFieldAppearances: false }))
  const result = await env.call('pdf_inspect', { source: withForm })
  check('form_field_count=3', result.form_field_count === 3, String(result.form_field_count))
  check('xfa=false / js_actions=false', result.xfa === false && result.js_actions === false)
  const plain = await env.call('pdf_inspect', { source: chinese })
  check('无表单文档 form_field_count=null（而不是 0 冒充）', plain.form_field_count === null, String(plain.form_field_count))
}

console.log('== 扫描页 triage：无文本层但画了图 ==')
{
  const scan = await env.call('pdf_inspect', { source: imageOnly })
  check('扫描页被判为疑似扫描页', scan.pages[0].scanned_likely === true, JSON.stringify(scan.pages[0]))
  check('统计出 scanned_pages=1 且 scanned_likely=true', scan.scanned_pages === 1 && scan.scanned_likely === true)
  check('该页的图片算子数被统计出来', scan.pages[0].images >= 1, String(scan.pages[0].images))
  check('渲染文案给出 pdf_render + read_image 的行动建议', env.text('pdf_inspect', scan).includes('pdf_render') && env.text('pdf_inspect', scan).includes('read_image'))
  const text = await env.call('pdf_inspect', { source: chinese })
  check('文本页不误报为扫描页', text.scanned_pages === 0 && text.pages.every((page) => page.scanned_likely === false))
  check('文本充足的页不统计图片算子（省掉算子表开销）', text.pages.filter((page) => page.chars > 40).every((page) => page.images === -1), JSON.stringify(text.pages.map((page) => page.images)))
  check('已检查页数用 inspected_pages 表达', text.inspected_pages === text.page_count, `${text.inspected_pages}/${text.page_count}`)
}

console.log('== 页码语法：rN 与编辑器侧一致 ==')
{
  check('r1 = 末页', JSON.stringify(parsePages('r1', 7)) === '[7]')
  check('r2 = 倒数第 2 页', JSON.stringify(parsePages('r2', 7)) === '[6]')
  check('rN 可与其他项组合', JSON.stringify(parsePages('1,r1', 7)) === '[1,7]')
  let message = ''
  try {
    parsePages('r9', 7)
  } catch (error) {
    message = error.message
  }
  check('rN 越界时报错（不静默截断）', message.includes('超出文档页数'), message)
  const editor = await import(new URL(`file://${join(here, '..', '..', 'dsh-pdf-editor', 'lib', 'pages.js').replace(/\\/gu, '/')}`).href)
  const selectors = ['1', '2-4', '3-', '-2', 'z', 'r1', 'r3', '1,3,5-', 'z,r1']
  const mismatches = selectors.filter((selector) => JSON.stringify(parsePages(selector, 7)) !== JSON.stringify(editor.parsePages(selector, 7)))
  check('两个插件的选择器解析结果逐项一致（同一套语义）', mismatches.length === 0, mismatches.join('、'))
}

console.log('== pdf_read 的产出仍然只带 schema 声明的字段 ==')
{
  const result = await env.call('pdf_read', { source: chinese, range: 'r1' })
  check('r1 读到末页', result.pages.length === 1 && result.pages[0].page === 3, JSON.stringify(result.pages.map((page) => page.page)))
  const keys = Object.keys(result.pages[0]).sort().join(',')
  check('每页只含 page/chars/text（新增的布局信号不外泄）', keys === 'chars,page,text', keys)
}

void readFileSync
process.exit(done())
