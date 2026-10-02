import { TitleBar, WindowControls } from '@baren/ui'
import { memo, useEffect, useState } from 'react'
import { bridge } from '../lib/bridge'
import { AppMenuBar } from './AppMenuBar'
import css from './App.module.css'

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let alive = true
    void bridge.window.isMaximized().then((v) => alive && setMaximized(v))
    const off = bridge.window.onMaximizedChange(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [])
  return maximized
}

const onMinimize = () => bridge.window.minimize()
const onToggleMaximize = () => bridge.window.toggleMaximize()
const onClose = () => bridge.window.close()

/**
 * The 36px title bar on every screen. Linux/Windows: HTML menu bar + drawn window controls
 * (frameless window). macOS: the native menu and traffic lights take over, so the left keeps
 * room for the lights and the right stays empty.
 */
export const AppTitleBar = memo(function AppTitleBar({ title }: { title: string }) {
  const mac = bridge.platform === 'darwin'
  const maximized = useMaximized()
  return (
    <TitleBar
      title={title}
      menu={mac ? <div className={css.trafficLights} aria-hidden="true" /> : <AppMenuBar />}
      controls={
        mac ? undefined : (
          <WindowControls
            maximized={maximized}
            onMinimize={onMinimize}
            onToggleMaximize={onToggleMaximize}
            onClose={onClose}
          />
        )
      }
    />
  )
})
