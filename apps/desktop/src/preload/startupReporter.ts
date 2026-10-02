import { APP_READY_EVENT, type RendererMilestone } from './channels'

export type MilestoneReporter = (name: RendererMilestone, epochMs: number) => void

/**
 * Reports renderer startup milestones to main as absolute epoch times, so main
 * can place them on its own timeline (cold-start logging, BAREN_SMOKE).
 * Runs in the preload's isolated world; DOM events and the performance
 * timeline are shared with the page.
 */
export function reportStartupMilestones(report: MilestoneReporter): void {
  const origin = performance.timeOrigin
  const sent = new Set<RendererMilestone>()
  const once = (name: RendererMilestone, epochMs: number = origin + performance.now()): void => {
    if (sent.has(name)) return
    sent.add(name)
    report(name, epochMs)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => once('domContentLoaded'), { once: true })
  } else {
    once('domContentLoaded')
  }
  window.addEventListener('load', () => once('load'), { once: true })
  // Dispatched by the renderer once its first screen (Recents) is interactive.
  window.addEventListener(APP_READY_EVENT, () => once('appReady'), { once: true })

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name !== 'first-contentful-paint') continue
        once('firstContentfulPaint', origin + entry.startTime)
        observer.disconnect()
      }
    })
    observer.observe({ type: 'paint', buffered: true })
  } catch {
    // Paint timing unavailable: main falls back to the `load` milestone.
  }
}
