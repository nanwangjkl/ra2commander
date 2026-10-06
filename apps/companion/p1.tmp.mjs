import net from 'node:net'
const send = (cmd, t = 30000) => new Promise((res) => {
  const c = net.connect(8790, '127.0.0.1', () => c.write(cmd + '\n'))
  let buf = ''
  c.on('data', (d) => { buf += d.toString() })
  c.on('close', () => res(buf))
  setTimeout(() => { c.end(); res(buf) }, t)
})
console.log('produce:', (await send(`eval window.werhd.produce('MTNK', 1)`)).trim())
for (const wait of [3000, 5000, 10000]) {
  await new Promise(r => setTimeout(r, wait === 3000 ? 3000 : wait === 5000 ? 2000 : 5000))
  const q = await send(`eval window.werhd.production.queues().filter(x => x.items.length || x.status !== 0).map(x => "type" + x.type + "[" + x.status + "]:" + x.items.map(i => i.name + "x" + i.quantity + "@" + Math.floor(i.progress * 100) + "%"))`)
  console.log(`${wait / 1000}秒:`, JSON.parse(q).value ?? q)
}
