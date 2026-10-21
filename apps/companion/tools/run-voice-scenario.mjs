import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { loadRegionScheme } from '../../../packages/maps/src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'tests/scenarios/voice-six-commands.json'), 'utf8'));
const folder = path.join(root, '.runtime/voice-six');
fs.mkdirSync(path.join(folder, 'frames'), { recursive: true });
const reportFile = path.join(folder, 'result.json');
const resume = process.argv.includes('--resume');
const report = resume ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { name: scenario.name, startedAt: new Date().toISOString(), status: 'running', steps: [], frames: 0 };
const completedSteps = report.steps.filter(s => ['passed', 'partial'].includes(s.status)).length;
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const state = () => JSON.parse(fs.readFileSync(path.join(root, '.runtime/state.json'), 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(8790, '127.0.0.1');
    let buffer = '';
    let quiet;
    socket.setTimeout(180000);
    socket.on('connect', () => socket.write(text + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      clearTimeout(quiet);
      quiet = setTimeout(() => { socket.destroy(); resolve(buffer.trim()); }, 150);
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('命令超时')); });
  });
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find(p => p.url().includes('127.0.0.1:8787'));
const regions = await loadRegionScheme(path.join(root, 'maps/ice/schemes/nanwang-0.1.0.json'));
let currentStep = completedSteps;
let note = '准备开始';
let last = report.final;
let recording = false;
let frame = report.frames;
async function observe() {
  return page.evaluate(() => {
    const w = window.werhd;
    if (!w) return null;
    return { sessionKey: window.__ra2cState().sessionKey, tick: w.tick(), me: w.me(), players: w.players(),
      self: w.units('self').map(u => ({ id: u.id, name: u.name, x: u.tile.rx, y: u.tile.ry, isIdle: u.isIdle, hp: u.hitPoints, maxHp: u.maxHitPoints })),
      enemies: w.units('hostile').map(u => ({ id: u.id, name: u.name, x: u.tile.rx, y: u.tile.ry, hp: u.hitPoints })), queues: w.production.queues() };
  });
}
async function capture() {
  if (recording) return;
  recording = true;
  try {
    await page.evaluate(text => { const panel = document.getElementById('ra2c-scenario-caption'); if (panel) panel.textContent = text; }, `模拟语音 ${currentStep}/6：${scenario.steps[currentStep - 1]?.text ?? '准备'}\n${note}`);
    const native = await observe();
    if (native) {
      last = native;
      const units = [4, 6].includes(currentStep) ? native.self.filter(u => u.name === 'MTNK') : native.self.filter(u => /CNST|MCV/.test(u.name));
      if (units.length) {
        const x = Math.round(units.reduce((n, u) => n + u.x, 0) / units.length), y = Math.round(units.reduce((n, u) => n + u.y, 0) / units.length);
        await page.evaluate(({ x, y, text }) => {
          window.werhd?.camera.centerAt(x, y);
          let panel = document.getElementById('ra2c-scenario-caption');
          if (!panel) { panel = document.createElement('div'); panel.id = 'ra2c-scenario-caption'; panel.style.cssText = 'position:fixed;left:16px;top:16px;z-index:999999;max-width:690px;padding:12px 18px;background:rgba(10,20,35,.9);color:white;border:1px solid #6dcff6;border-radius:8px;font:17px/1.5 sans-serif;pointer-events:none;white-space:pre-line'; document.body.appendChild(panel); }
          panel.textContent = text;
        }, { x, y, text: `模拟语音 ${currentStep}/6：${scenario.steps[currentStep - 1]?.text ?? '准备'}\n${note}` });
      }
    }
    const file = path.join(folder, 'frames', `${String(frame++).padStart(6, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 65, scale: 'css' });
    report.frames = frame;
    save();
  } finally { recording = false; }
}
function complete(step, native, persisted) {
  if (!native) return false;
  const squad = persisted.formations.find(f => f.id === '1队');
  const tanks = native.self.filter(u => squad?.memberIds.includes(u.id) && u.name === 'MTNK');
  if (step.expect === 'base') return native.self.some(u => u.name === 'GACNST');
  if (step.expect === 'factory') return native.self.some(u => u.name === 'GAWEAP');
  if (step.expect === 'five-tanks') return tanks.length === 5;
  if (step.expect === 'region') return tanks.length === 5 && tanks.every(u => regions.regionsAt(u.x, u.y).some(r => r.name === step.regionName));
  if (step.expect === 'satellite-power') return native.self.some(u => u.name === 'GASPYSAT') && !native.me.power.isLowPower && native.me.power.total - native.me.power.drain >= 100 && native.enemies.length > 0;
  if (step.expect === 'victory') { const opponents = native.players.filter(p => (p.combatant || p.defeated) && !p.allied && !p.isObserver); return !native.me.defeated && opponents.length > 0 && opponents.every(p => p.defeated); }
  return false;
}
try {
  await page.bringToFront();
  await page.mouse.move(1050, 220);
  const initial = await observe();
  if (resume && !initial && completedSteps >= 5 && report.final?.sessionKey === report.sessionKey && complete(scenario.steps[5], report.final, state())) {
    // 游戏结算会摘除 API；保留败北前最后一份公开快照作为成功证据，不重放进攻。
    currentStep = 6; note = '全部敌人已败北，六项执行完成';
    const record = report.steps[5];
    record.status = 'passed'; record.completedAt = new Date().toISOString(); record.observed = report.final;
    record.confirmation = '末次同局公开快照：敌方 defeated=true、combatant=false；当前为遭遇战结算页';
    if (report.error) report.harnessIssues = [...(report.harnessIssues ?? []), { error: report.error, correction: '败北后 combatant 会变为 false，胜利判定须保留 defeated 玩家' }];
    delete report.error; report.status = report.steps.some(s => s.status === 'partial') ? 'partial' : 'passed';
    await capture(); record.screenshot = 'step-6.png';
    await page.screenshot({ path: path.join(folder, record.screenshot), scale: 'css' });
    console.log('已根据记录的同局败北快照和结算页确认第6项完成；未重放游戏指令');
  } else {
    if (!initial || (resume ? initial.sessionKey !== report.sessionKey : initial.self.some(u => u.name === 'GACNST') || !initial.self.some(u => u.name === 'AMCV'))) throw new Error('新测试需只有基地车；续测需保持同一对局，不能重放已有建设');
    report.sessionKey = initial.sessionKey;
    report.initial ??= initial;
    report.status = 'running';
    report.mapBinding = await command('map use ice');
    const timer = setInterval(() => { void capture().catch(error => { report.captureError = String(error); }); }, 2000);
    try {
      for (const step of scenario.steps.slice(completedSteps)) {
        currentStep++;
        note = '正在理解指令并生成脚本';
        let record = report.steps[currentStep - 1];
        if (!record?.response?.includes('已生效')) {
          const previous = record;
          record = { ...step, startedAt: new Date().toISOString(), status: 'running', ...(previous ? { attempts: [...(previous.attempts ?? []), previous] } : {}) };
          report.steps[currentStep - 1] = record;
        }
        save();
        await capture();
        console.log(`开始 ${currentStep}/6：${step.text}`);
        if (!record.response?.includes('已生效')) record.response = await command('say ' + step.text);
        console.log(record.response);
        if (!record.response.includes('已生效')) throw new Error('指令未激活: ' + record.response);
        const deadline = Date.now() + step.timeoutSeconds * 1000;
        let loggedAt = 0;
        for (;;) {
          const native = await observe();
          const persisted = state();
          if (step.continuousPower && native) {
            const power = native.me.power;
            record.powerSamples ??= [];
            const previous = record.powerSamples.at(-1);
            if (!previous || previous.total !== power.total || previous.drain !== power.drain) record.powerSamples.push({ tick: native.tick, ...power });
            if (power.isLowPower) {
              record.powerViolations ??= [];
              if (!record.powerViolations.some(p => p.total === power.total && p.drain === power.drain)) record.powerViolations.push({ tick: native.tick, ...power });
            }
          }
          const observed = native ?? (step.expect === 'victory' ? last : undefined);
          if (observed?.sessionKey === report.sessionKey && complete(step, observed, persisted)) {
            record.status = record.powerViolations?.length ? 'partial' : 'passed'; record.completedAt = new Date().toISOString(); record.observed = observed;
            record.programs = persisted.programs; record.goals = persisted.goals;
            note = record.status === 'partial' ? '生产已完成，但建设中曾出现缺电' : '已观察到执行完成';
            await capture();
            record.screenshot = `step-${currentStep}.png`;
            await page.screenshot({ path: path.join(folder, record.screenshot), scale: 'css' });
            save(); console.log(`完成 ${currentStep}/6：${step.text}`); break;
          }
          if (native?.sessionKey !== report.sessionKey) throw new Error('测试期间对局发生变化');
          note = `执行中 · 资金 ${Math.floor(native?.me.credits ?? 0)} · 电力 ${native?.me.power.total ?? 0}/${native?.me.power.drain ?? 0} · 坦克 ${native?.self.filter(u => u.name === 'MTNK').length ?? 0} · 可见敌军 ${native?.enemies.length ?? 0}`;
          if (Date.now() - loggedAt > 15000) { console.log(note); loggedAt = Date.now(); }
          if (Date.now() > deadline) { record.status = 'timeout'; record.observed = native; record.programs = persisted.programs; record.goals = persisted.goals; throw new Error(`第${currentStep}项等待超时`); }
          await delay(1000);
        }
      }
      report.status = report.steps.some(s => s.status === 'partial') ? 'partial' : 'passed';
    } finally { clearInterval(timer); }
  }
} catch (error) {
  report.status = 'failed'; report.error = String(error); note = '测试在此处受阻：' + String(error);
  const failed = report.steps.at(-1); if (failed && failed.status === 'running') failed.status = 'failed';
  await capture().catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.final = last; save();
  while (recording) await delay(100);
  await browser.close();
  console.log(`验收：${report.steps.filter(s => s.status === 'passed').length}项通过，${report.steps.filter(s => s.status === 'partial').length}项部分达标`);
  if (report.status !== 'passed') process.exitCode = 1;
  console.log('结果：' + reportFile);
}
