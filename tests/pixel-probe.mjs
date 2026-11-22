/**
 * 像素探针：在**纯文本模型路由**下核对渲染图的几何事实。
 *
 * 渲染的目视闭环本来是把 PNG 交给视觉模型；当前路由不接受图像输入（宿主会明确提示
 * "image omitted because this model accepts text only"），于是用一个可复现的替代手段：
 * 直接数像素，回答「内容有没有画出来」「盖章有没有落在请求的位置」。
 *
 * 用法：
 *   node tests/pixel-probe.mjs <png> [pageWidthPt] [pageHeightPt] [dpi] \
 *        [--region x1,y1,x2,y2]...     # 区域用 PDF 坐标（pt，左下原点）给出
 *
 * 不带 --region 时报告整页的非白像素占比；带 --region 时逐区域报告深色/红色像素数。
 */
import { readFileSync } from 'node:fs'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const args = process.argv.slice(2)
const file = args[0]
if (file === undefined) {
  console.error('用法：node tests/pixel-probe.mjs <png> [pageWidthPt] [pageHeightPt] [dpi] [--region x1,y1,x2,y2]...')
  process.exit(2)
}
const positional = args.slice(1).filter((value) => !value.startsWith('--'))
const pageWidth = Number(positional[0] ?? 595.28)
const pageHeight = Number(positional[1] ?? 841.89)
const dpi = Number(positional[2] ?? 96)
const regions = args.flatMap((value, index) => (value === '--region' ? [args[index + 1]] : []))
  .filter((value) => typeof value === 'string')
  .map((value) => value.split(',').map(Number))

const image = await loadImage(readFileSync(file))
const canvas = createCanvas(image.width, image.height)
const context = canvas.getContext('2d')
context.drawImage(image, 0, 0)
const { data } = context.getImageData(0, 0, canvas.width, canvas.height)

/** PDF points (origin bottom-left) → image pixels (origin top-left). */
const scale = dpi / 72
const toPixels = (xPt, yPt) => ({ x: xPt * scale, y: (pageHeight - yPt) * scale })

function measure(x0, y0, x1, y1) {
  let dark = 0
  let red = 0
  let total = 0
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(canvas.height, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(canvas.width, Math.round(x1)); x++) {
      const index = (y * canvas.width + x) * 4
      const [r, g, b] = [data[index], data[index + 1], data[index + 2]]
      total++
      if (r < 200 && g < 200 && b < 200) dark++
      if (r > 120 && g < 90 && b < 90) red++
    }
  }
  return { dark, red, total, darkPct: total === 0 ? '0%' : `${(dark / total * 100).toFixed(2)}%` }
}

console.log(`图像：${image.width}×${image.height}px（页面 ${pageWidth}×${pageHeight}pt @ ${dpi}dpi）`)
console.log(`整页：${JSON.stringify(measure(0, 0, canvas.width, canvas.height))}`)
for (const region of regions) {
  const [x1, y1, x2, y2] = region
  const a = toPixels(x1, y1)
  const b = toPixels(x2, y2)
  const box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
  console.log(`区域 (${x1},${y1})-(${x2},${y2})pt → 图像 ${Math.round(box.x0)},${Math.round(box.y0)}-${Math.round(box.x1)},${Math.round(box.y1)}：${JSON.stringify(measure(box.x0, box.y0, box.x1, box.y1))}`)
}
