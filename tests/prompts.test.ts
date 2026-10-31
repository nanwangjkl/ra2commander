import test from 'node:test'
// 保留脚本生成、替换与修复链路的覆盖；默认本机生产另由集成用例验证。
process.env.RA2C_PRODUCTION_EXECUTOR = 'script'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileCommand, loadPrompts, readPrompts, PromptLoader } from '../packages/command/src/index.ts'
import { ProgramController } from '../apps/companion/src/controller.ts'
import { FormationRegistry, persistState, restoreState } from '../packages/runtime/src/index.ts'
import { code, harness, outcome, production, snapshot } from './helpers.ts'

const markdown = (name: string) => readFileSync(new URL(`../prompts/templates/${name}`, import.meta.url), 'utf8').trim()

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-prompts-'))
  const directory = join(root, 'prompts/templates')
  cpSync(new URL('../prompts/templates/', import.meta.url), directory, { recursive: true })
  cpSync(new URL('../prompts/capabilities/', import.meta.url), join(root, 'prompts/capabilities'), { recursive: true })
  cpSync(new URL('../prompts/games/', import.meta.url), join(root, 'prompts/games'), { recursive: true })
  cpSync(new URL('../prompts/tactics/', import.meta.url), join(root, 'prompts/tactics'), { recursive: true })
  cpSync(new URL('../skills/', import.meta.url), join(root, 'skills'), { recursive: true })
  const url = pathToFileURL(directory + sep)
  return { directory, url, loader: new PromptLoader(url), dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('提示词来自 Markdown，限定变量渲染且相同内容复用版本缓存', () => {
  const prompts = loadPrompts()
  assert.match(prompts.version, /^sha256:[0-9a-f]{16}$/)
  assert.equal(prompts.render('interpret'), [markdown('interpret.md').replace('{{capabilities}}', () => prompts.capabilities.render()).replace('{{skills}}', () => prompts.skills.renderIndex()), prompts.game.instructions, ...prompts.tactics.select('interpret').map(tactic => tactic.text)].join('\n\n'))
  assert.equal(prompts.render('compile'), markdown('compile.md'))
  assert.equal(prompts.render('repair', { error: '运行失败' }), markdown('repair.md').replace('{{error}}', '运行失败'))
  assert.equal(prompts.render('validationFeedback', { errors: '语法错误' }), markdown('validation-feedback.md').replace('{{errors}}', '语法错误'))
  assert.equal(loadPrompts(), prompts)
  assert.throws(() => prompts.render('repair', { error: 'x', extra: 'y' } as never), /不接受变量 extra/)
  assert.equal(prompts.render('repair', { error: '{{errors}} $&' }), markdown('repair.md').replace('{{error}}', () => '{{errors}} $&'))
})

test('改动在下一次加载生效，错误文件保留整套旧提示，严格检查仍报错', () => {
  const files = fixture()
  const previousCwd = process.cwd()
  try {
    process.chdir(files.directory)
    const current = loadPrompts()
    assert.equal(current.render('interpret'), [markdown('interpret.md').replace('{{capabilities}}', () => current.capabilities.render()).replace('{{skills}}', () => current.skills.renderIndex()), current.game.instructions, ...current.tactics.select('interpret').map(tactic => tactic.text)].join('\n\n'))
    const first = files.loader.load()
    writeFileSync(join(files.directory, 'compile.md'), '新版生成说明')
    writeFileSync(join(files.directory, 'repair.md'), '错误模板 {{typo}}')
    const warnings: string[] = []
    assert.equal(files.loader.load({ onFallback: error => warnings.push(error.message) }), first)
    assert.match(warnings[0]!, /repair\.md.*typo/)
    assert.throws(() => readPrompts(files.url), /repair\.md.*typo/)
    assert.throws(() => new PromptLoader(files.url).load(), /repair\.md.*typo/)
    writeFileSync(join(files.directory, 'repair.md'), markdown('repair.md'))
    const next = files.loader.load()
    assert.notEqual(next.version, first.version)
    assert.equal(next.render('compile'), '新版生成说明')
    assert.equal(first.render('compile'), markdown('compile.md'))
    assert.equal(files.loader.load(), next)
    const ability = join(files.directory, '../capabilities/formation.assign.md')
    const original = readFileSync(ability, 'utf8')
    writeFileSync(ability, original + '\n额外的编队说明。\n')
    const changed = files.loader.load()
    assert.notEqual(changed.version, next.version)
    assert.ok(changed.render('interpret').includes('额外的编队说明。'))
    assert.ok(!next.render('interpret').includes('额外的编队说明。'))
    writeFileSync(ability, original.replace('"allowAll": true', '"allowAll": false'))
    assert.equal(files.loader.load({ onFallback: error => warnings.push(error.message) }), changed)
    assert.match(warnings.at(-1)!, /能力定义错误|capabilities:generate/)
  } finally { process.chdir(previousCwd); files.dispose() }
})

test('脚本生成、修复与校验重试实际使用 Markdown，并记录同一提示版本', async () => {
  const prompts = loadPrompts()
  const requests: Array<Array<{ role: string; content: string }>> = []
  const versions: string[] = []
  const provider = { generate: async (input: { messages: Array<{ role: string; content: string }> }) => {
    requests.push(structuredClone(input.messages))
    return { text: requests.length === 1 ? '没有代码' : 'function step(s,m){return {actions:[],memory:m}}', model: 'fixture', durationMs: 0 }
  } }
  const compiled = await compileCommand(provider as never, {
    snapshot: snapshot({ control: { owner: { kind: 'global' }, goals: [], formations: [] } }),
    constraints: { allowedUnitIds: [1], enemyIds: [99], mapWidth: 100, mapHeight: 100 },
    diagnostic: { code: '旧代码', error: '模拟运行故障' },
  }, { run: async () => outcome() }, { prompts, maxAttempts: 2, onPromptVersion: version => versions.push(version) })
  assert.equal(requests.length, 2)
  assert.equal(requests[0]![0]!.content, prompts.compileFor([], true))
  assert.equal(requests[0]![3]!.content, markdown('repair.md').replace('{{error}}', '模拟运行故障'))
  assert.equal(requests[1]!.at(-1)!.content, markdown('validation-feedback.md').replace('{{errors}}', '没有可用的 function step 或 js 代码块'))
  assert.equal(compiled.promptVersion, prompts.version)
  assert.deepEqual(versions, [prompts.version, prompts.version])
  assert.ok(compiled.log.every(attempt => attempt.promptVersion === prompts.version))
})

test('终端生成跨异步准备和重新绑定固定提示，下一条命令与修复用新版本并保存来源', async () => {
  const files = fixture()
  try {
    const initial = files.loader.load()
    const requests: Array<Array<{ role: string; content: string }>> = []
    const provider = { generate: async (input: { messages: Array<{ role: string; content: string }> }) => {
      requests.push(structuredClone(input.messages))
      if (requests.length === 1) {
        writeFileSync(join(files.directory, 'compile.md'), '下一条命令使用的说明')
        return { text: '没有代码', model: 'fixture', durationMs: 0 }
      }
      return { text: code, model: 'fixture', durationMs: 0 }
    } }
    const executor = { run: async () => outcome() }
    const { runtime, formations } = await harness(executor)
    let preparations = 0
    const controller = new ProgramController({ runtime, executor, provider: () => provider as never, prompts: files.loader,
      prepare: async goals => {
        if (++preparations === 1) {
          writeFileSync(join(files.directory, 'compile.md'), '准备阶段改过的说明')
          formations.create('B', [2]) // 使首次编译上下文失效，触发重新绑定。
        }
        return goals
      } })
    await controller.submit(production())
    assert.equal(preparations, 2)
    assert.deepEqual(requests.map(messages => messages[0]!.content), [initial.compileFor([production()]), initial.compileFor([production()], true)])
    assert.equal(runtime.programs.get('global')!.script!.promptVersion, initial.version)

    await controller.refresh('global')
    const next = files.loader.load()
    assert.ok(requests[2]![0]!.content.startsWith('下一条命令使用的说明'))
    assert.equal(runtime.programs.get('global')!.script!.promptVersion, next.version)
    writeFileSync(join(files.directory, 'repair.md'), '新版故障修复：{{error}}')
    runtime.pause('global')
    await controller.refresh('global', true)
    assert.equal(requests[3]![3]!.content, '新版故障修复：脚本故障')
    const repaired = files.loader.load()
    assert.equal(runtime.programs.get('global')!.script!.promptVersion, repaired.version)
    const restored = await harness(executor, { formations: new FormationRegistry() })
    restoreState(restored.runtime, JSON.parse(JSON.stringify(persistState(runtime))))
    assert.equal(restored.runtime.programs.get('global')!.script!.promptVersion, repaired.version)
  } finally { files.dispose() }
})
