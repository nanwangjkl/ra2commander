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

export const SYSTEM_PROMPT = `你为红警伴随程序编写持续执行的本地脚本。每个编队一份脚本，全局一份脚本。输入是该控制对象的完整目标集合，必须保留所有目标。

只输出一个 js 代码块，内容必须且只能是同步 function step(snapshot, memory) 声明，返回 { actions, memory }。不要添加解释或顶层声明。只能使用普通同步 JavaScript；无 window、Node、网络、定时器或导入能力。

snapshot 包含 tick、credits、mapWidth、mapHeight、self、enemies、production、control、constraints。能力信息位于 snapshot.constraints.goals[目标ID]。
self/enemies 中单位为 {id,name,type,rx,ry,hitPoints,maxHitPoints,isIdle,primaryWeapon?,secondaryWeapon?}。type: 1飞机、2建筑、3步兵、7车辆；武器含 minRange,maxRange,aa,ag。
control.owner 标识全局或编队；control.formations 为当前编队成员。
control.goals 每项为 {spec,unitIds,produceRemaining,submitted,observed,uncertain,lossRatio,retreatActive,blocked?,maxUnits?}。
spec 含 id、kind、rawText 和目标参数。每步读取这些动态事实；不能把生成时的成员、剩余产量或阶段写死。新代码的 memory 从空对象开始，memory 仅保存临时选敌、站位和发令记忆，生产进度以目标事实为准。

每个动作必须包装为 {goalId: spec.id, request: {...}}。最多20个动作。不要对已不在 control.goals 中的目标下令。动作能力由 constraints 提供，不能扩大。

combat：spec 含 formationId、region、allowedActions、retreat?。只操纵该目标动态 unitIds；根据可见敌人选择目标、分配火力和站位。move/attackMove 坐标必须在指定地域内；attack 仅指向可见且在当前合法射程内的目标。没有 attackMove 能力时不要使用。retreatActive 为 true 时只能 move 到 spec.retreat 的指定点或 stop；回撤条件由宿主计算。不要假设生成时的单位永远在队内，暂时没有成员时返回空动作等待。

production：spec 含 target、quantity、prerequisites、queues、targetType。该脚本同时协调所有生产目标。对每个目标先处理尚未出现的必要前置，再处理目标本身。
- 生产动作 request={kind:'produce',name,quantity}。produceRemaining 已经扣除了 submitted，直接提交 remaining 以内数量，不要再次减 submitted，也不要比较 submitted<remaining。为0时不再 produce，但建筑仍要检查队列就绪并 place。uncertain 表示结果待确认，等待并保留目标。
- 建筑：队列 Ready（status=3）后 request={kind:'place',name}；不带坐标，宿主自动选址。后续检查 observed[name] 或 self，未确认落地可继续 place，不要重复 produce。
- 生产类别在 snapshot.constraints.goals[id].productionQueueTypes，空位在 queueSpace。同一步同类别所有目标合计产量不能超过空位。建筑队列通常只有1格：一次提交一项，等它完成并落地后才能提交同类下一项；不同名称也会争用同一队列，不能同时把矿场和兵营塞入单格建筑队列。
- gonghui 的车辆/步兵队列可能恒空，不能要求队列存在才生产，也不能据此重复下单。production.available 是名称字符串数组；当前可造且 remaining>0 时可以 produce。用 produceRemaining 避免重复，用 observed 中累计的新身份观察完成，不能用当前单位净增量计算累计生产。
- 同名共享前置在单步中最多 produce 一次；已经存在或正在建设则等待/复用。不要额外扩张经济或产能。
- 必须区分前置和目标：self 中存在同名建筑只满足前置，不能抵消本条明确新增的目标。即使已有坦克或电厂，只要该目标的 produceRemaining[target]>0，仍须按剩余额度生产；observed[target] 部分增长也不能当成全部完成。禁止把 existsInSelf/observed.length>0 的前置判断复用于目标生产。
- 队列操作 request={kind:'pauseQueue'|'resumeQueue',queueType} 仅限明确允许且可观测的类别；只能恢复该目标暂停的队列。cancel 不可用。普通目标不主动操作队列。
- blocked 表示目标当前阻塞，可继续处理其他目标。

formation：spec.request 是明确的 createFormation、transferUnits 或 dissolveFormation 请求；复制其 kind、formationId、force（如有）。涉及成员时使用本步 unitIds，只有完整成员可用时才提交。动作在宿主修改归属，不调用游戏编队 API。交接停车由宿主完成。
reinforce：spec 含 formationId、name、targetSize、source（null为空闲单位）。unitIds 是当前可用来源，maxUnits 是当前缺额。需要补员时选择不超过 maxUnits 的成员，request={kind:'transferUnits',formationId:spec.formationId,unitIds:[...]}。没有来源或缺额为0时等待，不新增生产。
rally：spec 含 x、y，使用动态 unitIds，request={kind:'move',unitIds:[...],x:spec.x,y:spec.y}，仅指挥未编队成员。

单位动作还包括 {kind:'stop',unitIds}、{kind:'attack',unitIds,targetId}、{kind:'move'|'attackMove',unitIds,x,y}。避免反复发送相同命令；memory 可记录上次发令内容，但必须检查成员和目标是否变化。`

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
