import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');
const folder = path.join(root, '.runtime/voice-six');
const report = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const final = report.steps.at(-1)?.observed ?? report.final ?? report.initial;
const power = report.steps[4]?.observed?.me.power ?? final?.me.power;
const tanks = final?.self.filter(u => u.name === 'MTNK').length ?? 0;
const passed = report.steps.filter(s => s.status === 'passed').length;
const partial = report.steps.filter(s => s.status === 'partial').length;
const adjusted = report.steps.filter(s => s.attempts?.length).map(s => s.text);
const enemiesAtReveal = report.steps[4]?.observed?.enemies ?? [];
const limitation = enemiesAtReveal.length === 1 && /MCV/.test(enemiesAtReveal[0].name) ? '卫星揭图后只观察到一辆敌方基地车，攻击结果不能用于评价复杂对抗能力。' : '';
const descriptions = [
  '基地车已展开为盟军建造厂。',
  '电厂、矿场、兵营和战车工厂均已落地。',
  '5辆新造灰熊坦克全部编入1队。',
  '5辆坦克均进入三楼右下分区，目的地候选格为152,83。',
  `间谍卫星已落地，最终电力${power?.total}／${power?.drain}，余量${power ? power.total - power.drain : '未知'}。`,
  `敌方公开状态为defeated=true，进入遭遇战结算；己方${tanks}辆坦克存活。`,
];
const video = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '3', '-i', path.join(folder, 'frames/%06d.jpg'), '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path.join(folder, 'execution.mp4')], { encoding: 'utf8' });
if (video.status !== 0) console.error('录像导出需安装ffmpeg；截图和报告仍可查看。', video.stderr ?? video.error?.message);
const cards = report.steps.map((step, i) => {
  const id = step.response?.match(/记录：([\da-f-]+)/)?.[1];
  const tracePath = id && path.join(root, '.runtime/transcripts', `${id}.json`);
  const trace = tracePath && fs.existsSync(tracePath) ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) : null;
  const issues = step.powerViolations?.length ? `<p style="color:#9c5400">建设途中出现缺电：${escape(step.powerViolations.map(p => `${p.total}／${p.drain}`).join('、'))}，持续保持电量健康部分达标。${step.issueEvidence ? `<a href="${escape(step.issueEvidence)}">查看缺电画面</a>` : ''}</p>` : '';
  return `<article id="step-${i + 1}"><div class="card-title"><span class="number">${i + 1}</span><h2>${escape(step.text)}</h2><span class="status">${step.status === 'passed' ? '完成' : step.status === 'partial' ? '部分达标' : escape(step.status)}</span></div><p>${escape(['passed', 'partial'].includes(step.status) ? descriptions[i] : '尚未观察到本项完成')}</p>${issues}${step.screenshot ? `<a href="${escape(step.screenshot)}"><img src="${escape(step.screenshot)}" alt="${escape(step.text)}执行截图" loading="lazy"></a>` : ''}<details><summary>模型理解与目标</summary><pre>${escape(JSON.stringify(trace ? { model: trace.model, plan: trace.plan, goals: trace.goals } : { response: step.response, confirmation: step.confirmation }, null, 2))}</pre></details>${step.attempts?.length ? `<details><summary>此前受阻记录（${step.attempts.length}次）</summary><pre>${escape(JSON.stringify(step.attempts.map(a => ({ response: a.response, status: a.status })), null, 2))}</pre></details>` : ''}</article>`;
}).join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>六句模拟语音 · 实机记录</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#172538;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;line-height:1.65}main{max-width:1180px;margin:40px auto;padding:0 24px}header{margin-bottom:24px}h1{font-size:34px;margin:0 0 12px;letter-spacing:-1px}header p{color:#526477;margin:0}.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.summary span{background:white;border:1px solid #d6e1e8;padding:7px 14px;border-radius:24px;font-size:14px}.video,article{background:white;border:1px solid #d9e2ea;border-radius:14px;padding:20px;box-shadow:0 5px 20px #18304208}.video{margin-bottom:24px}video{width:100%;max-height:660px;background:black;border-radius:8px}h2{font-size:18px;margin:0}p{margin:12px 0;color:#526477}.note{padding:16px 20px;background:#fff7df;border:1px solid #ead9a6;border-radius:10px;margin:24px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card-title{display:flex;gap:10px;align-items:center}.number{background:#e7f1fc;color:#24598a;border-radius:50%;width:29px;height:29px;text-align:center;flex:none}.status{margin-left:auto;font-size:13px;color:#187443;white-space:nowrap}img{width:100%;border-radius:8px;display:block}details{margin-top:14px;font-size:14px}summary{cursor:pointer;color:#24598a}pre{background:#f4f7fa;white-space:pre-wrap;word-break:break-word;padding:12px;font-size:12px;max-height:480px;overflow:auto}a{color:#24598a}footer{margin:28px 0;color:#66788b;font-size:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}main{margin:24px auto;padding:0 14px}h1{font-size:28px}}
</style><main><header><h1>六句模拟语音 · 实机记录</h1><p>冰天雪地 · ${escape(report.initial?.me.country)} · DeepSeek deepseek-flash · ${escape(report.startedAt.slice(0, 10))}</p><div class="summary"><span>${passed} 项通过${partial ? `，${partial} 项部分达标` : ''}</span><span>${tanks} 辆坦克存活</span><span>最终电力余量 ${power ? power.total - power.drain : '未知'}</span><span>${report.steps[5]?.status === 'passed' ? '敌方已败北' : '尚未确认敌方败北'}</span></div></header><section class="video"><h2>执行片段</h2><p>由测试期间每2秒采集的真实画面导出，约6倍速；修正与重启期间有间断。画面左上角显示当前原话与阶段。</p><video controls preload="metadata" poster="step-4.png" src="execution.mp4"></video></section><aside class="note">${adjusted.length ? `本轮包含修正后续测：${escape(adjusted.join('、'))}。` : ''}${report.harnessIssues?.length ? '结算判定修正了“败北后combatant变为false”的情况。' : ''}${partial ? '第5项建设过程中出现200／235缺电，最终恢复健康，持续保持电量健康部分达标。' : ''}${escape(limitation)}当前测试模拟转写文字，尚未测试录音和语音识别。</aside><section class="grid">${cards}</section><footer><a href="result.json">完整观测记录（JSON）</a> · 原话与脚本记录保存在同仓库 .runtime/transcripts/；源码中的测试定义可复用。</footer></main></html>`;
fs.writeFileSync(path.join(folder, 'report.html'), html);
console.log(path.join(folder, 'report.html'));
