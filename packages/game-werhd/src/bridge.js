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
  var BRIDGE_VERSION = 17;
  if (window.__ra2cInstalled && window.__ra2cVersion === BRIDGE_VERSION) return;
  var upgrading = false;
  if (window.__ra2cInstalled && window.__ra2cSessionKey && typeof window.__ra2cSubmit === 'function') {
    // 空成员探测只读取旧桥的身份检查，不向游戏发令；换局/API变化不能沿用旧 UUID。
    try { upgrading = window.__ra2cSubmit(window.__ra2cSession, { kind: 'stop', unitIds: [] }, 0, window.__ra2cSessionKey).reason === 'invalid-units'; } catch (e) {}
  }
  if (window.__ra2cInterval) { try { clearInterval(window.__ra2cInterval) } catch (e) {} }
  window.__ra2cInstalled = true;
  window.__ra2cVersion = BRIDGE_VERSION;

  var SAMPLE_EVERY = 15;      // 每 N 个模拟 tick 采样一次
  var SAMPLE_MAX_EVERY = 120; // 降频上限
  var seq = upgrading ? Math.max(window.__ra2cLastSeq || 0, Date.now()) : 0;
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
    window.__ra2cSessionKey = crypto.randomUUID();
    lastSampleTick = -1;
    placeTried = {};
    identities = {};
    window.__ra2cUnitIdentities = identities;
  }

  // place 自动选址记忆（name -> 已尝试格），跳过引擎静默拒绝过的位置。
  var placeTried = {};
  var placeNoSpots = {};

  /** 以建造厂为圆心环形搜 canPlace 可用格（跳过已试）。 */
  function findPlacementSpot(w, name, placement, region) {
    var self = w.units('self') || [];
    var base = null;
    var points = region && region.polygons.reduce(function (all, polygon) { return all.concat(polygon.outer) }, []);
    var center = points && { x: points.reduce(function (n, p) { return n + p[0] }, 0) / points.length, y: points.reduce(function (n, p) { return n + p[1] }, 0) / points.length };
    for (var i = 0; i < self.length; i++) {
      if (self[i].type === 2 && /CNST/i.test(self[i].name) && (!base || center && Math.hypot(self[i].tile.rx - center.x, self[i].tile.ry - center.y) < Math.hypot(base.tile.rx - center.x, base.tile.ry - center.y))) base = self[i];
    }
    if (!base && !placement && !center) return null;
    var anchor = placement ? placement.anchor : base ? { x: base.tile.rx, y: base.tile.ry } : center;
    var keyName = (placement ? name + ':' + placement.id : name) + (region ? ':' + region.id : '');
    var tick = w.tick ? w.tick() : 0;
    var failed = region && placeNoSpots[keyName];
    if (failed && failed.count === self.length && tick >= failed.tick && tick - failed.tick < 30) return null;
    var tried = placeTried[keyName] || (placeTried[keyName] = []);
    var size = region ? w.map.size() : null;
    var maxRadius = region ? Math.max(size.width, size.height) : 20;
    for (var r = region ? 0 : 2; r <= maxRadius; r++) {
      for (var dx = -r; dx <= r; dx++) {
        for (var dy = -r; dy <= r; dy += Math.abs(dx) === r || r === 0 ? 1 : 2 * r) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          var x = Math.round(anchor.x) + dx, y = Math.round(anchor.y) + dy;
          if (region && (x < 0 || y < 0 || x >= size.width || y >= size.height || !inPlacementRegion(x, y, region))) continue;
          var key = x + ',' + y;
          if (tried.indexOf(key) >= 0) continue;
          var tile = placement && w.map.tile ? w.map.tile(x, y) : null;
          var elevation = tile && Number.isFinite(tile.z) ? tile.z : anchor.elevation || 0;
          if (placement && placementDirection(anchor, x, y, elevation) !== placement.direction) continue;
          if (w.canPlace(name, x, y)) { delete placeNoSpots[keyName]; tried.push(key); if (tried.length > (placement || region ? 128 : 24)) tried.shift(); return { x: x, y: y, elevation: elevation } }
        }
      }
    }
    if (region) placeNoSpots[keyName] = { tick: tick, count: self.length };
    return null;
  }

  // 与 contracts/spatial.ts 一致：边界计入，孔洞内部排除。
  function inPlacementRegion(x, y, region) {
    function ring(points) {
      var inside = false;
      for (var i = 1; i < points.length; i++) {
        var ax = points[i - 1][0], ay = points[i - 1][1], bx = points[i][0], by = points[i][1];
        var cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
        if (Math.abs(cross) <= 1e-7 * Math.max(1, Math.hypot(bx - ax, by - ay)) && x >= Math.min(ax, bx) - 1e-7 && x <= Math.max(ax, bx) + 1e-7 && y >= Math.min(ay, by) - 1e-7 && y <= Math.max(ay, by) + 1e-7) return 0;
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
      }
      return inside ? 1 : -1;
    }
    return region.polygons.some(function (polygon) { return ring(polygon.outer) !== -1 && !polygon.holes.some(function (hole) { return ring(hole) === 1 }) });
  }

  // 与 contracts/placement.ts 的画面投影一致；不能把地图 y 轴当作屏幕上下。
  function placementDirection(anchor, x, y, elevation) {
    var dx = x - anchor.x, dy = y - anchor.y;
    var sx = dx - dy, sy = (dx + dy) / 2 - (elevation - (anchor.elevation || 0));
    if (!sx && !sy) return undefined;
    return ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'][(Math.round(Math.atan2(sy, sx) / (Math.PI / 4)) + 8) % 8];
  }

  var ENEMY_CAP = 200; // 敌方采集上限护栏


  var identities = upgrading && window.__ra2cUnitIdentities || {};
  window.__ra2cUnitIdentities = identities;

  var speedSession = '', moveSpeeds = {}, speedRequests = {};
  function mapUnit(u) {
    var t = u.tile || {};
    var speedKey = u.type + ':' + u.name;
    if (speedSession !== window.__ra2cSessionKey) { speedSession = window.__ra2cSessionKey; moveSpeeds = {}; speedRequests = {} }
    if (!Object.prototype.hasOwnProperty.call(moveSpeeds, speedKey)) speedRequests[speedKey] = { name: u.name, type: u.type };
    return {
      id: u.id,
      name: u.name,
      owner: u.owner,
      type: u.type,
      rx: t.rx,
      ry: t.ry,
      hitPoints: u.hitPoints,
      maxHitPoints: u.maxHitPoints,
      elevation: u.elevation,
      isIdle: u.isIdle,
      speed: moveSpeeds[speedKey],
      velocity: u.velocity ? { x: u.velocity.x, y: u.velocity.y, z: u.velocity.z } : undefined,
      zone: u.zone,
      canDeploy: u.canDeploy,
      ammo: u.ammo,
      hasWrenchRepair: u.hasWrenchRepair,
      veteranLevel: u.veteranLevel,
      primaryWeapon: u.primaryWeapon,
      secondaryWeapon: u.secondaryWeapon,
      transport: u.transport ? { occupied: u.transport.occupied, capacity: u.transport.capacity, unitIds: u.transport.unitIds.slice(), passengers: u.transport.unitIds.map(function (id) { return identities[id] }).filter(Boolean) } : undefined,
    };
  }

  function collect(w) {
    var t0 = performance.now();
    var units = w.units('self') || [];
    for (var k = 0; k < units.length; k++) identities[units[k].id] = { id: units[k].id, name: units[k].name, type: units[k].type };
    for (var v = 0; v < units.length; v++) if (units[v].transport) for (var p = 0; p < units[v].transport.unitIds.length; p++) {
      var passengerId = units[v].transport.unitIds[p];
      if (!(passengerId in identities) && w.unit) { var passenger = w.unit(passengerId); identities[passengerId] = passenger ? { id: passenger.id, name: passenger.name, type: passenger.type } : null; }
    }
    var self = new Array(units.length);
    for (var i = 0; i < units.length; i++) self[i] = mapUnit(units[i]);
    var hostile = w.units('hostile') || [];
    var enemies = [];
    for (var j = 0; j < hostile.length && j < ENEMY_CAP; j++) enemies.push(mapUnit(hostile[j]));
    var me = w.me();
    var size = w.map.size();
    var snap = {
      session: currentSession(),
      sessionKey: window.__ra2cSessionKey,
      seq: ++seq,
      tick: w.tick(),
      time: w.time(),
      credits: me && me.credits,
      country: me && me.country,
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
    window.__ra2cLastSeq = seq;
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
      if (window.werhd !== w || currentSession() !== session) return;
      lastTickAt = Date.now();
      var tick = ctx && ctx.tick != null ? ctx.tick : w.tick();
      if (tick < lastSampleTick) { bumpSession('tick-reset'); return }
      if (lastSampleTick >= 0 && tick - lastSampleTick < SAMPLE_EVERY) return;
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
      sessionKey: window.__ra2cSessionKey || '',
      sessionNote: window.__ra2cSessionNote || '',
      apiAlive: !!window.werhd,
      hookedSession: hookedSession,
      lastTickAt: lastTickAt,
      sampleEvery: SAMPLE_EVERY,
      stats: stats,
    };
  };

  // 页面内动作提交（宿主 evaluate 调用）；返回与宿主 ActionResult 对齐的对象。
  window.__ra2cSubmit = function (session, action, expectedSeq, sessionKey) {
    var w = window.werhd;
    if (!w) return { ok: false, reason: 'no-api', submitted: 0, session: session };
    if (w !== previousApi || w.tick() < lastSampleTick) return { ok: false, reason: 'stale-session', submitted: 0, session: currentSession() };
    if (session !== currentSession() || sessionKey !== window.__ra2cSessionKey) {
      return { ok: false, reason: 'stale-session', submitted: 0, session: currentSession() };
    }
    // 停车不依赖旧位置，允许宿主撤权后用同局稍早的快照紧急停车。
    if (action.kind !== 'stop' && expectedSeq !== seq) return { ok: false, reason: 'stale-snapshot', submitted: 0, session: currentSession() };
    var alive = {};
    var own = w.units('self') || [];
    for (var i = 0; i < own.length; i++) alive[own[i].id] = true;

    // 生产动作（无 unitIds）
    try {
      switch (action.kind) {
        case 'produce': w.produce(action.name, action.quantity || 1); return { ok: true, submitted: 1, session: session };
        case 'cancel': {
          if (!Number.isSafeInteger(action.quantity) || action.quantity < 1) return { ok: false, reason: 'invalid-quantity', submitted: 0, session: session };
          var queued = (w.production.queues() || []).reduce(function (total, queue) {
            return total + (queue.items || []).reduce(function (n, item) { return n + (item.name === action.name ? item.quantity : 0); }, 0);
          }, 0);
          if (!queued) return { ok: false, reason: 'not-queued', submitted: 0, session: session };
          w.cancel(action.name, Math.min(queued, action.quantity));
          return { ok: true, submitted: 1, session: session };
        }
        case 'place': {
          var px = action.x, py = action.y, elevation;
          if (!Number.isFinite(px) || !Number.isFinite(py)) {
            // 宿主自动选址（几何与选位是宿主原语；引擎对非法格静默丢弃，脚本无法感知）。
            var spot = findPlacementSpot(w, action.name, action.placement, action.placementRegion);
            if (!spot) return { ok: false, reason: 'no-spot', submitted: 0, session: session };
            px = spot.x; py = spot.y; elevation = spot.elevation;
          } else if (w.canPlace && !w.canPlace(action.name, px, py)) {
            return { ok: false, reason: 'cannot-place', submitted: 0, session: session };
          }
          if (action.placementRegion && !inPlacementRegion(px, py, action.placementRegion)) return { ok: false, reason: 'wrong-placement-region', submitted: 0, session: session };
          if (action.placement) {
            var targetTile = w.map.tile ? w.map.tile(px, py) : null;
            elevation = targetTile && Number.isFinite(targetTile.z) ? targetTile.z : action.placement.anchor.elevation || 0;
            if (placementDirection(action.placement.anchor, px, py, elevation) !== action.placement.direction) return { ok: false, reason: 'wrong-placement', submitted: 0, session: session };
          }
          w.place(action.name, px, py); return { ok: true, submitted: 1, session: session, placement: { x: px, y: py, elevation: elevation || 0 } };
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
        case 'repairBuilding':
        case 'sellBuilding': {
          var buildings = ids.map(function (id) { return own.find(function (unit) { return unit.id === id }); });
          if (buildings.some(function (unit) { return !unit || unit.type !== 2; })) return { ok: false, reason: 'invalid-building', submitted: 0, session: session };
          if (action.kind === 'sellBuilding' && w.rules && buildings.some(function (unit) { var rule = w.rules(unit.name, 2); return rule && rule.unsellable; })) return { ok: false, reason: 'unsellable-building', submitted: 0, session: session };
          var count = 0;
          buildings.forEach(function (unit) {
            if (action.kind === 'repairBuilding') {
              if (unit.hasWrenchRepair || !(unit.hitPoints > 0 && unit.hitPoints < unit.maxHitPoints)) return;
              w.repair(unit.id);
            } else w.sell(unit.id);
            count++;
          });
          return { ok: true, submitted: count, session: session };
        }
        case 'enterTransport':
        case 'repair': {
          var target = own.find(function (unit) { return unit.id === action.targetId });
          if (!target) return { ok: false, reason: 'invalid-friendly-target', submitted: 0, session: session };
          if (action.kind === 'enterTransport' && (!target.transport || target.transport.occupied >= target.transport.capacity)) return { ok: false, reason: 'transport-full', submitted: 0, session: session };
          if (action.kind === 'repair' && (target.type !== 7 || !(target.hitPoints > 0 && target.hitPoints < target.maxHitPoints))) return { ok: false, reason: 'target-not-damaged', submitted: 0, session: session };
          // IFV 的负伤害武器走普通 Attack；Repair 是工程师修建筑的消耗动作。
          if (!w.order(ids, { type: action.kind === 'enterTransport' ? 17 : 2, target: { objectId: action.targetId } })) return { ok: false, reason: 'order-rejected', submitted: 0, session: session };
          break;
        }
        case 'attack': {
          var visible = w.units('hostile') || [];
          if (!visible.some(function (u) { return u.id === action.targetId })) return { ok: false, reason: 'invisible-target', submitted: 0, session: session };
          if (action.holdPosition) {
            var ready = ids.filter(function (id) { try { return w.inRange(id, action.targetId, 'current'); } catch (e) { return false; } });
            if (!ready.length) return { ok: true, reason: 'cover-out-of-range', submitted: 0, session: session };
            w.attack(ready, action.targetId); break;
          }
          w.attack(ids, action.targetId); break;
        }
        case 'stop': w.stop(ids); break;
        case 'deploy':
          if (!w.deploy(ids)) return { ok: false, reason: 'deploy-rejected', submitted: 0, session: session };
          break;
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
  var previousApi = upgrading ? window.werhd : undefined;
  window.__ra2cInterval = setInterval(function () {
    var hasApi = !!window.werhd;
    if (hasApi && window.werhd !== previousApi) bumpSession('api-appeared');
    if (!hasApi && previousApi) bumpSession('api-removed');
    previousApi = window.werhd;
    if (hasApi && (hookedSession !== currentSession() || Date.now() - lastTickAt > 4000)) {
      hook();
    }
    // 规则查询放在 tick 采样之外；按兵种缓存，避免整队初始化拖慢游戏回调。
    if (hasApi && speedSession === window.__ra2cSessionKey) Object.keys(speedRequests).slice(0, 32).forEach(function (key) {
      var request = speedRequests[key];
      try { var rule = typeof window.werhd.rules === 'function' && window.werhd.rules(request.name, request.type); moveSpeeds[key] = rule && Number.isFinite(rule.speed) ? rule.speed : undefined }
      catch (_) { moveSpeeds[key] = undefined }
      delete speedRequests[key];
    });
  }, 500);
})();
