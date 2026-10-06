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
  var BRIDGE_VERSION = 2; // 桥升级：companion 重启时按版本重装（清掉旧轮询）
  if (window.__ra2cInstalled && window.__ra2cVersion === BRIDGE_VERSION) return;
  if (window.__ra2cInterval) { try { clearInterval(window.__ra2cInterval) } catch (e) {} }
  window.__ra2cInstalled = true;
  window.__ra2cVersion = BRIDGE_VERSION;

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

  // place 自动选址记忆（name -> 已尝试格），跳过引擎静默拒绝过的位置。
  var placeTried = {};

  /** 以建造厂为圆心环形搜 canPlace 可用格（跳过已试）。 */
  function findPlacementSpot(w, name) {
    var self = w.units('self') || [];
    var base = null;
    for (var i = 0; i < self.length; i++) {
      if (self[i].type === 2 && /CNST/i.test(self[i].name)) { base = self[i]; break }
    }
    if (!base) return null;
    var tried = placeTried[name] || (placeTried[name] = []);
    for (var r = 2; r <= 20; r++) {
      for (var dx = -r; dx <= r; dx++) {
        for (var dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          var x = base.tile.rx + dx, y = base.tile.ry + dy;
          var key = x + ',' + y;
          if (tried.indexOf(key) >= 0) continue;
          if (w.canPlace(name, x, y)) { tried.push(key); if (tried.length > 24) tried.shift(); return { x: x, y: y } }
        }
      }
    }
    return null;
  }

  var ENEMY_CAP = 200; // 敌方采集上限护栏


  function mapUnit(u) {
    var t = u.tile || {};
    return {
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

  function collect(w) {
    var t0 = performance.now();
    var units = w.units('self') || [];
    var self = new Array(units.length);
    for (var i = 0; i < units.length; i++) self[i] = mapUnit(units[i]);
    var hostile = w.units('hostile') || [];
    var enemies = [];
    for (var j = 0; j < hostile.length && j < ENEMY_CAP; j++) enemies.push(mapUnit(hostile[j]));
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
      enemies: enemies,
    };
    // 生产态势：队列/电力/可造清单（M3）。采集失败不影响战斗快照。
    try {
      snap.production = {
        power: (me && me.power) || { drain: 0, total: 0, isLowPower: false },
        queues: (w.production.queues() || []).map(function (q) {
          return {
            type: q.type, status: q.status, size: q.size, maxSize: q.maxSize,
            items: (q.items || []).map(function (it) {
              return { name: it.name, quantity: it.quantity, progress: it.progress, creditsEach: it.creditsEach, creditsSpent: it.creditsSpent };
            }),
          };
        }),
        available: (w.production.available() || []).map(function (a) { return a.name; }),
      };
    } catch (e) { /* 进局前的过渡期没有生产 API */ }
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

    // 生产动作（无 unitIds）
    try {
      switch (action.kind) {
        case 'produce': w.produce(action.name, action.quantity || 1); return { ok: true, submitted: 1, session: session };
        case 'cancel': w.cancel(action.name, action.quantity || 1); return { ok: true, submitted: 1, session: session };
        case 'place': {
          var px = action.x, py = action.y;
          if (!Number.isFinite(px) || !Number.isFinite(py)) {
            // 宿主自动选址（几何与选位是宿主原语；引擎对非法格静默丢弃，脚本无法感知）。
            var spot = findPlacementSpot(w, action.name);
            if (!spot) return { ok: false, reason: 'no-spot', submitted: 0, session: session };
            px = spot.x; py = spot.y;
          } else if (w.canPlace && !w.canPlace(action.name, px, py)) {
            return { ok: false, reason: 'cannot-place', submitted: 0, session: session };
          }
          w.place(action.name, px, py); return { ok: true, submitted: 1, session: session };
        }
        case 'pauseQueue': w.pause(action.queueType); return { ok: true, submitted: 1, session: session };
        case 'resumeQueue': w.resume(action.queueType); return { ok: true, submitted: 1, session: session };
      }
    } catch (e) {
      return { ok: false, reason: 'api-error: ' + (e && e.message), submitted: 0, session: session };
    }

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
  window.__ra2cInterval = setInterval(function () {
    var hasApi = !!window.werhd;
    if (hasApi && !hadApi) bumpSession('api-appeared');
    if (!hasApi && hadApi) bumpSession('api-removed');
    hadApi = hasApi;
    if (hasApi && (hookedSession !== currentSession() || Date.now() - lastTickAt > 4000)) {
      hook();
    }
  }, 500);
})();
