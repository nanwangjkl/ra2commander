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
  elevation?: number;
  isIdle: boolean;
  harvester?: boolean;
  naval?: boolean;
  /** 本局公开规则中的移动速度，不代表实际地形上的瞬时速度。 */
  speed?: number;
  /** 引擎公开的移动向量，世界坐标 x/z 为地面方向；预测速度仍使用规则 speed。 */
  velocity?: { x: number; y: number; z: number };
  zone?: number;
  canDeploy?: boolean;
  isDeployed?: boolean;
  ammo?: number;
  hasWrenchRepair?: boolean;
  veteranLevel?: number;
  primaryWeapon?: { maxRange: number; minRange: number; aa: boolean; ag: boolean; cooldownTicks?: number };
  secondaryWeapon?: { maxRange: number; minRange: number; aa: boolean; ag: boolean; cooldownTicks?: number };
  transport?: { occupied: number; capacity: number; unitIds: number[]; passengers?: Array<{ id: number; name: string; type: number }> };
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
export interface BattleStatus {
  phase: 'playing' | 'ended'
  outcome?: 'victory' | 'defeat'
  evidence: 'public-player-status'
  players: Array<{ name: string; allied: boolean; defeated: boolean; combatant: boolean; isObserver: boolean }>
}
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
  country?: string;
  /** 仅依据公开玩家战败状态；敌人离开视野不代表胜利。 */
  battle?: BattleStatus;
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
  /** 对生产建筑设置集结点；底层 Move 的建筑语义，不移动现有部队。 */
  | { kind: 'setRallyPoint'; unitIds: number[]; x: number; y: number }
  | { kind: 'move'; unitIds: number[]; x: number; y: number }
  | { kind: 'attackMove'; unitIds: number[]; x: number; y: number }
  | { kind: 'gather'; unitIds: number[]; x: number; y: number }
  | { kind: 'attack'; unitIds: number[]; targetId: number; holdPosition?: boolean }
  | { kind: 'enterTransport'; unitIds: number[]; targetId: number }
  /** 对友方车辆使用当前维修武器；页面桥提交普通 Attack，不能强制攻击。 */
  | { kind: 'repair'; unitIds: number[]; targetId: number }
  /** 原生扳手维修的开启操作，不能重复切成关闭。 */
  | { kind: 'repairBuilding'; unitIds: number[] }
  | { kind: 'sellBuilding'; unitIds: number[] }
  | { kind: 'stop'; unitIds: number[] }
  | { kind: 'deploy'; unitIds: number[]; deployed?: boolean }
  | { kind: 'scatter'; unitIds: number[] }
  | { kind: 'guard'; unitIds: number[] }
  | { kind: 'produce'; name: string; quantity: number }
  | { kind: 'cancel'; name: string; quantity: number }
  | { kind: 'place'; name: string; x?: number; y?: number; placement?: import('./placement.ts').PlacementSlot; placementRegion?: import('./spatial.ts').TargetRegion }
  | { kind: 'pauseQueue'; queueType: number }
  | { kind: 'resumeQueue'; queueType: number };

export interface ActionResult {
  ok: boolean;
  /** 拒绝原因：stale-session / no-api / invalid-units / api-error。 */
  reason?: string;
  /** 实际进入 werhd 调用的单位数。 */
  submitted: number;
  session: number;
  placement?: { x: number; y: number; elevation?: number };
}

/** 任务脚本执行侧约束：执行器第一道把关（宿主提交前还有会话/存活复查）。 */
export interface StepConstraints {
  allowedUnitIds: number[];
  factoryRallyIds?: number[];
  enemyIds: number[];
  /** 掩护成员可就近对空自卫；不能扩大受护成员的原攻击目标。 */
  coverFire?: { unitIds: number[]; enemyIds: number[] };
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
  friendlyTargetIds?: number[];
  placements?: Record<string, import('./placement.ts').PlacementSlot>;
  placementRegions?: Record<string, import('./spatial.ts').TargetRegion>;
  region?: Region;
  targetRegion?: import('./spatial.ts').TargetRegion;
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

export { validateActions, validateScriptActions, liveScriptActions, inRegion } from './validate-actions.ts';
export { inTargetRegion, validTargetRegion, type TargetRegion } from './spatial.ts';
export * from './control.ts';
export * from './attack-objective.ts';
export * from './placement.ts';
export type { CommandEvent, CommandSource, CommandStage, GoalExecution } from './command-log.ts';
export type { BattleRecord, BattleRecordInfo, CommandFeedback, FeedbackRating, CurrentCommands } from './battle-record.ts';

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
