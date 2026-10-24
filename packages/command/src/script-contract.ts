import { parse } from 'acorn'

/**
 * 统一脚本契约：模型为控制对象的完整目标集合生成单个函数声明
 *
 *   function step(snapshot, memory) { ... return { actions, memory } }
 *
 * - snapshot 与伴随程序快照同构（见 @ra2c/contracts Snapshot）
 * - memory 是脚本自己的局部状态（可 JSON 序列化），首轮为 {}
 * - actions 是有限动作数组（ActionRequest 子集），提交前经宿主复查
 * - 脚本不持有页面、文件、网络或任何全局句柄；静态扫描 + 干跑双重把关
 */

/** 从模型输出提取 js 代码块（或裸函数体）。兼容 maxTokens 截断导致未闭合的代码块。 */
export function extractCode(output: string): string | undefined {
  const fenced = output.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  // 未闭合的代码块（输出被 maxTokens 截断）：取 ```js 之后到末尾，截到最后一个完整的 return/} 处。
  const openFence = output.match(/```(?:js|javascript)?\s*\n([\s\S]*)$/)
  if (openFence?.[1]) {
    const body = openFence[1]
    const lastBrace = body.lastIndexOf('}')
    if (lastBrace > 0) return body.slice(0, lastBrace + 1).trim()
  }
  const bare = output.match(/function step\s*\(/)
  if (bare) {
    const start = output.indexOf(bare[0])
    return output.slice(start).trim()
  }
  return undefined
}

/** 脚本禁用的全局设施（静态扫描；执行器另有隔离）。 */
export const FORBIDDEN_IDENTS = [
  'window',
  'document',
  'globalThis',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'import',
  'require',
  'eval',
  'Function',
  'process',
  'setTimeout',
  'setInterval',
  'postMessage',
  'localStorage',
  'indexedDB',
  'navigator',
]

export function staticScan(code: string): string[] {
  const errors: string[] = []
  // 去掉字符串字面量与注释后扫描标识符，避免字符串内容误报。
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
  for (const ident of FORBIDDEN_IDENTS) {
    const re = new RegExp(`(?<![\\w.$])${ident}(?![\\w$])`)
    if (re.test(stripped)) errors.push(`禁止使用全局设施: ${ident}`)
  }
  return errors
}

/** 编译期检查：可编译、定义 step、无禁用全局。空数组 = 通过。 */
export function compileChecks(code: string): string[] {
  if (typeof code !== 'string' || Buffer.byteLength(code) > 65_536) return ['脚本超过 64 KiB 上限']
  const errors = [...staticScan(code)]
  try {
    const ast = parse(code, { ecmaVersion: 2022, sourceType: 'script' })
    const fn = ast.body[0]
    if (ast.body.length !== 1 || fn?.type !== 'FunctionDeclaration' || fn.id?.name !== 'step' || fn.async || fn.generator || fn.params.length !== 2 || fn.params.some(p => p.type !== 'Identifier')) {
      errors.push('代码必须且只能包含同步 function step(snapshot, memory) 声明，参数必须是两个普通标识符')
    }
  } catch (err) {
    errors.push(`语法错误: ${String((err as Error).message).slice(0, 300)}`)
  }
  return errors
}
