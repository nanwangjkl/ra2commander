import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const [app, zip] = process.argv.slice(2).map(path => resolve(path))
const temporary = mkdtempSync(join(tmpdir(), 'ra2c archives ')), extracted = join(temporary, 'zip')
try {
  mkdirSync(extracted)
  execFileSync('ditto', ['-x', '-k', zip, extracted])
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'check-archives.mjs'), app, join(extracted, 'ra2commander.app')], { stdio: 'inherit' })
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
