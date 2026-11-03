import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, lstatSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

async function contents(root, relative = '', result = new Map()) {
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name), file = join(root, path), stat = lstatSync(file)
    if (stat.isSymbolicLink()) result.set(path, `link:${readlinkSync(file)}`)
    else if (stat.isDirectory()) await contents(root, path, result)
    else {
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(file)) hash.update(bytes)
      result.set(path, hash.digest('hex'))
    }
  }
  return result
}
const expected = await contents(process.argv[2])
for (const root of process.argv.slice(3)) {
  const actual = await contents(root)
  for (const [path, hash] of expected) assert.equal(actual.get(path), hash, `归档丢失或改写文件：${root}/${path}`)
}
console.log(`[package] ${process.argv.length - 3} 个归档均保留已检查程序的 ${expected.size} 个文件和链接`)
