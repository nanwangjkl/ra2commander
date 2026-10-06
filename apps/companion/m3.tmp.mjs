import net from 'node:net'
const send = (cmd, t = 30000) => new Promise((res) => {
  const c = net.connect(8790, '127.0.0.1', () => c.write(cmd + '\n'))
  let buf = ''
  c.on('data', (d) => { buf += d.toString() })
  c.on('close', () => res(buf))
  setTimeout(() => { c.end(); res(buf) }, t)
})
const units = await send('units 40')
console.log(units.split('\n').filter(l => /GACNST|GAPOWR|GAREFN|GAWEAP|MTNK|共/.test(l)).join('\n'))
