/** ra2web 0.87.0：Mixer 用 channel,volume 分号分隔，界面音量 0～10 映射为 0～1。 */
const FIRST_USE_PREFERENCES = {
  // 只调整主音量和音乐，保留原游戏的制作人员、环境通道默认值。
  _r_mixer_v3: '0,0.2;6,0.2;5,0;2,0.3',
  'ra2web.mobileJoystickLite.enabled': '0',
  // GeneralOptions 支持只保存卷动值；一格为 3，原默认 12（第 4 格）。
  _r_opts_v3: '15',
  _r_lastMap: 'mp32s8.map',
  _r_lastMode: '1',
  // 固定站点的可选国家顺序：French=2、Africans=5。
  _r_lastCountry: '5',
  // 每槽：难度、国家、颜色、出生点、队伍。1 为 AI-简单，2 实际是训练木桩。
  // 第 0 槽留给玩家，其余除第 1 槽法国电脑外全部关闭；-2 表示随机/无队伍。
  _r_lastBots: Array.from({ length: 8 }, (_, slot) => slot === 1 ? '1,2,-2,-2,-2' : '0,-1,-1,-1,-1').join(','),
}

/** 在游戏读取设置之前补充缺失值；已有偏好及正在运行的游戏均不强制改写。 */
export function createGameDefaultsSource(gameUrl: string): string {
  const game = new URL(gameUrl)
  return `(() => {
    if (location.origin !== ${JSON.stringify(game.origin)} || !${JSON.stringify([game.pathname, `${game.pathname}index.html`])}.includes(location.pathname)) return;
    try {
      const storage = window.localStorage;
      for (const [key, value] of Object.entries(${JSON.stringify(FIRST_USE_PREFERENCES)})) {
        if (storage.getItem(key) === null) storage.setItem(key, value);
      }
    } catch (error) { console.warn('[ra2c] 无法初始化游戏默认设置', error); }
  })();`
}
