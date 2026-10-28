// 真实对局中生成的故障脚本：行军记忆导致到达后跳过攻击。
function step(snapshot, memory) {
  const actions = [];
  const goals = (snapshot.control && snapshot.control.goals) || [];
  const selfById = {};
  (snapshot.self || []).forEach(u => { selfById[u.id] = u; });
  const enemyById = {};
  (snapshot.enemies || []).forEach(u => { enemyById[u.id] = u; });

  for (const g of goals) {
    const spec = g.spec || {};
    const goalId = spec.id;
    const atk = g.attack || {};
    const readyIds = (atk.readyIds || []).filter(id => selfById[id]);
    const targets = (atk.targets || []).filter(t => enemyById[t.id]);
    if (!readyIds.length) continue;

    const objective = spec.objective || {};
    const targetSpec = objective.target || {};
    const targetNames = targetSpec.names || spec.targetNames || [];
    const targetKind = targetSpec.kind || spec.targetKind;

    // 选择匹配目标
    let chosen = null;
    for (const t of targets) {
      const e = enemyById[t.id];
      if (!e) continue;
      if (targetNames.length && targetNames.indexOf(e.name) >= 0) { chosen = e; break; }
    }
    if (!chosen && targets.length) {
      // 按类别匹配
      for (const t of targets) {
        const e = enemyById[t.id];
        if (!e) continue;
        if (targetKind === 'base' && e.type === 2) { chosen = e; break; }
        if (targetKind === 'unit' && (e.type === 3 || e.type === 7 || e.type === 1)) { chosen = e; break; }
      }
    }
    if (!chosen && targets.length) chosen = enemyById[targets[0].id];

    if (!chosen) continue;

    // 判断是否已在射程内
    const mem = memory[goalId] || {};
    const lastTarget = mem.lastTarget;
    const lastIds = mem.lastIds || [];
    const idsKey = readyIds.slice().sort().join(',');

    // 检查是否所有单位都接近目标
    let allInRange = true;
    for (const id of readyIds) {
      const u = selfById[id];
      if (!u) continue;
      const dx = u.rx - chosen.rx;
      const dy = u.ry - chosen.ry;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const range = (u.primaryWeapon && u.primaryWeapon.maxRange) || 5;
      if (dist > range) { allInRange = false; break; }
    }

    if (allInRange) {
      if (lastTarget === chosen.id && lastIds === idsKey) continue;
      actions.push({ goalId, request: { kind: 'attack', unitIds: readyIds, targetId: chosen.id } });
      memory[goalId] = { lastTarget: chosen.id, lastIds: idsKey, mode: 'attack' };
    } else {
      // 移动到目标附近
      const tx = chosen.rx;
      const ty = chosen.ry;
      const moveKey = tx + ',' + ty + ',' + idsKey;
      if (mem.lastMove === moveKey) continue;
      actions.push({ goalId, request: { kind: 'attackMove', unitIds: readyIds, x: tx, y: ty } });
      memory[goalId] = { lastTarget: chosen.id, lastIds: idsKey, lastMove: moveKey, mode: 'move' };
    }
  }

  return { actions, memory };
}
