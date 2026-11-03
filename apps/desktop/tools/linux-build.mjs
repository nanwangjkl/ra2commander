import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url)), output = join(root, 'dist')
mkdirSync(output, { recursive: true })
function run(args) { const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status || 1) }
run(['build', '--platform', 'linux/amd64', '-t', 'ra2commander-linux-builder', '-f', 'apps/desktop/tools/Dockerfile', 'apps/desktop/tools'])
run(['run', '--rm', '--platform', 'linux/amd64', '--init',
  '-v', `${root}:/source:ro`, '-v', `${output}:/output`, '-v', 'ra2commander-build-cache:/cache',
  'ra2commander-linux-builder', 'bash', '/usr/local/bin/build-ra2commander'])
