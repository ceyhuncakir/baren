/**
 * Icons.
 *
 * - Named `*Icon` exports are the exact glyphs used in the reference artboards (stroke paths
 *   copied from the design, colored with `currentColor`). Use these in app chrome.
 * - `Lucide` is the full lucide-react set for anything the designs do not cover:
 *   `<Lucide.Bell size={14} strokeWidth={1.75} />`. Bundlers tree-shake unused icons.
 */
export * from './icons'
export { TextAaIcon, type TextAaIconProps } from './TextAaIcon'
export { createIcon, type IconComponent, type IconProps } from './createIcon'
export * as Lucide from 'lucide-react'
