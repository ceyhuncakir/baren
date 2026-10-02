import { BrandLockup } from '@baren/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { bridge } from '../lib/bridge'
import { LINKS } from '../lib/links'
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

const open = (url: string) => () => void bridge.shell.openExternal(url)

/**
 * Auth screens (artboards 18–21): a 560px form panel (brand, centered form, legal row) next
 * to the brand artwork. `footer` adds links between "Terms · Privacy" and the version.
 */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const version = useVersion()
  return (
    <div className={css.auth}>
      <div className={css.panel}>
        <BrandLockup />
        <div className={css.formArea}>{children}</div>
        <div className={css.legal}>
          <span className={css.legalLinks}>
            <button type="button" className={css.legalLink} onClick={open(LINKS.terms)}>
              Terms
            </button>
            {' · '}
            <button type="button" className={css.legalLink} onClick={open(LINKS.privacy)}>
              Privacy
            </button>
          </span>
          {footer}
          <span className={css.version}>{version ? `v${version}` : ''}</span>
        </div>
      </div>
      <Artwork />
    </div>
  )
}
