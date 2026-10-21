/**
 * 伴随程序与游戏页面桥之间的自定义契约。
 *
 * 这些不是游戏原生 API；原生 `window.werhd` 类型见 ./werhd-api.d.ts。
 * 桥脚本注入游戏页面后经 exposeBinding 回传快照，宿主经 evaluate 提交动作。
 */

/** 桥在页面上暴露/回传使用的全局名。 */
export const BINDING = {
  /** 页面内标记，防止重复注入。 */
  installedFlag: '__ra2cInstalled',
  /** 快照回传 binding（exposeBinding 注入的函数）。 */
  snapshot: '__ra2cSnapshot',
  /** 页面内当前会话代次存放处。 */
  session: '__ra2cSession',
} as const;

/** 快照中的己方/可见单位精简视图（全量字段按需扩展）。 */
export interface SnapshotUnit {
  id: number;
  name: string;
  owner?: string;
  /** ObjectType 数值：2=Building 3=Infantry 7=Vehicle 1=Aircraft。 */
  type: number;
  rx: number;
  ry: number;
  hitPoints?: number;
  maxHitPoints?: number;
  isIdle: boolean;
  veteranLevel?: number;
  primaryWeapon?: { maxRange: number; minRange: number; aa: boolean; ag: boolean };
  secondaryWeapon?: { maxRange: number; minRange: number; aa: boolean; ag: boolean };
}

/** 生产队列状态（werhd production.queues() 的映射）。 */
export interface ProductionQueueState {
  type: number;
  status: number;
  size: number;
  maxSize: number;
  items: Array<{ name: string; quantity: number; progress: number; creditsEach: number; creditsSpent: number }>;
}

/** 生产态势：电力、各队列与可造清单。 */
export interface ProductionState {
  power: { drain: number; total: number; isLowPower: boolean };
  queues: ProductionQueueState[];
  available: string[];
}

/** 每个采样窗口回传一次的有界快照。 */
export interface Snapshot {
  /** 会话代次：一局对局一个代次，换局递增。 */
  session: number;
  /** 页面刷新、浏览器重启与换局均重新生成，避免局部计数器碰撞。 */
  sessionKey: string;
  /** 递增序号，用于丢弃过期批次。 */
  seq: number;
  tick: number;
  time: number;
  credits: number;
  mapWidth: number;
  mapHeight: number;
  /** 己方全部单位（含建筑）。 */
  self: SnapshotUnit[];
  /** 当前可见的敌方单位（选敌/攻击目标来源），带上限护栏。 */
  enemies: SnapshotUnit[];
  /** 生产态势（进局后采集；游戏 API 不可用时缺省）。 */
  production?: ProductionState;
  /** 宿主为当前控制对象计算动态目标与执行事实。 */
  control?: import('./control.ts').ControlFrame;
  constraints?: StepConstraints;
}

/** 游戏动作请求；脚本返回时外包 goalId，页面桥仍只接收此原语。 */
export type ActionRequest =
  | { kind: 'move'; unitIds: number[]; x: number; y: number }
  | { kind: 'attackMove'; unitIds: number[]; x: number; y: number }
  | { kind: 'gather'; unitIds: number[]; x: number; y: number }
  | { kind: 'attack'; unitIds: number[]; targetId: number }
  | { kind: 'stop'; unitIds: number[] }
  | { kind: 'scatter'; unitIds: number[] }
  | { kind: 'guard'; unitIds: number[] }
  | { kind: 'produce'; name: string; quantity: number }
  | { kind: 'cancel'; name: string; quantity: number }
  | { kind: 'place'; name: string; x?: number; y?: number }
  | { kind: 'pauseQueue'; queueType: number }
  | { kind: 'resumeQueue'; queueType: number };

export interface ActionResult {
  ok: boolean;
  /** 拒绝原因：stale-session / no-api / invalid-units / api-error。 */
  reason?: string;
  /** 实际进入 werhd 调用的单位数。 */
  submitted: number;
  session: number;
}

/** 任务脚本执行侧约束：执行器第一道把关（宿主提交前还有会话/存活复查）。 */
export interface StepConstraints {
  allowedUnitIds: number[];
  enemyIds: number[];
  mapWidth: number;
  mapHeight: number;
  maxActions?: number;
  /** 生产任务可操作的项目名（必要前置闭包）；produce/cancel/place 只能操作名单内。 */
  allowedProduce?: string[];
  allowedPlace?: string[];
  productionQueueTypes?: Record<string, number>;
  queueSpace?: Record<number, number>;
  /** 缺省为空权限；额度按任务累计消耗，不能通过多次 step/修复重置。 */
  produceRemaining?: Record<string, number>;
  allowedQueueTypes?: number[];
  /** 只能恢复本任务实际暂停且未被后续操作改变的队列。 */
  resumableQueueTypes?: number[];
  allowedActions?: ActionRequest['kind'][];
  region?: Region;
  retreat?: { x: number; y: number; active: boolean };
  goals?: Record<string, import('./control.ts').GoalConstraints>;
  ignoreInactiveGoals?: boolean;
}

export interface Region {
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 从产生动作的快照继承，桥不得用当前会话覆盖它。 */
export interface ActionContext {
  session: number;
  sessionKey: string;
  seq: number;
}

export { validateActions, validateScriptActions, inRegion } from './validate-actions.ts';
export * from './control.ts';

/** 任务脚本单次 step 的执行结果。 */
export interface StepOutcome {
  ok: boolean;
  actions: import('./control.ts').ScriptAction[];
  memory: unknown;
  error?: string | undefined;
}

export function isTileAction(a: ActionRequest): a is Extract<ActionRequest, { x: number }> {
  return a.kind === 'move' || a.kind === 'attackMove' || a.kind === 'gather';
}
