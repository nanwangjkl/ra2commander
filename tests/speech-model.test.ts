import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultSpeechModelDir, legacySpeechModelDir, prepareSpeechModel, resolveSpeechModelDir, SPEECH_MODEL_MANIFEST, verifySpeechModel } from '../packages/speech/src/index.ts'
import { SpeechSettings } from '../apps/companion/src/speech-settings.ts'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture(root: string) {
  const manifest = structuredClone(SPEECH_MODEL_MANIFEST), source = join(root, 'source'), folder = join(source, manifest.archive.directory)
  for (const file of manifest.files) {
    const bytes = Buffer.from(`fixture-${file.role}`)
    mkdirSync(dirname(join(folder, file.path)), { recursive: true }); writeFileSync(join(folder, file.path), bytes)
    file.bytes = bytes.length; file.sha256 = sha(bytes)
  }
  const archive = join(root, 'fixture.tar.bz2')
  execFileSync('tar', ['-cjf', archive, '-C', source, manifest.archive.directory])
  const bytes = readFileSync(archive)
  manifest.archive.bytes = bytes.length; manifest.archive.sha256 = sha(bytes)
  return { manifest, folder, bytes }
}

test('模型按清单校验并原子准备，重复使用和缓存重建不联网，错误下载或损坏资源不交付', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-model-assets-'))
  try {
    const f = fixture(root), project = join(root, 'project'); let downloads = 0
    const options = { manifest: f.manifest, download: async () => { downloads++; return new Response(new Uint8Array(f.bytes)) } }
    await prepareSpeechModel(project, options)
    const target = defaultSpeechModelDir(project)
    assert.equal((await verifySpeechModel(target, f.manifest)).files, f.manifest.files.length)
    await prepareSpeechModel(project, options); assert.equal(downloads, 1)
    rmSync(target, { recursive: true }); await prepareSpeechModel(project, options)
    assert.equal(downloads, 1, '目录重建复用校验通过的压缩缓存，不重新下载')
    rmSync(join(target, 'LICENSE'))
    await assert.rejects(verifySpeechModel(target, f.manifest), /LICENSE/)
    await assert.rejects(prepareSpeechModel(project, options), /LICENSE/)
    assert.equal(downloads, 1, '已有异常目录保留给开发者检查，不盲目覆盖')
    const bad = Buffer.from(f.bytes); bad[0] = bad[0]! ^ 1
    const failed = join(root, 'failed')
    await assert.rejects(prepareSpeechModel(failed, { manifest: f.manifest, download: async () => new Response(new Uint8Array(bad)) }), /校验失败/)
    assert.equal(existsSync(defaultSpeechModelDir(failed)), false)
    assert.deepEqual(readdirSync(join(failed, '.runtime/speech/downloads')), [], '失败下载清理临时文件')
    const mismatch = structuredClone(f.manifest); mismatch.files[0]!.sha256 = '0'.repeat(64)
    const incomplete = join(root, 'incomplete')
    await assert.rejects(prepareSpeechModel(incomplete, { manifest: mismatch, download: options.download }), /校验失败/)
    assert.equal(existsSync(defaultSpeechModelDir(incomplete)), false, '解包后的资源也必须通过文件校验')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('旧默认模型经校验迁入资源目录，旧设置继续可读，自选路径保持选择', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-model-migration-'))
  try {
    const f = fixture(root), project = join(root, 'project'), legacy = legacySpeechModelDir(project), target = defaultSpeechModelDir(project)
    mkdirSync(dirname(legacy), { recursive: true }); cpSync(f.folder, legacy, { recursive: true })
    assert.equal(resolveSpeechModelDir(project), legacy)
    const before = new SpeechSettings(project, {})
    try { before.save({ ...before.view(), key: 'F8', deviceId: 'saved-mic' }) } finally { before.close() }
    const migrated = await prepareSpeechModel(project, { manifest: f.manifest, download: async () => { throw new Error('不应下载') } })
    assert.equal(migrated.source, 'migrated'); assert.equal(existsSync(legacy), false)
    assert.equal(resolveSpeechModelDir(project), target); assert.equal(resolveSpeechModelDir(project, legacy), target)
    const restored = new SpeechSettings(project, {})
    try {
      assert.equal(restored.view().modelDir, target); assert.equal(restored.view().key, 'F8'); assert.equal(restored.view().deviceId, 'saved-mic')
    } finally { restored.close() }
    const custom = join(root, 'my-model')
    assert.equal(resolveSpeechModelDir(project, custom), custom)
    const overridden = new SpeechSettings(project, { RA2C_SPEECH_MODEL_DIR: custom })
    try { assert.equal(overridden.view().modelDir, custom, '开发者环境变量可覆盖内置模型，设备和按键设置不携带路径') } finally { overridden.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
