import net from 'node:net'
const send = (cmd, t = 30000) => new Promise((res) => {
  const c = net.connect(8790, '127.0.0.1', () => c.write(cmd + '\n'))
  let buf = ''
  c.on('data', (d) => { buf += d.toString() })
  c.on('close', () => res(buf))
  setTimeout(() => { c.end(); res(buf) }, t)
})
const jq = async () => JSON.parse(await send(`eval window.werhd.production.queues().filter(x => x.items.length || x.status !== 0).map(x => "type" + x.type + "[" + x.status + "]:" + x.items.map(i => i.name + "x" + i.quantity))`)).value
// 同时下单：建筑 GAPILL（Armory）与车辆 MTNK（Vehicles）
console.log('GAPILL:', (await send(`eval window.werhd.produce('GAPILL', 1)`)).trim())
console.log('MTNK:', (await send(`eval window.werhd.produce('MTNK', 1)`)).trim())
for (const s of [3, 10, 30, 60, 90]) {
  await new Promise(r => setTimeout(r, s === 3 ? 3000 : s === 10 ? 7000 : s === 30 ? 20000 : s === 60 ? 30000 : 30000))
  console.log(`${s}秒:`, await jq())
}
