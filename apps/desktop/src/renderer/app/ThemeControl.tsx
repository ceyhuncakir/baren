import { Segmented, type SegmentedProps } from '@baren/ui'
import { useTheme } from '../state/theme'
import type { ThemePreference } from '../types/bridge'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const

type Props = Omit<SegmentedProps<ThemePreference>, 'options' | 'value' | 'onChange'>

/**
 * Light / Dark / System (Account menu, Preferences). The main process stores the choice
 * and every window follows it (`bridge.theme`).
 */
export function ThemeControl(props: Props) {
  const preference = useTheme((s) => s.preference)
  const resolved = useTheme((s) => s.resolved)
  return (
    <Segmented<ThemePreference>
      aria-label="Theme"
      {...props}
      value={preference ?? resolved}
      options={THEME_OPTIONS}
      onChange={(value) => void useTheme.getState().setPreference(value)}
    />
  )
}
