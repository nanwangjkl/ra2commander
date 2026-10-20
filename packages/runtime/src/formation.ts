/**
 * 编队注册表：命名编队与成员唯一归属。
 * 规则（对应产品需求）：成员重叠/重名先澄清不静默抢占；转编先撤销旧归属；
 * 保留建队历史；任务战损基准另在任务生效时冻结。
 */
export interface Formation {
  id: string
  /** 当前成员。 */
  memberIds: number[]
  /** 建队时原始成员（历史记录，不作为新任务战损口径）。 */
  originalMemberIds: number[]
  createdAt: number
}

export interface CreateResult {
  ok: boolean
  formation?: Formation
  /** 冲突明细：单位已被哪个编队占用。 */
  conflicts?: Array<{ unit: number; from: string }>
  reason?: string
}

export class FormationRegistry {
  private formations = new Map<string, Formation>()
  private unitOwner = new Map<number, string>()
  revision = 0

  clear(): void {
    this.revision++
    this.formations.clear()
    this.unitOwner.clear()
  }

  create(id: string, memberIds: number[], opts?: { force?: boolean }): CreateResult {
    if (this.formations.has(id)) return { ok: false, reason: `编队名 "${id}" 已存在` }
    const unique = [...new Set(memberIds)]
    const conflicts: CreateResult['conflicts'] = []
    for (const unit of unique) {
      const owner = this.unitOwner.get(unit)
      if (owner && owner !== id) conflicts.push({ unit, from: owner })
    }
    if (conflicts.length && !opts?.force) {
      return { ok: false, conflicts, reason: '成员与其他编队重叠，需澄清或 --force' }
    }
    // force 或无冲突：从原编队移出（明确抢占，记录在案）。
    for (const c of conflicts ?? []) this.removeFromFormation(c.unit)
    const formation: Formation = { id, memberIds: unique, originalMemberIds: [...unique], createdAt: Date.now() }
    this.formations.set(id, formation)
    for (const unit of unique) this.unitOwner.set(unit, id)
    this.revision++
    return { ok: true, formation }
  }

  /** 转编：明确命令才调用；先撤销原归属。 */
  transfer(unitIds: number[], toId: string): { ok: boolean; reason?: string } {
    const target = this.formations.get(toId)
    if (!target) return { ok: false, reason: `编队 "${toId}" 不存在` }
    for (const unit of unitIds) this.removeFromFormation(unit)
    for (const unit of unitIds) {
      if (!target.memberIds.includes(unit)) target.memberIds.push(unit)
      this.unitOwner.set(unit, toId)
    }
    this.revision++
    return { ok: true }
  }

  dissolve(id: string): void {
    const f = this.formations.get(id)
    if (!f) return
    for (const unit of f.memberIds) this.unitOwner.delete(unit)
    this.formations.delete(id)
    this.revision++
  }

  private removeFromFormation(unit: number): void {
    const owner = this.unitOwner.get(unit)
    if (!owner) return
    const f = this.formations.get(owner)
    if (f) f.memberIds = f.memberIds.filter((u) => u !== unit)
    this.unitOwner.delete(unit)
  }

  membersOf(id: string): number[] {
    return [...(this.formations.get(id)?.memberIds ?? [])]
  }

  originalOf(id: string): number[] {
    return [...(this.formations.get(id)?.originalMemberIds ?? [])]
  }

  ownerOf(unit: number): string | undefined {
    return this.unitOwner.get(unit)
  }

  list(): Formation[] {
    return [...this.formations.values()]
  }
}
