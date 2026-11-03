import { parentPort, workerData } from 'node:worker_threads'

try {
  const { exportBattleZip } = process.env.RA2C_PACKAGED === '1'
    ? await import('./battle-zip.js')
    : await (await import('tsx/esm/api')).tsImport('./battle-zip.ts', import.meta.url)
  const result = await exportBattleZip(workerData.root, workerData.id, workerData.output)
  parentPort.postMessage({ ok: true, result })
} catch (error) { parentPort.postMessage({ ok: false, error: String(error) }) }
