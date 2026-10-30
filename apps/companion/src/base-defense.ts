import { randomUUID } from 'node:crypto'
import type { CapabilityCall, ResolvedCapabilityParameters } from '@ra2c/command'
import type { CombatGoal } from '@ra2c/contracts'
import type { BindingContext, BoundCapability } from './capabilities/bindings.ts'
import { formationAlias, formationName, fullMap, normalizeName } from './capabilities/selectors.ts'
import type { CommandIntent } from './command-intent.ts'
import { bindDefaultMap } from './map-binding.ts'

export const isBaseRegion = (value = '') => /^(?:我方|己方)?(?:基地|基地车|建造厂)(?:附近|周围|所在区域|所在分区)?$/.test(value.replace(/\s+/g, ''))

export function normalizeBaseDefense(intent:CommandIntent,calls:CapabilityCall[]):CapabilityCall[] {
  const clauses=intent.clauses.filter(clause=>/(?:防守|守卫|保卫|守住|防御).{0,6}(?:基地|建造厂)/.test(clause.text))
  for(const clause of clauses) {
    const formations=clause.formationId?[clause.formationId]:[...new Set(calls.flatMap(call=>'formationId' in call.params&&call.params.formationId&&call.capability.startsWith('combat.')?[formationAlias(call.params.formationId)]:[]))]
    for(const formationId of formations) {
      let inserted=false
      calls=calls.flatMap(call=>{
        if(!('formationId' in call.params)||!call.params.formationId||formationAlias(call.params.formationId)!==formationId)return [call]
        if(call.capability==='formation.assign'&&!/编入|编到|组成|建队|归入|加入/.test(intent.raw))return []
        if(!['combat.hold','combat.move','combat.attack','combat.attack-all','combat.clear-region'].includes(call.capability))return [call]
        if(inserted)return []
        inserted=true
        const previous=call.capability==='combat.hold'?call.params:{}
        const {regionName:_region,bounds:_bounds,...params}=previous as Partial<ResolvedCapabilityParameters['combat.hold']>
        return [{capability:'combat.hold' as const,params:{...params,formationId,defendBase:true,mode:'hold' as const}}]
      })
      if(!inserted)calls.push({capability:'combat.hold',params:{formationId,defendBase:true}})
    }
  }
  return calls
}

export async function bindBaseDefense(params: ResolvedCapabilityParameters['combat.hold'], context: BindingContext): Promise<BoundCapability> {
  const { ctx } = context, snap = ctx.runtime.snapshot!, formationId = formationName(ctx, params.formationId, false, true)
  const catalog = await context.catalog()
  await bindDefaultMap(ctx); context.check()
  const yards = catalog.all.filter(item => catalog.isRole(item.name, 'constructionYard', item.type)).map(item => item.name)
  const vehicles = catalog.all.filter(item => catalog.isRole(item.name, 'constructionVehicle', item.type)).map(item => item.name)
  const members = snap.self.filter(unit => ctx.formations.ownerOf(unit.id) === formationId)
  const center = members.length ? { x: members.reduce((n,u)=>n+u.rx,0)/members.length, y: members.reduce((n,u)=>n+u.ry,0)/members.length } : undefined
  const distance = (unit: {rx:number;ry:number}) => center ? Math.hypot(unit.rx-center.x,unit.ry-center.y) : 0
  const base = snap.self.filter(unit => vehicles.includes(unit.name) || yards.includes(unit.name)).sort((a,b)=>Number(vehicles.includes(b.name))-Number(vehicles.includes(a.name)) || distance(a)-distance(b) || a.id-b.id)[0]
  if (!base) throw new Error('未找到己方基地车或建造厂，不能按部队当前位置代替基地防区')
  const area = ctx.mapRegions?.regionsAt(base.rx,base.ry)[0]
  if (!area) throw new Error('基地所在位置没有已绑定的地图分区，保留防守基地要求')
  const rule = catalog.all.find(item=>item.name===base.name)!
  const names = [base.name, rule.deploysInto, rule.undeploysInto].filter((name):name is string=>!!name)
  const goal: CombatGoal = {id:`command-${randomUUID().slice(0,8)}`,kind:'combat',rawText:context.text,formationId,executionMode:'native',mode:'hold',region:fullMap(snap),allowedActions:['move','attack','stop'],
    temporaryAbsenceNames:catalog.all.filter(item=>catalog.isRole(item.name,'terrorDrone',item.type)).map(item=>item.name),
    memberNames:Object.fromEntries(ctx.runtime.unobservableMembers(formationId).map(member=>[member.id,member.name])),
    baseDefense:{anchorId:base.id,anchorNames:[...new Set(names)],position:{x:base.rx,y:base.ry},region:{id:area.id,name:area.name,polygons:structuredClone(area.polygons)}},...(params.label?{label:params.label}:{})}
  if (params.retreatLoss !== undefined) {
    if (params.retreatX === undefined || params.retreatY === undefined || !Number.isInteger(params.retreatX) || !Number.isInteger(params.retreatY) || params.retreatX<0 || params.retreatY<0 || params.retreatX>=snap.mapWidth || params.retreatY>=snap.mapHeight) throw new Error('战损回撤缺少合法回撤点')
    goal.retreat={lossAbove:params.retreatLoss,x:params.retreatX,y:params.retreatY}
  } else if (params.retreatX !== undefined || params.retreatY !== undefined) throw new Error('回撤点缺少战损阈值')
  return {goals:[{goal,choice:`${formationId} 防守基地 #${base.id} 所在${area.name}分区：攻击进入分区的敌人，无敌人原地待命`}]}
}
