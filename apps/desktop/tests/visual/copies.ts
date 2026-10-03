/**
 * What the app copies, recorded in the page instead of on the system clipboard. The suite's
 * parallel workers share one clipboard, so a test that copies races the clipboard reads of
 * the others ("Clipboard data has changed"). Tests that only need to see what was copied use
 * this; paste tests keep the real clipboard.
 */
import type { Page } from '@playwright/test'

/** Install the recorder (before the page loads the app); returns the latest copied text. */
export async function recordCopies(page: Page): Promise<() => Promise<string>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    navigator.clipboard.writeText = async (text: string) => void w.__copied.push(text)
    navigator.clipboard.write = async (items: ClipboardItem[]) => {
      for (const item of items)
        if (item.types.includes('text/plain'))
          w.__copied.push(await (await item.getType('text/plain')).text())
    }
  })
  return () =>
    page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '')
}
