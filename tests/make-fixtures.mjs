// Generate deterministic test fixtures:
// - gen-chinese.pdf: 3 pages of Chinese text with a known outline-free structure
// - gen-image-only.pdf: a single image page with no text layer (scan-like)
import { writeFile, readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const FONT_PATH = 'C:/Windows/Fonts/simhei.ttf'

const pages = [
  [
    '第一章 引言',
    '本文档用于测试 PDF 阅读插件。',
    '第一章介绍量子纠缠与参数方程的基本概念，',
    '并讨论深度学习在威海校区的应用场景。',
  ],
  [
    '第二章 方法',
    '第二章给出两种方法：文本提取与关键词搜索。',
    '其中搜索支持大小写不敏感与空白容错。',
    '示例短语：机器学习与人工智能。',
  ],
  [
    '第三章 结论',
    '第三章总结全文，感谢老师与同学的支持。',
    '测试词包括：马跃千山、元旦、寒假。',
    'End of document.',
  ],
]

const doc = await PDFDocument.create()
doc.registerFontkit(fontkit)
const font = await doc.embedFont(await readFile(FONT_PATH))
for (const lines of pages) {
  const page = doc.addPage([595, 842])
  lines.forEach((text, index) => {
    page.drawText(text, { x: 60, y: 780 - index * 32, size: 14, font })
  })
}
await writeFile(new URL('../tests/fixtures/gen-chinese.pdf', import.meta.url), await doc.save())

// Image-only: embed a real white JPEG page (no text layer, scan-like).
const doc2 = await PDFDocument.create()
const img = await doc2.embedJpg(await readFile(new URL('../tests/fixtures/blank.jpg', import.meta.url)))
const page2 = doc2.addPage([300, 300])
page2.drawImage(img, { x: 0, y: 0, width: 300, height: 300 })
await writeFile(new URL('../tests/fixtures/gen-image-only.pdf', import.meta.url), await doc2.save())

console.log('fixtures written: gen-chinese.pdf, gen-image-only.pdf')
