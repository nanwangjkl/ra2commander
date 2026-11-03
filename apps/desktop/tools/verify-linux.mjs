import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const result = spawnSync('docker', ['run', '--rm', '--init', '--platform', 'linux/amd64',
  '-e', `RA2C_VERIFY_VERSION=${version}`,
  '-v', `${root}:/source:ro`, '-v', `${join(root, 'dist')}:/artifacts:ro`,
  'ra2commander-linux-builder', 'bash', '/source/apps/desktop/tools/verify-linux.sh'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
