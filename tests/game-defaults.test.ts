import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createGameDefaultsSource } from '../packages/game-werhd/src/game-defaults.ts'

const origin = 'https://127.0.0.1:8787'
const source = createGameDefaultsSource(`${origin}/`)
function run(location = `${origin}/`, initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial))
  const context = { location: new URL(location), window: { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } }, console }
  runInNewContext(source, context)
  return { saved, context }
}

test('游戏首次启动预置音量、操作和遭遇战，玩家修改后重开保留选择', () => {
  const { saved, context } = run(`${origin}/index.html`, { _r_gameRes: '1', unrelated: 'keep' })
  const mixer = new Map(saved.get('_r_mixer_v3')!.split(';').map(pair => pair.split(',').map(Number) as [number, number]))
  assert.equal(mixer.get(0), 0.2)
  assert.equal(mixer.get(5), 0)
  assert.equal(mixer.get(6), 0.2)
  assert.equal(mixer.get(2), 0.3)
  assert.equal(saved.get('ra2web.mobileJoystickLite.enabled'), '0')
  assert.equal(saved.get('_r_opts_v3'), '15')
  assert.equal(saved.get('_r_lastMap'), 'mp32s8.map')
  assert.equal(saved.get('_r_lastMode'), '1')
  assert.equal(saved.get('_r_lastCountry'), '5')
  const slots = saved.get('_r_lastBots')!.split(',').map(Number)
  assert.equal(slots.length, 40)
  assert.deepEqual(slots.slice(5, 10), [1, 2, -2, -2, -2])
  assert.deepEqual(slots.filter((_, index) => index % 5 === 1), [-1, 2, -1, -1, -1, -1, -1, -1])
  saved.set('_r_mixer_v3', '0,0.7;5,0.4')
  saved.set('ra2web.mobileJoystickLite.enabled', '1')
  const preferences = { _r_opts_v3: '18,1', _r_lastMap: 'other.map', _r_lastMode: '2', _r_lastCountry: '8', _r_lastBots: '' }
  for (const [key, value] of Object.entries(preferences)) saved.set(key, value)
  runInNewContext(source, context)
  assert.equal(saved.get('_r_mixer_v3'), '0,0.7;5,0.4')
  assert.equal(saved.get('ra2web.mobileJoystickLite.enabled'), '1')
  for (const [key, value] of Object.entries(preferences)) assert.equal(saved.get(key), value)
  assert.equal(saved.get('_r_gameRes'), '1')
  assert.equal(saved.get('unrelated'), 'keep')
  const existing = run(`${origin}/`, { _r_mixer_v3: '0,0.5' }).saved
  assert.equal(existing.get('_r_mixer_v3'), '0,0.5')
  assert.equal(existing.get('ra2web.mobileJoystickLite.enabled'), '0')
})

test('默认设置只写入指定游戏文档，存储被拒绝不阻止游戏启动', () => {
  for (const url of [`${origin}/commander/`, `${origin}/config.json`, 'https://other.invalid/']) {
    assert.equal(run(url).saved.size, 0)
  }
  let warned = false
  assert.doesNotThrow(() => runInNewContext(source, {
    location: new URL(`${origin}/`), window: { get localStorage() { throw new Error('denied') } },
    console: { warn: () => { warned = true } },
  }))
  assert.equal(warned, true)
})
