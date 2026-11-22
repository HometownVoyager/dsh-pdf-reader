/**
 * pdf_render 测试：渲染成 PNG/JPEG、dpi/scale、页选择与上限、输出目录策略、内联图像块，
 * 以及 D16 的 standard_fonts 关键路径（渲染让这个常量从惰性变成 load-bearing）。
 * 用法：node tests/render.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { standardFontDataUrl } from '../lib/pdfjs.js'
import { loadReaderTools, makeChecker, stubAttachments } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const tmp = join(here, 'tmp', 'render')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const { check, done } = makeChecker('pdf-reader · pdf_render')
const chinese = join(fixtures, 'gen-chinese.pdf')
const imageOnly = join(fixtures, 'gen-image-only.pdf')

/** Count non-white pixels of a written image file. */
async function darkPixels(file) {
  const image = await loadImage(readFileSync(file))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let dark = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] < 200 && data[index + 1] < 200 && data[index + 2] < 200) dark++
  }
  return { dark, width: canvas.width, height: canvas.height }
}

console.log('== D16：standard_fonts 数据目录（渲染时变成关键路径） ==')
{
  const url = standardFontDataUrl()
  check('以 / 结尾（pdfjs 要求目录形式）', url.endsWith('/'), url)
  const dir = fileURLToPath(url)
  check('目录存在', existsSync(dir), dir)
  const entries = existsSync(dir) ? readdirSync(dir) : []
  check('目录里有标准字体数据（非嵌入字体的渲染要靠它）', entries.some((name) => /\.(pfb|ttf|otf)$/iu.test(name)), entries.slice(0, 5).join('、'))
}

console.log('== 渲染文本页：产出、尺寸与真实内容 ==')
{
  const env = await loadReaderTools()
  const out = join(tmp, 'basic')
  const result = await env.call('pdf_render', { source: chinese, range: '1', output: out })
  check('渲染 1 页', result.rendered.length === 1, JSON.stringify(result))
  const entry = result.rendered[0]
  check('文件真的写出来了', existsSync(entry.path), entry.path)
  check('PNG 魔数正确', readFileSync(entry.path).subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
  check('96dpi 下像素尺寸 ≈ 页面 point × 4/3', entry.width > 400 && entry.height > 600, `${entry.width}×${entry.height}`)
  check('summary 报出页数与体积', result.summary.includes('第 1 页') && result.summary.includes('PNG'), result.summary)
  const pixels = await darkPixels(entry.path)
  check('渲染图里有内容（非白像素 > 0，说明文字被真的画出来）', pixels.dark > 100, JSON.stringify(pixels))
  check('dpi 字段回报实际分辨率', result.dpi === 96 && Math.abs(result.scale - 4 / 3) < 0.01, `${result.dpi}/${result.scale}`)
  check('未内联时明确提示用 read_image 查看', env.text('pdf_render', result).includes('read_image'))
}

console.log('== dpi / scale / jpeg / quality ==')
{
  const env = await loadReaderTools()
  const out = join(tmp, 'sizes')
  const dpi144 = await env.call('pdf_render', { source: chinese, page: 1, dpi: 144, output: join(out, 'dpi144') })
  const dpi96 = await env.call('pdf_render', { source: chinese, page: 1, output: join(out, 'dpi96') })
  check('dpi=144 的像素宽度是 dpi=96 的 1.5 倍', Math.abs(dpi144.rendered[0].width / dpi96.rendered[0].width - 1.5) < 0.02, `${dpi144.rendered[0].width} vs ${dpi96.rendered[0].width}`)
  const scaled = await env.call('pdf_render', { source: chinese, page: 1, scale: 2, output: join(out, 'scale2') })
  check('scale=2 时 dpi 回报 144', scaled.dpi === 144 && scaled.rendered[0].width === dpi144.rendered[0].width, `${scaled.dpi}`)
  const jpeg = await env.call('pdf_render', { source: chinese, page: 1, format: 'jpeg', quality: 20, output: join(out, 'jpeg') })
  check('JPEG 魔数正确且扩展名为 .jpg', readFileSync(jpeg.rendered[0].path).subarray(0, 3).toString('hex') === 'ffd8ff' && jpeg.rendered[0].path.endsWith('.jpg'))
  const high = await env.call('pdf_render', { source: chinese, page: 1, format: 'jpeg', quality: 95, output: join(out, 'jpeg95') })
  check('quality 影响体积（20 比 95 小）', jpeg.rendered[0].bytes < high.rendered[0].bytes, `${jpeg.rendered[0].bytes} vs ${high.rendered[0].bytes}`)
  const bad = await env.fail('pdf_render', { source: chinese, page: 1, dpi: 0 })
  check('dpi=0 被拒绝', bad.includes('必须为正数'), bad)
}

console.log('== 页选择与单次上限 ==')
{
  const env = await loadReaderTools()
  const out = join(tmp, 'ranges')
  const two = await env.call('pdf_render', { source: chinese, range: '2-3', output: out })
  check('range 选中 2 页', two.rendered.map((entry) => entry.page).join(',') === '2,3', JSON.stringify(two.rendered.map((entry) => entry.page)))
  const fromEnd = await env.call('pdf_render', { source: chinese, range: 'r1', output: join(out, 'r1') })
  check('r1 = 末页（统一语法）', fromEnd.rendered[0].page === 3, JSON.stringify(fromEnd.rendered.map((entry) => entry.page)))
  const both = await env.fail('pdf_render', { source: chinese, page: 1, range: '2-3' })
  check('page 与 range 同时给报错', both.includes('不能同时指定'), both)
  const capped = await loadReaderTools({ maxRenderPagesPerCall: 1 })
  const over = await capped.fail('pdf_render', { source: chinese, range: '1-2', output: join(out, 'over') })
  check('超过单次页数上限时报错并建议分段', over.includes('超过单次上限 1 页'), over)
  const budget = await loadReaderTools({ maxRenderPixelsPerPage: 10_000 })
  const tooBig = await budget.fail('pdf_render', { source: chinese, page: 1, output: join(out, 'big') })
  check('超过单页像素上限时报错并给出可用 dpi', tooBig.includes('超过单页上限') && tooBig.includes('把 dpi 降到'), tooBig)
  // The byte cap is the *total* written bytes, so a single image bigger than it is an error while an
  // accumulation that crosses it stops the run — the cap is measured against the complete result.
  const single = await env.call('pdf_render', { source: chinese, range: '1-2', output: join(out, 'measure') })
  const perImage = Math.max(...single.rendered.map((entry) => entry.bytes))
  const singleCap = await loadReaderTools({ maxRenderBytesPerCall: Math.floor(perImage / 2) })
  const tooLarge = await singleCap.fail('pdf_render', { source: chinese, page: 1, output: join(out, 'too-large') })
  check('单张图超过上限时报错并给出降级建议', tooLarge.includes('单张渲染图过大') && tooLarge.includes('jpeg'), tooLarge)
  const small = await loadReaderTools({ maxRenderBytesPerCall: perImage * 2 + 10 })
  const truncated = await small.call('pdf_render', { source: chinese, range: '1-3', output: join(out, 'bytes') })
  check('累计体积超限时停止并如实报告', truncated.truncated === true && truncated.rendered.length >= 2 && truncated.warnings.some((line) => line.includes('超过单次上限')), JSON.stringify({ rendered: truncated.rendered.length, warnings: truncated.warnings }))
}

console.log('== 输出目录与覆盖策略 ==')
{
  const env = await loadReaderTools()
  const derived = await env.call('pdf_render', { source: chinese, page: 1 })
  check('缺省输出目录是 <原名>-pages/', derived.output_dir.endsWith('gen-chinese-pages'), derived.output_dir)
  check('文件名带页码', derived.rendered[0].path.endsWith('gen-chinese-p1.png'), derived.rendered[0].path)
  const again = await env.fail('pdf_render', { source: chinese, page: 1 })
  check('目标已存在且未给 overwrite 时报错', again.includes('overwrite=true'), again)
  const overwritten = await env.call('pdf_render', { source: chinese, page: 1, overwrite: true })
  check('overwrite=true 覆盖成功', overwritten.rendered.length === 1)
  rmSync(derived.output_dir, { recursive: true, force: true })
}

console.log('== 扫描页：渲染图不是空白（本插件不做 OCR 的答案） ==')
{
  const env = await loadReaderTools()
  const out = join(tmp, 'scan')
  const result = await env.call('pdf_render', { source: imageOnly, output: out })
  check('扫描件渲染成功', result.rendered.length === 1, JSON.stringify(result.warnings))
  const pixels = await darkPixels(result.rendered[0].path)
  check('渲染图有内容（图像被画出来，不是空白）', pixels.dark > 100, JSON.stringify(pixels))
  check('体积上报合理', statSync(result.rendered[0].path).size === result.rendered[0].bytes)
}

console.log('== inline：有附件服务时内联图像块，没有时如实提示 ==')
{
  const without = await loadReaderTools()
  const noService = await without.call('pdf_render', { source: chinese, page: 1, inline: true, output: join(tmp, 'no-inline') })
  check('无附件服务时 inline_images=0', noService.inline_images === 0)
  check('无附件服务时给出明确提示', noService.warnings.some((line) => line.includes('未挂载附件服务')), JSON.stringify(noService.warnings))
  check('仍然落盘（内联不是唯一产物）', existsSync(noService.rendered[0].path))
  check('渲染内容里没有图像块', without.content('pdf_render', noService).every((block) => block.type === 'text'))

  const stub = stubAttachments()
  const withService = await loadReaderTools({}, { attachments: stub.service })
  const inlined = await withService.call('pdf_render', { source: chinese, range: '1-2', inline: true, output: join(tmp, 'inline') })
  check('有附件服务时内联 2 张', inlined.inline_images === 2, JSON.stringify(inlined.rendered.map((entry) => entry.inline)))
  check('附件服务收到的是 PNG 字节与媒体类型', stub.saved.length === 2 && stub.saved[0].mediaType === 'image/png' && stub.saved[0].data.byteLength > 1000, JSON.stringify(stub.saved.map((entry) => entry.mediaType)))
  const blocks = withService.content('pdf_render', inlined)
  check('模型面内容 = 1 个文本块 + 2 个图像块', blocks.length === 3 && blocks[0].type === 'text' && blocks.filter((block) => block.type === 'image').length === 2, JSON.stringify(blocks.map((block) => block.type)))
  check('图像块携带附件引用（id/媒体类型/尺寸）', blocks[1].attachment.attachmentId === 'att-1' && blocks[1].attachment.mediaType === 'image/png' && blocks[1].attachment.width === 10, JSON.stringify(blocks[1].attachment))
  check('summary 说明已内联', inlined.summary.includes('已内联 2 张'), inlined.summary)
  const capped = await loadReaderTools({ maxInlineImages: 1 }, { attachments: stubAttachments().service })
  const one = await capped.call('pdf_render', { source: chinese, range: '1-2', inline: true, output: join(tmp, 'inline-cap') })
  check('内联上限生效并提示其余只落盘', one.inline_images === 1 && one.warnings.some((line) => line.includes('内联上限为 1 张')), JSON.stringify(one.warnings))
}

console.log('== 错误路径 ==')
{
  const env = await loadReaderTools()
  const missing = await env.fail('pdf_render', { source: join(fixtures, 'nope.pdf') })
  check('找不到文件时提示路径', missing.includes('找不到文件'), missing)
  const remote = await env.fail('pdf_render', { source: 'https://example.invalid/a.pdf' })
  check('远程来源失败时报下载失败（而不是静默）', remote.includes('下载失败') || remote.includes('不在允许列表'), remote)
}

process.exit(done())
