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
}

/** 每个采样窗口回传一次的有界快照。 */
export interface Snapshot {
  /** 会话代次：一局对局一个代次，换局递增。 */
  session: number;
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
}

/** MVP 动作请求；宿主提交前做会话与存活复查。 */
export type ActionRequest =
  | { kind: 'move'; unitIds: number[]; x: number; y: number }
  | { kind: 'attackMove'; unitIds: number[]; x: number; y: number }
  | { kind: 'gather'; unitIds: number[]; x: number; y: number }
  | { kind: 'attack'; unitIds: number[]; targetId: number }
  | { kind: 'stop'; unitIds: number[] }
  | { kind: 'scatter'; unitIds: number[] }
  | { kind: 'guard'; unitIds: number[] };

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
}

/** 任务脚本单次 step 的执行结果。 */
export interface StepOutcome {
  ok: boolean;
  actions: ActionRequest[];
  memory: unknown;
  error?: string | undefined;
}

export function isTileAction(a: ActionRequest): a is Extract<ActionRequest, { x: number }> {
  return a.kind === 'move' || a.kind === 'attackMove' || a.kind === 'gather';
}
