import { parentPort, workerData } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

try {
  const { exportBattleZip } = await tsImport('./battle-zip.ts', import.meta.url)
  const result = await exportBattleZip(workerData.root, workerData.id, workerData.output)
  parentPort.postMessage({ ok: true, result })
} catch (error) { parentPort.postMessage({ ok: false, error: String(error) }) }
