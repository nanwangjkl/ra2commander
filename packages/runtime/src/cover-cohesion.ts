import type { CoverPolicy, SnapshotUnit } from '@ra2c/contracts'

export interface CoverCohesion {
  coreIds: number[]
  catchingUpIds: number[]
  regroupSince?: number
  regroupIds?: number[]
  /** 当前任务累计实际等待时间，短暂会合不清零。 */
  regroupWaitTicks?: number
  /** 最近一次仍在等待的观察 tick；暂停恢复时一起平移。 */
  regroupTick?: number
}
const distance = (a: SnapshotUnit, b: SnapshotUnit) => Math.hypot(a.rx-b.rx,a.ry-b.ry)

/** 主体与追赶成员保持同队归属；只有会合后的成员参与主体速度和重聚判断。 */
export function coverCohort(members: SnapshotUnit[], policy: CoverPolicy, tick: number, previous?: CoverCohesion, heading?: { dx: number; dy: number }) {
  const span=Math.max(policy.gap,Math.sqrt(members.length)), ids=members.map(unit=>unit.id)
  const point= (units:SnapshotUnit[]) => {
    let selected:SnapshotUnit|undefined,minimum=Infinity
    for(const unit of units) {
      const cost=units.reduce((n,other)=>n+distance(unit,other),0)
      if(cost<minimum||cost===minimum&&unit.id<(selected?.id??Infinity)){selected=unit;minimum=cost}
    }
    return selected
  }
  let core=members.filter(unit=>previous?.coreIds.includes(unit.id))
  if (!core.length) {
    const remaining=new Set(ids), clusters:SnapshotUnit[][]=[]
    for (const unit of members) {
      if (!remaining.delete(unit.id)) continue
      const cluster=[unit]
      for(let i=0;i<cluster.length;i++) for(const candidate of members) if(remaining.has(candidate.id)&&distance(cluster[i]!,candidate)<=span*3){remaining.delete(candidate.id);cluster.push(candidate)}
      clusters.push(cluster)
    }
    const both=(units:SnapshotUnit[])=>units.some(u=>policy.escortIds.includes(u.id))&&units.some(u=>!policy.escortIds.includes(u.id))
    const speed=(units:SnapshotUnit[])=>Math.min(...units.map(u=>u.speed??0))
    const combined=clusters.some(both)
    core=clusters.sort((a,b)=>combined?Number(both(b))-Number(both(a))||b.length-a.length||a[0]!.id-b[0]!.id:speed(a)-speed(b)||b.length-a.length||a[0]!.id-b[0]!.id)[0]??[]
  }
  const center=point(core)
  // 以主体中位成员为会合点，不能通过追赶成员串接，把整条补员路线纳入主体。
  if(center) core=[...core,...members.filter(unit=>!core.some(body=>body.id===unit.id)&&distance(unit,center)<=span*1.5)]
  const middle=point(core)
  const separated=middle?core.filter(unit=>distance(unit,middle)>(previous?.regroupIds?.includes(unit.id)?span+policy.resumeGap:span*3)):[]
  const ahead=(unit:SnapshotUnit)=>!!middle&&!!heading&&Math.hypot(heading.dx,heading.dy)>1e-6
    && (unit.rx-middle.rx)*heading.dx+(unit.ry-middle.ry)*heading.dy>=0
  // 普通拉长/绕路只纠偏该成员；前锋不能因为领先被当作掉队者拖停全队。
  let regroup=separated.filter(unit=>!ahead(unit)&&(previous?.regroupIds?.includes(unit.id)||distance(unit,middle!)>span*6))
  const correcting=separated.filter(unit=>!regroup.includes(unit))
  const budget=policy.retryTicks*3
  let waited=previous?.regroupWaitTicks??0
  if(previous?.regroupSince!==undefined)waited+=Math.max(0,tick-(previous.regroupTick??previous.regroupSince))
  waited=Math.min(budget,waited)
  let regroupSince:number|undefined
  if (!policy.escortIds.length) {core=members;regroup=[];correcting.length=0}
  if (regroup.length) {
    // 同一任务的累计预算耗尽后，后续脱队也直接独立追赶，不能轮流重新计时。
    if(waited>=budget) {core=core.filter(unit=>!regroup.includes(unit));regroup=[]}
    else regroupSince=previous?.regroupSince??tick
  }
  const catchingUp=members.filter(unit=>!core.some(body=>body.id===unit.id))
  const state:CoverCohesion={coreIds:core.map(unit=>unit.id),catchingUpIds:catchingUp.map(unit=>unit.id),
    ...(waited||regroupSince!==undefined?{regroupWaitTicks:waited}:{}),
    ...(regroupSince!==undefined?{regroupSince,regroupTick:tick,regroupIds:regroup.map(unit=>unit.id)}:{})}
  return {core,catchingUp,regroup,correcting,point:point(core),state}
}
