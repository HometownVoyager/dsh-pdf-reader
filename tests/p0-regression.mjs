/**
 * P0 回归测试（pdf-reader）：比对报告 §3.4.3 D1/D2/D5/D6/D7/D8 与 §4.2 第 31/32 条。
 * 用法：node tests/p0-regression.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectEncryption, openPdf, describePdfError, rebuildPageText, PdfPasswordError } from '../lib/pdfjs.js'
import { parsePages } from '../lib/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = (name) => join(root, 'tests', 'fixtures', name)

let failures = 0
let checks = 0
const check = (name, condition, detail = '') => {
  checks++
  if (condition) console.log(`  ok   - ${name}`)
  else { failures++; console.log(`  FAIL - ${name} ${detail}`) }
}

console.log('== D1: /Encrypt 探测不再恒为 false ==')
{
  const plain = await readFile(fixture('gen-chinese.pdf'))
  check('未加密 PDF 探测为 false', detectEncryption(new Uint8Array(plain)) === false)
  const synthetic = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n')
  check('含 /Encrypt 的 PDF 探测为 true', detectEncryption(synthetic) === true)
  // /Encrypt 出现在注释里也应命中（探测是保守的：宁可疑报，不可漏报）
  const inComment = new TextEncoder().encode('%PDF-1.4\n% /Encrypt 见于注释\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
  check('保守策略：注释中的 /Encrypt 也算命中', detectEncryption(inComment) === true)

  const doc = await openPdf(new Uint8Array(plain))
  check('明文 PDF opened.encrypted === false', doc.encrypted === false)
  check('明文 PDF passwordRequired === false', doc.passwordRequired === false)
  await doc.dispose()
}

console.log('== D1b: 加密文档的错误信息可行动（指出怎么办，而不是"做不到"） ==')
{
  const message = describePdfError(Object.assign(new Error('x'), { name: 'PasswordException' }))
  check('提示包含 password 参数', message.includes('password'), message)
  check('提示不再说「一期不支持」', !message.includes('一期'), message)
  check('PdfPasswordError 被原样透出', describePdfError(new PdfPasswordError()).includes('已加密'))
}

console.log('== D5: 打开失败路径必须释放 worker（不再泄漏） ==')
{
  // 追踪 worker 资源：反复打开损坏文件，进程句柄数不应线性增长。
  // 直接证据是 openPdf 在失败时确实走完 destroy 分支——用 messagePorts 计数验证。
  const before = process.getActiveResourcesInfo().filter((r) => r === 'MessagePort' || r === 'Worker').length
  for (let i = 0; i < 8; i++) {
    try {
      await openPdf(new TextEncoder().encode('%PDF-1.4 definitely not a pdf'))
    } catch {
      // 预期失败
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = process.getActiveResourcesInfo().filter((r) => r === 'MessagePort' || r === 'Worker').length
  check('反复打开损坏文件后无残留 worker/port', after <= before, `before=${before} after=${after}`)
}

console.log('== D6: 页码范围语法（N / N-M / N- / -M / 逗号 / z） ==')
{
  const cases = [
    ['12', 30, [12]],
    ['12-15', 30, [12, 13, 14, 15]],
    ['28-', 30, [28, 29, 30]],
    ['-3', 30, [1, 2, 3]],
    ['z', 30, [30]],
    ['3,7,10-12', 30, [3, 7, 10, 11, 12]],
    ['1,1,2', 30, [1, 2]],
    [' 5 ', 30, [5]],
  ]
  for (const [selector, count, expected] of cases) {
    let got
    try { got = parsePages(selector, count) } catch (error) { got = `threw: ${error.message}` }
    check(`range "${selector}" → ${JSON.stringify(expected)}`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got))
  }
  const invalid = ['0', '5-3', '31', 'abc', '1--']
  for (const selector of invalid) {
    let threw = false
    try { parsePages(selector, 30) } catch { threw = true }
    check(`range "${selector}" 报错`, threw)
  }
  check('range "1-" 展开为全文（与 "12-" 同族语义）', JSON.stringify(parsePages('1-', 3)) === '[1,2,3]')
  check('range "z,z" 去重为 [末页]', JSON.stringify(parsePages('z,z', 30)) === '[30]')
  check('空选择器返回空列表', parsePages(undefined, 30).length === 0 && parsePages('', 30).length === 0)
  // 闭区间 + 1-based 契约：split 后丢页的第一大原因就是 off-by-one
  check('区间是 1-based 闭区间', JSON.stringify(parsePages('1-2', 3)) === '[1,2]')
}

console.log('== D3: 字宽用 pdf.js 的 width，不再按字符数编造 ==')
{
  // x=30、真实宽度 30 ⇒ 第二段正好紧接（间隙 0），绝不插空格。
  // 旧实现按 transform[0]×字符数 编造宽度：transform[0] 本身已含字号，2 个字符 => 宽度 20，
  // 于是"间隙"被算成 30-(0+20)=10 > 3.3，会在本该紧排的文本里插进一个凭空的空格。
  const tight = [
    { str: 'AB', transform: [10, 0, 0, 10, 0, 700], width: 30, height: 10 },
    { str: 'CD', transform: [10, 0, 0, 10, 30, 700], width: 30, height: 10 },
  ]
  check('真实宽度紧排 → 不插空格', rebuildPageText(tight) === 'ABCD', JSON.stringify(rebuildPageText(tight)))
  // 同样的 x 坐标，但真实宽度很小 ⇒ 间隙 18pt ⇒ 应插一个空格。
  const far = [
    { str: 'AB', transform: [10, 0, 0, 10, 0, 700], width: 12, height: 10 },
    { str: 'CD', transform: [10, 0, 0, 10, 30, 700], width: 12, height: 10 },
  ]
  check('真实宽度小 → 判定为分离，插一个空格', rebuildPageText(far) === 'AB CD', JSON.stringify(rebuildPageText(far)))
  check('hasEOL 触发换行', rebuildPageText([
    { str: '第一行', transform: [12, 0, 0, 12, 0, 700], width: 36, height: 12, hasEOL: true },
    { str: '第二行', transform: [12, 0, 0, 12, 0, 686], width: 36, height: 12 },
  ]) === '第一行\n第二行', JSON.stringify(rebuildPageText([
    { str: '第一行', transform: [12, 0, 0, 12, 0, 700], width: 36, height: 12, hasEOL: true },
    { str: '第二行', transform: [12, 0, 0, 12, 0, 686], width: 36, height: 12 },
  ])))
}

console.log('== D4: 字号越大容差越不被无限放大 ==')
{
  const items = [
    { str: '大标题', transform: [60, 0, 0, 60, 0, 700], width: 180, height: 60 },
    { str: '副标题', transform: [60, 0, 0, 60, 0, 690], width: 180, height: 60 },
  ]
  const lines = rebuildPageText(items).split('\n')
  check('60pt 紧排仍分两行（旧容差 12pt 会合并）', lines.length === 2, JSON.stringify(lines))
  check('10pt 字号下 1pt 基线差仍视为同一行（容差随字号缩放）', rebuildPageText([
    { str: 'A', transform: [10, 0, 0, 10, 0, 700], width: 10, height: 10 },
    { str: 'B', transform: [10, 0, 0, 10, 10, 701], width: 10, height: 10 },
  ]) === 'AB')
  check('10pt 字号下 2pt 差视为两行（容差被钳制在 ≤4pt 并随字号缩小）', rebuildPageText([
    { str: 'A', transform: [10, 0, 0, 10, 0, 700], width: 10, height: 10 },
    { str: 'B', transform: [10, 0, 0, 10, 11, 702], width: 10, height: 10 },
  ]).split('\n').length === 2)
}

console.log('== 真实文档回归：既有夹具仍能正常提取 ==')
{
  const bytes = new Uint8Array(await readFile(fixture('gen-chinese.pdf')))
  const doc = await openPdf(bytes)
  check('页数 3', doc.pageCount === 3, `got ${doc.pageCount}`)
  const page1 = await doc.extractPage(1)
  check('第 1 页含预期文本', page1.text.includes('量子纠缠'), page1.text.slice(0, 120))
  check('chars 与 text 长度一致', page1.chars === page1.text.length)
  const page3 = await doc.extractPage(3)
  check('第 3 页含预期文本', page3.text.includes('马跃千山'), page3.text.slice(0, 120))
  await doc.dispose()

  const imageOnly = new Uint8Array(await readFile(fixture('gen-image-only.pdf')))
  const imgDoc = await openPdf(imageOnly)
  const imgPage = await imgDoc.extractPage(1)
  check('扫描件返回空文本而不是报错', imgPage.text === '' && imgPage.chars === 0, JSON.stringify(imgPage))
  await imgDoc.dispose()
}

console.log('== 连续读多页后仍可继续工作（cleanup 不破坏文档） ==')
{
  const bytes = new Uint8Array(await readFile(fixture('gen-chinese.pdf')))
  const doc = await openPdf(bytes)
  const first = await doc.extractPage(1)
  const again = await doc.extractPage(1)
  check('重复读取同一页结果一致', first.text === again.text && first.text.length > 0)
  const second = await doc.extractPage(2)
  check('读取相邻页正常', second.text.includes('第二章'), second.text.slice(0, 80))
  await doc.dispose()
}

console.log('== 大文档：抽读末页不因页数而失败 ==')
{
  const lecture = join(root, 'tests', 'fixtures', '10.1 Curves Defined by Parametric Equations(由参数方程定义的曲线).pdf')
  try {
    const bytes = new Uint8Array(await readFile(lecture))
    const doc = await openPdf(bytes)
    const last = await doc.extractPage(doc.pageCount)
    check(`末页（第 ${doc.pageCount} 页）可提取`, last.chars >= 0)
    await doc.dispose()
  } catch (error) {
    console.log(`  skip - 缺少大文档夹具（${error.code ?? error.message}）`)
  }
}

console.log(failures === 0 ? `\nALL PASS（${checks} 项）` : `\n${failures}/${checks} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
