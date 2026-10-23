import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { loadRegionScheme } from '../../../packages/maps/src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'tests/scenarios/voice-six-commands.json'), 'utf8'));
const folder = path.join(root, '.runtime/voice-six');
fs.mkdirSync(folder, { recursive: true });
const progressFile = path.join(folder, 'progress.json');
const resume = process.argv.includes('--resume');
// 旧版记录仅用于迁移续测进度，避免重放已生效的生产指令。
const previous = resume ? JSON.parse(fs.readFileSync(fs.existsSync(progressFile) ? progressFile : path.join(folder, 'result.json'), 'utf8')) : {};
function battleStatus(native) {
  if (!native) return undefined;
  return { sessionKey: native.sessionKey, me: { defeated: native.me.defeated },
    players: native.players.map(({ combatant, defeated, allied, isObserver }) => ({ combatant, defeated, allied, isObserver })) };
}
const progress = { sessionKey: previous.sessionKey,
  steps: (previous.steps ?? []).map(step => ({ text: step.text, status: step.status, response: step.response,
    sawLowPower: step.sawLowPower || Boolean(step.powerViolations?.length) })),
  lastBattleStatus: battleStatus(previous.lastBattleStatus ?? previous.final) };
let completedSteps = 0;
while (['passed', 'partial'].includes(progress.steps[completedSteps]?.status)) completedSteps++;
const save = () => fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
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
const game = page.frame({ name: 'ra2c-game' }) ?? page.mainFrame();
const regions = await loadRegionScheme(path.join(root, 'maps/ice/schemes/nanwang-0.1.0.json'));
let currentStep = completedSteps;
async function observe() {
  return game.evaluate(() => {
    const w = window.werhd;
    if (!w) return null;
    return { sessionKey: window.__ra2cState().sessionKey, me: w.me(), players: w.players(),
      self: w.units('self').map(u => ({ id: u.id, name: u.name, x: u.tile.rx, y: u.tile.ry })),
      enemyCount: w.units('hostile').length };
  });
}
function victory(native) {
  if (!native) return false;
  const opponents = native.players.filter(p => (p.combatant || p.defeated) && !p.allied && !p.isObserver);
  return !native.me.defeated && opponents.length > 0 && opponents.every(p => p.defeated);
}
function complete(step, native, persisted) {
  if (step.expect === 'victory') return victory(native);
  if (!native) return false;
  const squad = persisted.formations.find(f => f.id === '1队');
  const tanks = native.self.filter(u => squad?.memberIds.includes(u.id) && u.name === 'MTNK');
  if (step.expect === 'base') return native.self.some(u => u.name === 'GACNST');
  if (step.expect === 'factory') return native.self.some(u => u.name === 'GAWEAP');
  if (step.expect === 'five-tanks') return tanks.length === 5;
  if (step.expect === 'region') return tanks.length === 5 && tanks.every(u => regions.regionsAt(u.x, u.y).some(r => r.name === step.regionName));
  if (step.expect === 'satellite-power') return native.self.some(u => u.name === 'GASPYSAT') && !native.me.power.isLowPower && native.me.power.total - native.me.power.drain >= 100 && native.enemyCount > 0;
  return false;
}
try {
  const initial = await observe();
  if (resume && !initial && completedSteps >= 5 && progress.lastBattleStatus?.sessionKey === progress.sessionKey && victory(progress.lastBattleStatus)) {
    // 游戏结算会摘除 API；使用此前已读到的同局败北状态，不重放进攻。
    progress.steps[5] = { ...progress.steps[5], text: scenario.steps[5].text, status: 'passed' };
    console.log('已根据同局敌方败北状态确认第6项完成；未重放游戏指令');
  } else {
    if (!initial || (resume ? initial.sessionKey !== progress.sessionKey : initial.self.some(u => u.name === 'GACNST') || !initial.self.some(u => u.name === 'AMCV'))) throw new Error('新测试需只有基地车；续测需保持同一对局，不能重放已有建设');
    progress.sessionKey = initial.sessionKey;
    progress.lastBattleStatus = battleStatus(initial);
    console.log(await command('map use ice'));
    for (const step of scenario.steps.slice(completedSteps)) {
      currentStep++;
      const record = progress.steps[currentStep - 1] ??= { text: step.text };
      record.status = 'running';
      save();
      console.log(`开始 ${currentStep}/6：${step.text}`);
      if (!record.response?.includes('已生效')) record.response = await command('say ' + step.text);
      save();
      console.log(record.response);
      if (!record.response.includes('已生效')) throw new Error('指令未激活: ' + record.response);
      const deadline = Date.now() + step.timeoutSeconds * 1000;
      let loggedAt = 0;
      for (;;) {
        const native = await observe();
        if (native?.sessionKey === progress.sessionKey) {
          progress.lastBattleStatus = battleStatus(native);
          if (step.continuousPower && native.me.power.isLowPower && !record.sawLowPower) {
            record.sawLowPower = true;
            save();
          }
        }
        const observed = native ?? (step.expect === 'victory' ? progress.lastBattleStatus : undefined);
        if (observed?.sessionKey === progress.sessionKey && complete(step, observed, state())) {
          record.status = record.sawLowPower ? 'partial' : 'passed';
          save();
          console.log(`完成 ${currentStep}/6：${step.text}${record.sawLowPower ? '（建设中曾缺电）' : ''}`);
          break;
        }
        if (native?.sessionKey !== progress.sessionKey) throw new Error('测试期间对局发生变化');
        if (Date.now() - loggedAt > 15000) {
          console.log(`执行中 · 资金 ${Math.floor(native.me.credits)} · 电力 ${native.me.power.total}/${native.me.power.drain} · 坦克 ${native.self.filter(u => u.name === 'MTNK').length} · 可见敌军 ${native.enemyCount}`);
          loggedAt = Date.now();
        }
        if (Date.now() > deadline) { record.status = 'timeout'; throw new Error(`第${currentStep}项等待超时`); }
        await delay(1000);
      }
    }
  }
} catch (error) {
  const failed = progress.steps[currentStep - 1];
  if (failed?.status === 'running') failed.status = 'failed';
  console.error(error);
  process.exitCode = 1;
} finally {
  save();
  await browser.close();
  console.log(`执行状态：${progress.steps.filter(s => s.status === 'passed').length}项通过，${progress.steps.filter(s => s.status === 'partial').length}项部分达标`);
  if (progress.steps.length !== scenario.steps.length || progress.steps.some(s => s.status !== 'passed')) process.exitCode = 1;
}
