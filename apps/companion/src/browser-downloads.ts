import type { Browser } from 'playwright'

/** CDP 连接默认将下载改成临时目录里的 GUID；工作台下载应保留 Chrome 的目录与文件名。 */
export async function restoreBrowserDownloads(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession()
  try {
    await session.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false })
  } finally { await session.detach() }
}
