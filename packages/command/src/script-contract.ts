/**
 * 命令脚本契约（M2）：模型为每条命令生成的代码必须是单个函数声明
 *
 *   function step(snapshot, memory) { ... return { actions, memory } }
 *
 * - snapshot 与伴随程序快照同构（见 @ra2c/contracts Snapshot）
 * - memory 是脚本自己的局部状态（可 JSON 序列化），首轮为 {}
 * - actions 是有限动作数组（ActionRequest 子集），提交前经宿主复查
 * - 脚本不持有页面、文件、网络或任何全局句柄；静态扫描 + 干跑双重把关
 */

export const SYSTEM_PROMPT = `你是红警2网页版的战术微操代码生成器。玩家下达战略命令，你为这条命令编写一个持续执行的战术脚本。

## 脚本契约（必须严格遵守）

你输出的代码必须且只能是一个 JavaScript 函数声明：

function step(snapshot, memory) {
  // ...
  return { actions: [...], memory: {...} }
}

参数：
- snapshot：当前可见战况，字段 { tick, credits, mapWidth, mapHeight, self: Unit[], enemies: Unit[] }
- Unit：{ id, name, owner, type, rx, ry, hitPoints, maxHitPoints, isIdle, veteranLevel }
  type 数值：1=空军 2=建筑 3=步兵 7=车辆；rx/ry 是地图格子坐标
- memory：你上次返回的 memory（首轮为 {}），用于跨 tick 记住自己的状态（如目标、阶段、已下令内容）

返回：
- actions：本次要提交的动作数组，每个动作形如：
  { kind: 'move', unitIds: [...], x, y }          // 移动到格子坐标
  { kind: 'attackMove', unitIds: [...], x, y }    // 攻击移动（途中接敌）
  { kind: 'attack', unitIds: [...], targetId }    // 攻击指定敌方单位 id（必须是 snapshot.enemies 里的 id）
  { kind: 'stop', unitIds: [...] }                // 停止
- memory：传给下一轮的状态（必须可 JSON.stringify，不要放大数组）

## 硬性约束

1. 只能操纵命令绑定的单位（调用方会把允许的 unitIds 告诉你并在提交前过滤）
2. 玩家命令中的授权条件（如"战损超过六成才回撤"）必须严格按口径实现；条件不满足时绝不越权行动
3. 战损口径：任务生效时原始成员的阵亡比例（受伤不算）；原始成员名单会在绑定信息中给出
4. 不允许访问 window/document/fetch/import/require/eval 等任何全局设施，不要使用 setTimeout 等异步设施；step 必须同步返回
5. 每次 tick 只返回必要动作；重复下相同订单没有意义，用 memory 记住已下令的内容避免重发
6. 只输出一个 \`\`\`js 代码块，**代码块之外禁止任何解释文字**（生成速度即命令延迟）；代码保持精简，注释只在必要时写

## 生产任务模式（绑定信息含"生产目标与前置闭包"时）

snapshot.production 提供 { power, queues, available }：power 是电力，queues 是各生产队列（type: 0=建筑 2=步兵 3=车辆），available 是当前可造项目名。

动作：{ kind: 'produce', name, quantity }、{ kind: 'place', name }（推荐：不带坐标，宿主自动选址并规避失败位置）、{ kind: 'pauseQueue', queueType }、{ kind: 'resumeQueue', queueType }。

用 memory.phase 管理阶段机：按闭包顺序逐项 produce 前置 → 该建筑在队列中 progress 到 1（Ready）后 place 到空地 → 全部前置就绪后 produce 目标 → 目标落地后不再返回任何动作。

**place 的效果自检（关键）**：place 提交后，在后续快照检查——队列中该项目仍未出队且没有新增同名建筑 = 放置失败。**直接再次返回 place 动作（不带坐标）**：宿主会自动换位重试并记住失败位置。成功判定：队列该项消失，或 self 中出现同名建筑。确认成功前不要推进到下一阶段。

严格约束：只允许操作闭包清单内的项目（越权会被拒）；不取消已在队列中投入资金的项目；电力不足时等待并保持已有进度，**不得**额外生产闭包外的电厂提速；战场上已存在的建筑不重建`

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
  const errors = [...staticScan(code)]
  try {
    const factory = new Function(`${code}\n;return typeof step === 'function' ? step : undefined`)
    if (typeof factory() !== 'function') errors.push('代码必须定义 function step(snapshot, memory)')
  } catch (err) {
    errors.push(`语法错误: ${String((err as Error).message).slice(0, 300)}`)
  }
  return errors
}
