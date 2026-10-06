import net from 'node:net'
const send = (cmd, t = 30000) => new Promise((res) => {
  const c = net.connect(8790, '127.0.0.1', () => c.write(cmd + '\n'))
  let buf = ''
  c.on('data', (d) => { buf += d.toString() })
  c.on('close', () => res(buf))
  setTimeout(() => { c.end(); res(buf) }, t)
})
const n = JSON.parse(await send(`eval window.werhd.units("self").filter(u => u.name === "MTNK").map(u => u.id + "@(" + u.tile.rx + "," + u.tile.ry + ")"`))
console.log('场上灰熊:', n.value)
