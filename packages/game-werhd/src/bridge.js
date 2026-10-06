// 注入游戏页面的桥脚本（在页面上下文执行，纯 JS，不打包）。
//
// 职责（MVP）：
//  - 轮询 window.werhd，对局出现时递增会话代次并注册 onTick；
//  - onTick 内低开销采样快照，经 window.__ra2cSnapshot 回传宿主；
//  - 自愈：回调被他人替换或 API 摘除后自动重挂/递增代次。
//
// 约束：onTick 同步执行超过约 8ms 会被停用，因此回调内只做采集，
// 且带性能护栏（超预算自动降频）。
(() => {
  'use strict';
  if (window.__ra2cInstalled) return;
  window.__ra2cInstalled = true;

  var SAMPLE_EVERY = 15;      // 每 N 个模拟 tick 采样一次
  var SAMPLE_MAX_EVERY = 120; // 降频上限
  var seq = 0;
  var lastSampleTick = -1;
  var lastTickAt = 0;         // Date.now()，宿主用来判断对局是否活跃
  var hookedSession = -1;     // 当前 onTick 挂接的会话代次
  var stats = { samples: 0, collectMsMax: 0, degradeCount: 0 };

  function currentSession() {
    return window.__ra2cSession || 0;
  }

  function bumpSession(why) {
    window.__ra2cSession = currentSession() + 1;
    window.__ra2cSessionNote = why;
    hookedSession = -1; // 强制重挂
  }

  function collect(w) {
    var t0 = performance.now();
    var units = w.units('self') || [];
    var self = new Array(units.length);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var t = u.tile || {};
      self[i] = {
        id: u.id,
        name: u.name,
        owner: u.owner,
        type: u.type,
        rx: t.rx,
        ry: t.ry,
        hitPoints: u.hitPoints,
        maxHitPoints: u.maxHitPoints,
        isIdle: u.isIdle,
        veteranLevel: u.veteranLevel,
      };
    }
    var me = w.me();
    var size = w.map.size();
    var snap = {
      session: currentSession(),
      seq: ++seq,
      tick: w.tick(),
      time: w.time(),
      credits: me && me.credits,
      mapWidth: size.width,
      mapHeight: size.height,
      self: self,
    };
    var cost = performance.now() - t0;
    stats.samples++;
    if (cost > stats.collectMsMax) stats.collectMsMax = cost;
    // 性能护栏：采集+回传预算 3ms，超预算则降频（翻倍间隔）。
    if (cost > 3 && SAMPLE_EVERY < SAMPLE_MAX_EVERY) {
      SAMPLE_EVERY = Math.min(SAMPLE_MAX_EVERY, SAMPLE_EVERY * 2);
      stats.degradeCount++;
    }
    return snap;
  }

  function hook() {
    var w = window.werhd;
    if (!w || typeof w.onTick !== 'function') return false;
    var session = currentSession();
    w.onTick(function (ctx) {
      lastTickAt = Date.now();
      var tick = ctx && ctx.tick != null ? ctx.tick : w.tick();
      if (tick - lastSampleTick < SAMPLE_EVERY) return;
      lastSampleTick = tick;
      var snap = collect(w);
      if (window.__ra2cSnapshot) {
        try {
          window.__ra2cSnapshot(snap);
        } catch (e) {
          // 宿主 binding 异常不应影响游戏；下次再试。
        }
      }
    });
    hookedSession = session;
    lastTickAt = Date.now();
    return true;
  }

  // 页面内状态查询（宿主 evaluate 调用）。
  window.__ra2cState = function () {
    return {
      installed: true,
      session: currentSession(),
      sessionNote: window.__ra2cSessionNote || '',
      apiAlive: !!window.werhd,
      hookedSession: hookedSession,
      lastTickAt: lastTickAt,
      sampleEvery: SAMPLE_EVERY,
      stats: stats,
    };
  };

  // 页面内动作提交（宿主 evaluate 调用）；返回与宿主 ActionResult 对齐的对象。
  window.__ra2cSubmit = function (session, action) {
    var w = window.werhd;
    if (!w) return { ok: false, reason: 'no-api', submitted: 0, session: session };
    if (session !== currentSession()) {
      return { ok: false, reason: 'stale-session', submitted: 0, session: currentSession() };
    }
    var alive = {};
    var own = w.units('self') || [];
    for (var i = 0; i < own.length; i++) alive[own[i].id] = true;
    var ids = [];
    for (var j = 0; j < action.unitIds.length; j++) {
      if (alive[action.unitIds[j]]) ids.push(action.unitIds[j]);
    }
    if (!ids.length) return { ok: false, reason: 'invalid-units', submitted: 0, session: session };
    try {
      switch (action.kind) {
        case 'move': w.move(ids, action.x, action.y); break;
        case 'attackMove': w.attackMove(ids, action.x, action.y); break;
        case 'gather': w.gather(ids, action.x, action.y); break;
        case 'attack': w.attack(ids, action.targetId); break;
        case 'stop': w.stop(ids); break;
        case 'scatter': ids.forEach(function (id) { w.order([id], { type: 16 }); }); break;
        case 'guard': ids.forEach(function (id) { w.order([id], { type: 5 }); }); break;
        default: return { ok: false, reason: 'unknown-kind', submitted: 0, session: session };
      }
      return { ok: true, submitted: ids.length, session: session };
    } catch (e) {
      return { ok: false, reason: 'api-error: ' + (e && e.message), submitted: 0, session: session };
    }
  };

  // 主循环：发现新对局 → 递增代次并挂接；发现 API 消失 → 递增代次；
  // 发现挂接丢失（onTick 被替换后不再更新 lastTickAt）→ 重挂同代次。
  var hadApi = false;
  setInterval(function () {
    var hasApi = !!window.werhd;
    if (hasApi && !hadApi) bumpSession('api-appeared');
    if (!hasApi && hadApi) bumpSession('api-removed');
    hadApi = hasApi;
    if (hasApi && (hookedSession !== currentSession() || Date.now() - lastTickAt > 4000)) {
      hook();
    }
  }, 500);
})();
