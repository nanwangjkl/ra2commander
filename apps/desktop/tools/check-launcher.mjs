import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const folder = mkdtempSync(join(tmpdir(), 'ra2c-launcher-'))
const source = fileURLToPath(new URL('../linux/launcher.c', import.meta.url))
try {
  writeFileSync(join(folder, 'overlay.c'), '#include <unistd.h>\n__attribute__((constructor)) static void fail(void){_exit(86);}\n')
  writeFileSync(join(folder, 'keep.c'), 'void ra2c_kept_preload(void){}\n')
  writeFileSync(join(folder, 'probe.c'), '#include <stdio.h>\n#include <stdlib.h>\nint main(int argc,char **argv){printf("preload=%s\\nsteam=%s\\n",getenv("LD_PRELOAD")?getenv("LD_PRELOAD"):"",getenv("SteamAppId")?getenv("SteamAppId"):"");for(int i=1;i<argc;i++)printf("arg=%s\\n",argv[i]);return 0;}\n')
  const overlay = join(folder, 'gameoverlayrenderer.so'), overlay64 = join(folder, 'gameoverlayrenderer64.so'), kept = join(folder, 'other-overlay.so')
  execFileSync('cc', ['-shared', '-fPIC', join(folder, 'overlay.c'), '-o', overlay]); copyFileSync(overlay, overlay64)
  execFileSync('cc', ['-shared', '-fPIC', join(folder, 'keep.c'), '-o', kept])
  const entry = join(folder, 'ra2commander'), binary = `${entry}.bin`
  execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-static', source, '-o', entry])
  execFileSync('cc', [join(folder, 'probe.c'), '-o', binary])
  const env = { ...process.env, LD_PRELOAD: `${overlay} ${kept}:${overlay64}`, SteamAppId: 'retained-steam-id' }
  assert.equal(spawnSync(binary, [], { env }).status, 86, '模拟库应在动态程序入口执行前导致失败')
  const clean = spawnSync(entry, ['argument with spaces', '--original-option'], { env, encoding: 'utf8' })
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(clean.stdout, `preload=${kept}\nsteam=retained-steam-id\narg=argument with spaces\narg=--original-option\n`)
  assert.match(clean.stderr, /2 项/)
  const onlyOverlay = spawnSync(entry, [], { env: { ...env, LD_PRELOAD: overlay }, encoding: 'utf8' })
  assert.equal(onlyOverlay.status, 0); assert.match(onlyOverlay.stdout, /^preload=\n/)
  const unchanged = spawnSync(entry, [], { env: { ...env, LD_PRELOAD: `:${kept}  ` }, encoding: 'utf8' })
  assert.equal(unchanged.status, 0); assert.equal(unchanged.stdout, `preload=:${kept}  \nsteam=retained-steam-id\n`)
  console.log('[launcher] 覆盖层入口前失败已复现；静态入口排除故障库，其他预加载、Steam 标识和原始参数保留')
} finally { rmSync(folder, { recursive: true, force: true }) }
