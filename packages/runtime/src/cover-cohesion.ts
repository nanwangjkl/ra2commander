import type { CoverPolicy, SnapshotUnit } from '@ra2c/contracts'

export interface CoverCohesion {
  coreIds: number[]
  catchingUpIds: number[]
  regroupSince?: number
  regroupIds?: number[]
}
const distance = (a: SnapshotUnit, b: SnapshotUnit) => Math.hypot(a.rx-b.rx,a.ry-b.ry)

/** 主体与追赶成员保持同队归属；只有会合后的成员参与主体速度和重聚判断。 */
export function coverCohort(members: SnapshotUnit[], policy: CoverPolicy, tick: number, previous?: CoverCohesion) {
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
  let regroupSince=previous?.regroupSince
  const middle=point(core)
  let regroup=middle?core.filter(unit=>distance(unit,middle)>(previous?.regroupIds?.includes(unit.id)?span+policy.resumeGap:span*3)):[]
  if (!policy.escortIds.length) {core=members;regroup=[]}
  if (regroup.length) {
    regroupSince??=tick
    // 重聚有明确上限，绕路/受阻成员转为追赶，不能让主体无限停车。
    if(tick-regroupSince>=policy.retryTicks*3) {core=core.filter(unit=>!regroup.some(lagging=>lagging.id===unit.id));regroup=[];regroupSince=undefined}
  } else regroupSince=undefined
  const catchingUp=members.filter(unit=>!core.some(body=>body.id===unit.id))
  const state:CoverCohesion={coreIds:core.map(unit=>unit.id),catchingUpIds:catchingUp.map(unit=>unit.id),...(regroupSince!==undefined?{regroupSince,regroupIds:regroup.map(unit=>unit.id)}:{})}
  return {core,catchingUp,regroup,point:point(core),state}
}
