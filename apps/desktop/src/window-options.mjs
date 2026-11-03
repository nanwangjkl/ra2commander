/** 桌面沿用默认窗口大小；Deck 不跟随桌面工作区缩小为带任务栏的尺寸。 */
export function windowSize({ platform, env, workArea, productName = '', vendor = '' }) {
  const deck = platform === 'linux' && (env.RA2C_STEAM_DECK === '1'
    || env.RA2C_STEAM_DECK !== '0' && (env.SteamDeck === '1'
      || vendor.trim() === 'Valve' && ['Jupiter', 'Galileo'].includes(productName.trim())))
  return deck ? { width: 1280, height: 800 } : { width: Math.min(1480, workArea.width), height: Math.min(960, workArea.height) }
}
