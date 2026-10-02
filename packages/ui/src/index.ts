/**
 * @baren/ui — design tokens, bundled fonts and React components for Baren.
 *
 * Stylesheet (import once at the app root):
 *   import '@baren/ui/styles.css'   // tokens + fonts + reset/base
 * Component styles are CSS Modules imported by the components themselves.
 */

export { clsx as cx } from 'clsx'

/* Icons */
export * from './icons'

/* Logic helpers (pure, unit-tested) */
export * from './lib/color'
export * from './lib/number'
export * from './lib/position'
export * from './lib/password'
export * from './lib/text'
export { nextEnabledIndex, rovingKeyFor, type RovingKey } from './lib/roving'
export { rafThrottle, type RafThrottled, type FrameScheduler } from './lib/raf'
export { useControllableState, useStableCallback } from './lib/hooks'
export { useMergedRefs } from './lib/refs'
export { FloatingLayer, type FloatingLayerProps, type DismissReason } from './lib/floating'

/* Shell */
export {
  TitleBar,
  MenuBarItem,
  WindowControls,
  type TitleBarProps,
  type MenuBarItemProps,
  type WindowControlsProps,
} from './components/shell/TitleBar'
export {
  MenuBar,
  MenuBarMenu,
  type MenuBarProps,
  type MenuBarMenuProps,
} from './components/shell/MenuBar'
export {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuLabel,
  MenuInput,
  MenuHeader,
  MenuControlRow,
  MenuContext,
  type MenuHeaderProps,
  type MenuControlRowProps,
  type MenuProps,
  type MenuItemProps,
  type MenuInputProps,
  type MenuContextValue,
} from './components/shell/Menu'
export { Submenu, type SubmenuProps } from './components/shell/Submenu'
export {
  ContextMenu,
  useContextMenu,
  type ContextMenuProps,
  type ContextMenuState,
} from './components/shell/ContextMenu'
export { DropdownMenu, type DropdownMenuProps } from './components/shell/DropdownMenu'
export {
  Popover,
  PopoverPanel,
  PopoverHeader,
  PopoverFooter,
  type PopoverProps,
  type PopoverPanelProps,
  type PopoverHeaderProps,
} from './components/shell/Popover'

/* Forms */
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './components/forms/Button'
export { IconButton, type IconButtonProps } from './components/forms/IconButton'
export {
  Input,
  Field,
  TextArea,
  SearchField,
  type InputProps,
  type FieldProps,
  type TextAreaProps,
  type SearchFieldProps,
} from './components/forms/Input'
export {
  Select,
  SelectTrigger,
  type SelectProps,
  type SelectOption,
  type SelectTriggerProps,
  type SelectVariant,
  type SelectSize,
} from './components/forms/Select'
export {
  Checkbox,
  Radio,
  RadioGroup,
  type CheckboxProps,
  type RadioProps,
  type RadioGroupProps,
} from './components/forms/Checkbox'
export { Segmented, type SegmentedProps, type SegmentedOption } from './components/forms/Segmented'
export { Tabs, type TabsProps, type TabItem } from './components/forms/Tabs'
export { Slider, type SliderProps } from './components/forms/Slider'
export { Switch, type SwitchProps } from './components/forms/Switch'
export { CodeInput, type CodeInputProps } from './components/forms/CodeInput'
export {
  Kbd,
  Divider,
  PasswordStrength,
  type DividerProps,
  type PasswordStrengthProps,
} from './components/forms/Misc'
export { Spinner, type SpinnerProps } from './components/forms/Spinner'

/* Display */
export { Avatar, AvatarStack, type AvatarProps, type AvatarSize } from './components/display/Avatar'
export {
  Badge,
  StatusDot,
  Status,
  type BadgeProps,
  type StatusDotProps,
  type StatusProps,
  type DotTone,
} from './components/display/Badge'
export {
  FileCard,
  FileGrid,
  FILE_CARD_HEIGHT,
  FILE_GRID_GAP,
  type FileCardProps,
} from './components/display/FileCard'
export {
  Sidebar,
  SidebarNav,
  NavItem,
  AccountTrigger,
  FooterLinks,
  SidebarSpacer,
  PromoCard,
  type SidebarNavProps,
  type NavItemProps,
  type AccountTriggerProps,
  type FooterLink,
  type FooterLinksProps,
  type PromoCardProps,
} from './components/display/Sidebar'
export {
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableCell,
  MemberCell,
  PersonRow,
  type TableProps,
  type TableHeaderCellProps,
  type MemberCellProps,
  type PersonRowProps,
} from './components/display/Table'
export {
  Toast,
  Toaster,
  toast,
  dismissToast,
  type ToastProps,
  type ToastOptions,
} from './components/display/Toast'
export {
  LogoMark,
  BrandLockup,
  IconTile,
  Callout,
  AuthHeading,
  PageTitle,
  type LogoMarkProps,
  type CalloutProps,
  type HeadingProps,
  type PageTitleProps,
} from './components/display/Brand'

/* Editor */
export {
  ToolRail,
  ToolButton,
  ToolDivider,
  type ToolButtonProps,
} from './components/editor/ToolRail'
export {
  EditorPanel,
  PanelHeader,
  PanelModeSwitch,
  PanelSectionHeader,
  SectionAction,
  PageRow,
  TokenRow,
  EmptyCanvasHint,
  type EditorPanelProps,
  type PanelHeaderProps,
  type PanelSectionHeaderProps,
  type SectionActionProps,
  type PageRowProps,
  type TokenRowProps,
  type EmptyCanvasHintProps,
} from './components/editor/Panel'
export {
  InspectorSection,
  SectionHeaderAction,
  SectionHeaderLink,
  CollapsedSection,
  InspectorRow,
  InspectorColumn,
  InspectorField,
  InspectorSelect,
  FieldIconButton,
  SplitField,
  Swatch,
  TokenChip,
  SelectionColorRow,
  ZoomChip,
  ShareButton,
  Stat,
  ChipRow,
  TokenNameField,
  type InspectorSectionProps,
  type SectionHeaderActionProps,
  type CollapsedSectionProps,
  type InspectorRowProps,
  type InspectorFieldProps,
  type InspectorSelectProps,
  type FieldIconButtonProps,
  type SplitFieldButton,
  type SwatchProps,
  type SelectionColorRowProps,
  type ZoomChipProps,
  type ShareButtonProps,
} from './components/editor/Inspector'
export {
  NumberField,
  type NumberFieldProps,
  type NumberChangeMeta,
} from './components/editor/NumberField'
export { ColorField, type ColorFieldProps } from './components/editor/ColorField'
export {
  AlignmentGrid,
  type AlignmentGridProps,
  type Alignment,
  type AxisAlign,
} from './components/editor/AlignmentGrid'
export {
  IconToggleGroup,
  type IconToggleGroupProps,
  type IconToggleOption,
} from './components/editor/IconToggleGroup'
export {
  LayerRow,
  LayerTypeIcon,
  LAYER_ROW_HEIGHT,
  type LayerRowProps,
  type LayerRowState,
  type LayerKind,
  type DropPosition,
} from './components/editor/LayerRow'
export { ColorPicker, type ColorPickerProps } from './components/editor/ColorPicker'
