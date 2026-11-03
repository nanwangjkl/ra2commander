import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { defaultGameResourcesDir, prepareGameResources, verifyGameResources, type GameResourceCatalog } from '../packages/game-werhd/src/resource-assets.ts'
import { localGameResources } from '../apps/companion/src/game-resources.ts'
import { startStaticServer } from '../apps/companion/src/static-server.ts'

const catalog: GameResourceCatalog = { schemaVersion: 1, id: 'fixture', sources: ['https://primary.invalid/', 'https://mirror.invalid/'],
  manifest: { version: 2, format: 'mix', checksums: { 'glsl.png': 0x3610a686, 'ra2ts_l.mp4': 0xcbf43926 } } }
const download: typeof fetch = async input => new Response(new URL(String(input)).pathname.endsWith('glsl.png') ? 'hello' : '123456789')

test('游戏资源逐文件校验、失败换源、原子发布并离线复用；损坏目录不覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-game-assets-'))
  let calls = 0
  try {
    const prepared = await prepareGameResources(root, { catalog, download: async (input, init) => {
      calls++
      return String(input).includes('primary.invalid') ? new Response('corrupt') : download(input, init)
    } })
    assert.equal(prepared.bytes, 14)
    assert.equal(calls, 4)
    assert.deepEqual(JSON.parse(readFileSync(join(prepared.folder, 'manifest.json'), 'utf8')), catalog.manifest)
    await prepareGameResources(root, { catalog, download: async () => { throw new Error('不应联网') } })
    writeFileSync(join(prepared.folder, 'glsl.png'), 'broken')
    await assert.rejects(verifyGameResources(prepared.folder, catalog), /校验失败.*glsl.png/)
    await assert.rejects(prepareGameResources(root, { catalog, download }), /校验失败/)
    assert.equal(readFileSync(join(prepared.folder, 'glsl.png'), 'utf8'), 'broken')
    const failedRoot = join(root, 'failed')
    await assert.rejects(prepareGameResources(failedRoot, { catalog, download: async () => new Response('bad') }), /准备失败/)
    assert.equal(existsSync(defaultGameResourcesDir(failedRoot, catalog)), false)
    assert.deepEqual(readdirSync(join(failedRoot, 'resources/game')), [])
    const pinned = { ...catalog, pinnedFiles: { 'glsl.png': { bytes: 5, sha256: createHash('sha256').update('hello').digest('hex') } } }
    const pinRoot = join(root, 'pinned')
    const pinResult = await prepareGameResources(pinRoot, { catalog: pinned, download })
    await verifyGameResources(pinResult.folder, pinned)
    await assert.rejects(verifyGameResources(pinResult.folder, { ...pinned, pinnedFiles: { 'glsl.png': { bytes: 5, sha256: '0'.repeat(64) } } }), /校验失败/)
    const unsafe = { ...catalog, manifest: { ...catalog.manifest, checksums: { '../outside.mix': 1 } } }
    await assert.rejects(prepareGameResources(root, { catalog: unsafe, download }), /路径或校验值无效/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('完整本机资源接入自动加载，保持原配置文件和其他设置；视频支持范围读取', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ra2c-local-game-')), game = join(root, 'site')
  mkdirSync(game)
  const config = { autoLoadGameRes: false, gameresBaseUrl: 'https://remote.invalid/', gameresBaseUrls: ['https://mirror.invalid/'],
    forcedModId: 'gonghui', mapsBaseUrl: 'https://maps.invalid/', p2pCdnEnabled: true }
  writeFileSync(join(game, 'config.json'), JSON.stringify(config))
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined
  try {
    assert.equal(await localGameResources(root, game, { catalog }), undefined)
    await assert.rejects(localGameResources(root, game, { required: true, catalog }), /game:resources:install/)
    const prepared = await prepareGameResources(root, { catalog, download })
    const local = (await localGameResources(root, game, { required: true, catalog }))!
    let origin = ''
    assert.equal(local.files, 2)
    server = await startStaticServer({ root: game, port: 0, extraFiles: local.filePaths, handleRequest: (req, res) => local.handleRequest(req, res, origin) })
    origin = server.url
    const response = await fetch(new URL('config.json?v=test', origin)), current = await response.json() as typeof config
    assert.equal(current.autoLoadGameRes, true)
    assert.equal(new URL(current.gameresBaseUrl).origin, new URL(origin).origin)
    assert.deepEqual(current.gameresBaseUrls, [])
    assert.equal(current.p2pCdnEnabled, false)
    assert.equal(current.forcedModId, config.forcedModId)
    assert.equal(current.mapsBaseUrl, config.mapsBaseUrl)
    assert.deepEqual(JSON.parse(readFileSync(join(game, 'config.json'), 'utf8')), config)
    const manifest = await (await fetch(new URL('manifest.json', current.gameresBaseUrl))).json()
    assert.deepEqual(manifest, catalog.manifest)
    const video = new URL('ra2ts_l.mp4?v=crc', current.gameresBaseUrl)
    const part = await fetch(video, { headers: { range: 'bytes=2-5' } })
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-type'), 'video/mp4')
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/9'); assert.equal(await part.text(), '3456')
    assert.equal(await (await fetch(video, { headers: { range: 'bytes=-3' } })).text(), '789')
    assert.equal((await fetch(video, { headers: { range: 'bytes=99-' } })).status, 416)
    const head = await fetch(video, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '9'); assert.equal(await head.text(), '')
    assert.equal((await fetch(new URL('config.json', origin), { method: 'POST' })).status, 405)
    rmSync(join(prepared.folder, 'glsl.png'))
    await assert.rejects(localGameResources(root, game, { required: true, catalog }), /资源缺失或不可读/)
  } finally { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); rmSync(root, { recursive: true, force: true }) }
})
