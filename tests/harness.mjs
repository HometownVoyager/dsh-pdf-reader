/**
 * 测试小工具：用最小 ctx 桩把 dsh-pdf-reader 的工具注册出来，直接调用 execute。
 *
 * 渲染测试需要一个可注入的 attachments 桩（内联图像块的那条路径），所以这里接受 services 参数：
 * `loadReaderTools({ attachments: stub })`。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Raised when a tool result would not survive the harness's lossless-JSON result boundary. */
export class LosslessError extends Error {}

/**
 * Assert a tool result is lossless JSON.
 *
 * The harness rejects a result carrying `undefined` values, functions, symbols, non-finite numbers,
 * or exotic objects — at the real tool boundary, which a test calling `execute` directly would not
 * exercise. Every `call()` checks it here so the boundary cannot regress unnoticed.
 */
export function assertLossless(value, path = 'result') {
  const seen = new Set()
  const walk = (node, at) => {
    if (node === null) return
    const kind = typeof node
    if (kind === 'string' || kind === 'boolean') return
    if (kind === 'number') {
      if (!Number.isFinite(node)) throw new LosslessError(`${at} 不是有限数字：${node}`)
      return
    }
    if (kind === 'undefined') throw new LosslessError(`${at} 是 undefined（lossless JSON 不允许）`)
    if (kind !== 'object') throw new LosslessError(`${at} 的类型是 ${kind}，无法序列化`)
    if (seen.has(node)) throw new LosslessError(`${at} 存在循环引用`)
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`))
      seen.delete(node)
      return
    }
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) throw new LosslessError(`${at} 不是普通对象（${node.constructor?.name ?? 'unknown'}）`)
    for (const [key, item] of Object.entries(node)) walk(item, `${at}.${key}`)
    seen.delete(node)
  }
  walk(value, path)
}

/** Raised when a tool result does not satisfy the tool's own declared output schema. */
export class SchemaError extends Error {}

/**
 * Check a tool result against the tool's declared output schema.
 *
 * The harness validates every result against the schema before it reaches the model; a test that
 * calls `execute` directly never exercises that check, so an undeclared key (like an inline-image
 * field added after the fact) would pass the suite and fail live. Mirrors the enforced subset.
 */
export function assertMatchesSchema(value, schema, path = 'result') {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => {
      try {
        assertMatchesSchema(value, branch, path)
        return true
      } catch {
        return false
      }
    })
    if (matches.length !== 1) throw new SchemaError(`${path} 命中 ${matches.length} 个 oneOf 分支（要求恰好 1 个）`)
    return
  }
  if (schema.type === undefined) return
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(`${path} 应是对象，实际是 ${Array.isArray(value) ? 'array' : typeof value}`)
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const member = value[key]
      if (child.required === true && member === undefined) throw new SchemaError(`${path}.${key} 缺少必需字段`)
      if (member !== undefined) assertMatchesSchema(member, child, `${path}.${key}`)
    }
    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(schema.properties ?? {}))
      const extra = Object.keys(value).filter((key) => !declared.has(key))
      if (extra.length > 0) throw new SchemaError(`${path} 含未声明字段：${extra.join('、')}`)
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new SchemaError(`${path} 应是数组`)
    if (schema.items !== undefined) value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`))
    return
  }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type === 'integer' && !(actual === 'number' && Number.isInteger(value))) throw new SchemaError(`${path} 应是整数，实际是 ${actual}`)
  if (schema.type !== 'integer' && actual !== schema.type) throw new SchemaError(`${path} 应是 ${schema.type}，实际是 ${actual}`)
}

/** Register the reader plugin against a stub ctx and return its tools. */
export async function loadReaderTools(configOverrides = {}, services = {}) {
  const module = await import(new URL(`file://${join(here, '..', 'lib', 'index.js').replace(/\\/gu, '/')}`).href)
  const registered = new Map()
  const store = new Map(Object.entries(services))
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
    get: (name) => store.get(name),
  }
  // schemastery schemas are callable and resolve every `default()`, so tests run on deployed defaults.
  const config = { ...module.Config({}), ...configOverrides }
  module.apply(ctx, config)
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: process.cwd() } } } }
  return {
    tools: registered,
    exec,
    config,
    async call(name, args) {
      const tool = registered.get(name)
      if (tool === undefined) throw new Error(`工具未注册：${name}（已注册：${[...registered.keys()].join('、')}）`)
      const result = await tool.execute(args, exec)
      assertLossless(result, name)
      if (tool.output?.schema !== undefined) assertMatchesSchema(result, tool.output.schema, name)
      return result
    },
    async fail(name, args) {
      try {
        await this.call(name, args)
      } catch (error) {
        if (error instanceof LosslessError || error instanceof SchemaError) throw error
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error(`预期 ${name} 失败，但它成功了`)
    },
    /** Render one tool's model-facing content (an array of text/image blocks). */
    content(name, value, args = {}) {
      const renderFn = registered.get(name)?.output?.render
      return renderFn === undefined ? [] : renderFn(args, value)
    },
    text(name, value, args = {}) {
      return this.content(name, value, args).map((block) => block.type === 'text' ? block.text : '[image]').join('\n')
    },
  }
}

/** Tiny assertion helper shared by the tests. */
export function makeChecker(label) {
  let failures = 0
  let checks = 0
  const check = (name, condition, detail = '') => {
    checks++
    if (condition) console.log(`  ok   - ${name}`)
    else { failures++; console.log(`  FAIL - ${name} ${detail}`) }
  }
  return {
    check,
    done() {
      console.log(`\n${failures === 0 ? `ALL PASS（${checks} 项）` : `${failures} FAILURES（${checks} 项）`} — ${label}`)
      return failures === 0 ? 0 : 1
    },
  }
}

/** A stub attachment service that records what was saved and returns a plausible reference. */
export function stubAttachments() {
  let counter = 0
  const saved = []
  return {
    saved,
    service: {
      async saveImage(input) {
        counter++
        saved.push(input)
        return {
          attachmentId: `att-${counter}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 10,
          height: 20,
          ...(input.name === undefined ? {} : { name: input.name }),
        }
      },
    },
  }
}
