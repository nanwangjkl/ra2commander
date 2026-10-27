/** v3 在 v2 正文引用基础上，对动态列表按身份保存成员和字段变化。 */
type ObjectValue = Record<string, unknown>
type Identity = string | number
interface MemberDelta { id: Identity; patch: ObjectValue; removed: string[] }
interface ListDelta { key: string; changes: MemberDelta[]; removed: Identity[]; order?: Identity[] }
interface ObservationDelta { mode: 'full' | 'delta'; base: number; patch: ObjectValue; removed: string[]; lists?: Record<string, ListDelta> }
const keys: Record<string, string> = { goals: 'id', production: 'id', self: 'id', visibleEnemies: 'id', formations: 'id', skillRuns: 'id', exploration: 'goalId', programs: 'id', queues: 'type' }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
export function fieldDelta(previous: ObjectValue, next: ObjectValue): { patch: ObjectValue; removed: string[] } {
  return { patch: Object.fromEntries(Object.entries(next).filter(([key, value]) => !equal(previous[key], value))), removed: Object.keys(previous).filter(key => !Object.hasOwn(next, key)) }
}
export function applyFields(previous: ObjectValue, patch: ObjectValue, removed: string[]): ObjectValue {
  const next = { ...previous, ...patch }
  for (const key of removed) delete next[key]
  return next
}
function members(value: unknown, key: string): Map<Identity, ObjectValue> | undefined {
  if (!Array.isArray(value)) return
  const result = new Map<Identity, ObjectValue>()
  for (const member of value) {
    if (!object(member) || !['string', 'number'].includes(typeof member[key])) return
    const id = member[key] as Identity
    if (result.has(id)) return
    result.set(id, member)
  }
  return result
}
export function encodeObservation(previous: ObjectValue, next: ObjectValue, full: boolean, count: number): ObservationDelta {
  if (full || !count) return { mode: 'full', base: count - 1, patch: next, removed: [] }
  const delta = fieldDelta(previous, next), lists: Record<string, ListDelta> = {}
  for (const [field, key] of Object.entries(keys)) {
    if (!Object.hasOwn(delta.patch, field)) continue
    const before = members(previous[field], key), after = members(next[field], key)
    if (!before || !after) continue
    const changes: MemberDelta[] = []
    for (const [id, value] of after) {
      const diff = fieldDelta(before.get(id) ?? {}, value)
      if (Object.keys(diff.patch).length || diff.removed.length) changes.push({ id, ...diff })
    }
    const removed = [...before.keys()].filter(id => !after.has(id))
    const implicitOrder = [...before.keys()].filter(id => after.has(id)).concat([...after.keys()].filter(id => !before.has(id)))
    const list: ListDelta = { key, changes, removed, ...(!equal(implicitOrder, [...after.keys()]) ? { order: [...after.keys()] } : {}) }
    // 小列表直接保存反而更短，不为压缩引入更大的描述。
    if (JSON.stringify(list).length < JSON.stringify(next[field]).length) { lists[field] = list; delete delta.patch[field] }
  }
  return { mode: 'delta', base: count - 1, ...delta, ...(Object.keys(lists).length ? { lists } : {}) }
}
export function decodeObservation(previous: ObjectValue, value: unknown, count: number, version = 2): ObjectValue {
  if (!object(value) || !['full', 'delta'].includes(String(value.mode)) || !object(value.patch) || !Array.isArray(value.removed) || value.removed.some(key => typeof key !== 'string')
    || value.mode === 'delta' && value.base !== count - 1) throw new Error('观察变化缺少正确的前序记录或字段')
  const next = applyFields(value.mode === 'full' ? {} : previous, value.patch, value.removed)
  if (value.lists !== undefined) {
    if (version < 3 || value.mode !== 'delta' || !object(value.lists)) throw new Error('观察列表变化版本或结构非法')
    for (const [field, raw] of Object.entries(value.lists)) {
      if (Object.hasOwn(value.patch, field) || value.removed.includes(field) || !object(raw) || raw.key !== keys[field] || !Array.isArray(raw.changes) || !Array.isArray(raw.removed)) throw new Error('观察列表变化非法')
      const list = raw as unknown as ListDelta, values = members(previous[field], list.key)
      if (!values) throw new Error('观察列表缺少成员基准')
      for (const id of list.removed) if (!values.delete(id)) throw new Error('观察列表删除未知成员')
      const changed = new Set<Identity>()
      for (const change of list.changes) {
        if (!object(change) || !object(change.patch) || !Array.isArray(change.removed) || change.removed.some(key => typeof key !== 'string') || changed.has(change.id)) throw new Error('观察成员变化非法')
        changed.add(change.id)
        const member = applyFields(values.get(change.id) ?? {}, change.patch, change.removed)
        if (member[list.key] !== change.id || !['string', 'number'].includes(typeof change.id)) throw new Error('观察成员身份变化非法')
        values.set(change.id, member)
      }
      const order = list.order ?? [...values.keys()]
      if (!Array.isArray(order) || order.length !== values.size || new Set(order).size !== values.size || order.some(id => !values.has(id))) throw new Error('观察成员顺序非法')
      next[field] = order.map(id => values.get(id)!)
    }
  }
  return next
}
