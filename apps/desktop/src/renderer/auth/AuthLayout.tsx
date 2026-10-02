import { BrandLockup } from '@baren/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { bridge } from '../lib/bridge'
import css from './Auth.module.css'
import { Artwork } from './Artwork'

let cachedVersion: string | null = null

function useVersion(): string | null {
  const [version, setVersion] = useState(cachedVersion)
  useEffect(() => {
    if (cachedVersion) return
    let alive = true
    void bridge.app.version().then((v) => {
      cachedVersion = v
      if (alive) setVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return version
}

/**
 * Auth screens (artboards 18–23): a 560px form panel (brand, centered form, footer row) next
 * to the brand artwork. `footer` adds links before the version.
 */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const version = useVersion()
  return (
    <div className={css.auth}>
      <div className={css.panel}>
        <BrandLockup />
        <div className={css.formArea}>{children}</div>
        <div className={css.legal}>
          {footer}
          <span className={css.version}>{version ? `v${version}` : ''}</span>
        </div>
      </div>
      <Artwork />
    </div>
  )
}
