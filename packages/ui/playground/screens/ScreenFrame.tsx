import { useEffect, useState, type ReactNode } from 'react'

type OverlayMode = 'off' | 'onion' | 'diff' | 'ref'
const ORDER: OverlayMode[] = ['off', 'onion', 'diff', 'ref']

function initialMode(): OverlayMode {
  const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const m = q.get('overlay')
  return m === 'onion' || m === 'diff' || m === 'ref' ? m : 'off'
}

/**
 * 1440×900 frame at the page origin so a screenshot lines up with design/reference/*.png.
 * Press "o" to cycle the reference overlay: onion skin → difference blend → reference only.
 */
export function ScreenFrame({ reference, children }: { reference: string; children: ReactNode }) {
  const [mode, setMode] = useState<OverlayMode>(initialMode)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'o' || e.target instanceof HTMLInputElement) return
      setMode((m) => ORDER[(ORDER.indexOf(m) + 1) % ORDER.length] ?? 'off')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="pg-screen" data-testid="pg-screen">
        {children}
      </div>
      {mode !== 'off' && (
        <>
          <img
            className="pg-overlay"
            src={reference}
            alt=""
            data-mode={mode === 'ref' ? undefined : mode}
          />
          <div className="pg-overlay-hint">overlay: {mode} (press o)</div>
        </>
      )}
    </>
  )
}
