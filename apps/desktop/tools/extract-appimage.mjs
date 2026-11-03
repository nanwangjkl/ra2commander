import assert from 'node:assert/strict'
import { openSync, readSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Type 2 AppImage 的 SquashFS 位于 ELF 末尾。直接解包也支持 ARM 主机上的 x64 构建检查。
// 不修改发行文件，不依赖 FUSE，也不执行被检查的 AppImage 外壳。
const [file, destination] = process.argv.slice(2)
const descriptor = openSync(file, 'r'), header = Buffer.alloc(64), magic = Buffer.alloc(4)
let offset
try {
  assert.equal(readSync(descriptor, header, 0, 64, 0), 64)
  assert.equal(header.subarray(0, 4).toString(), '\x7fELF')
  assert.equal(header[4], 2); assert.equal(header[5], 1); assert.equal(header.readUInt16LE(18), 62)
  assert.deepEqual([...header.subarray(8, 11)], [65, 73, 2])
  offset = Number(header.readBigUInt64LE(40)) + header.readUInt16LE(58) * header.readUInt16LE(60)
  assert.ok(Number.isSafeInteger(offset) && offset > 64)
  readSync(descriptor, magic, 0, 4, offset); assert.equal(magic.toString(), 'hsqs')
} finally { closeSync(descriptor) }
execFileSync('unsquashfs', ['-no-progress', '-d', destination, '-o', String(offset), file], { stdio: 'inherit' })
