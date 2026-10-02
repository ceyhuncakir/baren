/**
 * Every icon used in the reference artboards, with their exact path data
 * (mostly Lucide geometry, some custom). Default stroke widths match the most common
 * usage; components pass the per-site value (1.75 / 2 / 2.25 / 2.5).
 */
import { createIcon } from './createIcon'

const SECONDARY = 'var(--icon-secondary, currentColor)'

/* --- Window & generic UI ------------------------------------------------ */

export const MinusIcon = createIcon('MinusIcon', <path d="M5 12h14" />)
export const PlusIcon = createIcon(
  'PlusIcon',
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
)
export const XIcon = createIcon(
  'XIcon',
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
)
export const SquareIcon = createIcon(
  'SquareIcon',
  <rect x="3" y="3" width="18" height="18" rx="2" />,
)
/** Window "restore" (shown instead of SquareIcon while maximized). */
export const RestoreIcon = createIcon(
  'RestoreIcon',
  <>
    <rect x="3" y="7" width="14" height="14" rx="2" />
    <path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
  </>,
)
export const ChevronDownIcon = createIcon('ChevronDownIcon', <path d="m6 9 6 6 6-6" />)
export const ChevronRightIcon = createIcon('ChevronRightIcon', <path d="m9 18 6-6-6-6" />)
export const ChevronLeftIcon = createIcon('ChevronLeftIcon', <path d="m15 18-6-6 6-6" />)
export const ChevronUpIcon = createIcon('ChevronUpIcon', <path d="m18 15-6-6-6 6" />)
export const CheckIcon = createIcon('CheckIcon', <path d="M20 6 9 17l-5-5" />, { strokeWidth: 2.5 })
export const SearchIcon = createIcon(
  'SearchIcon',
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>,
)
export const MoreHorizontalIcon = createIcon(
  'MoreHorizontalIcon',
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>,
)
export const ArrowRightIcon = createIcon(
  'ArrowRightIcon',
  <>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </>,
)
export const ArrowDownIcon = createIcon(
  'ArrowDownIcon',
  <>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </>,
)
export const ArrowUpRightIcon = createIcon(
  'ArrowUpRightIcon',
  <>
    <path d="M7 7h10v10" />
    <path d="M7 17 17 7" />
  </>,
)
/** Filled sort caret used in table headers (02 "Member ▾"). */
export const SortDownIcon = createIcon('SortDownIcon', <path d="M7 10l5 5 5-5z" />, {
  filled: true,
})

/* --- Home sidebar & lists -------------------------------------------------- */

export const ClockIcon = createIcon(
  'ClockIcon',
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>,
  { strokeWidth: 1.75 },
)
export const GraduationCapIcon = createIcon(
  'GraduationCapIcon',
  <>
    <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
    <path d="M22 10v6" />
    <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
  </>,
  { strokeWidth: 1.75 },
)
export const UsersIcon = createIcon(
  'UsersIcon',
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
  { strokeWidth: 1.75 },
)
export const UserIcon = createIcon(
  'UserIcon',
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
)
export const LayoutGridIcon = createIcon(
  'LayoutGridIcon',
  <>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </>,
  { strokeWidth: 1.75 },
)
export const ListIcon = createIcon(
  'ListIcon',
  <>
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
  </>,
  { strokeWidth: 1.75 },
)
export const ArchiveIcon = createIcon(
  'ArchiveIcon',
  <>
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </>,
  { strokeWidth: 1.75 },
)
export const SettingsIcon = createIcon(
  'SettingsIcon',
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>,
  { strokeWidth: 1.75 },
)
export const PencilIcon = createIcon(
  'PencilIcon',
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </>,
)
export const PanelLeftIcon = createIcon(
  'PanelLeftIcon',
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
  </>,
  { strokeWidth: 1.75 },
)
export const FileIcon = createIcon(
  'FileIcon',
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </>,
  { strokeWidth: 1.75 },
)
export const LockIcon = createIcon(
  'LockIcon',
  <>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
)
export const UnlockIcon = createIcon(
  'UnlockIcon',
  <>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </>,
)
export const EyeIcon = createIcon(
  'EyeIcon',
  <>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>,
)
export const EyeOffIcon = createIcon(
  'EyeOffIcon',
  <>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </>,
)
export const MailIcon = createIcon(
  'MailIcon',
  <>
    <rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </>,
  { strokeWidth: 1.75 },
)
export const InfoIcon = createIcon(
  'InfoIcon',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </>,
)
export const GlobeIcon = createIcon(
  'GlobeIcon',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </>,
  { strokeWidth: 1.75 },
)
export const LinkIcon = createIcon(
  'LinkIcon',
  <>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </>,
)
export const CopyIcon = createIcon(
  'CopyIcon',
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
)
/** "Continue in your browser" tile (21). */
export const BrowserOpenIcon = createIcon(
  'BrowserOpenIcon',
  <>
    <path d="M21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7" />
    <path d="M3 9h9" />
    <path d="M15 3h6v6" />
    <path d="M21 3l-8 8" />
  </>,
  { strokeWidth: 1.6 },
)

/* --- Tool rail (06) -------------------------------------------------------- */

export const PointerToolIcon = createIcon(
  'PointerToolIcon',
  <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />,
  { strokeWidth: 1.75 },
)
export const HandToolIcon = createIcon(
  'HandToolIcon',
  <>
    <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
    <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
    <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </>,
  { strokeWidth: 1.75 },
)
/** "Tool / Artboard" in the rail: scan corners. */
export const ArtboardToolIcon = createIcon(
  'ArtboardToolIcon',
  <>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
  </>,
  { strokeWidth: 1.75 },
)
export const RectangleToolIcon = createIcon(
  'RectangleToolIcon',
  <rect width="17" height="17" x="3.5" y="3.5" rx="1" />,
  { strokeWidth: 1.75 },
)
export const PenToolIcon = createIcon(
  'PenToolIcon',
  <>
    <path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" />
    <path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" />
    <path d="m2.3 2.3 7.286 7.286" />
    <circle cx="11" cy="11" r="2" />
  </>,
  { strokeWidth: 1.75 },
)
export const InsertToolIcon = createIcon(
  'InsertToolIcon',
  <>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M8 12h8" />
    <path d="M12 8v8" />
  </>,
  { strokeWidth: 1.75 },
)
/** Component: rounded square with a diamond. */
export const ComponentIcon = createIcon(
  'ComponentIcon',
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M12 7.5 16.5 12 12 16.5 7.5 12z" />
  </>,
  { strokeWidth: 1.75 },
)
export const ImagePlusIcon = createIcon(
  'ImagePlusIcon',
  <>
    <path d="M16 5h6" />
    <path d="M19 2v6" />
    <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    <circle cx="9" cy="9" r="2" />
  </>,
  { strokeWidth: 1.75 },
)
/** "Tool / Generate": square with corner ticks. */
export const GenerateToolIcon = createIcon(
  'GenerateToolIcon',
  <>
    <rect x="5" y="5" width="14" height="14" />
    <path d="M3 5h2M5 3v2M19 3v2M19 5h2M3 19h2M5 19v2M19 19h2M19 19v2" />
  </>,
  { strokeWidth: 1.75 },
)
export const ImageIcon = createIcon(
  'ImageIcon',
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </>,
)

/* --- Layer type icons (06, 14) ------------------------------------------- */

/** Frame with vertical (column) flex: rows. */
export const FrameRowsIcon = createIcon(
  'FrameRowsIcon',
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M3 15h18" />
  </>,
)
/** Frame with horizontal (row) flex: columns. */
export const FrameColumnsIcon = createIcon(
  'FrameColumnsIcon',
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
    <path d="M15 3v18" />
  </>,
)
export const VectorIcon = createIcon(
  'VectorIcon',
  <>
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="5" r="2" />
    <path d="M5 17C5 10 10 5 17 5" />
  </>,
)
export const RectIcon = createIcon(
  'RectIcon',
  <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />,
)

/* --- Phase 3 layer and component glyphs (29–33) -------------------------- */

/** Group (lucide square-dashed): the group layer row (29). */
export const GroupIcon = createIcon(
  'GroupIcon',
  <>
    <path d="M5 3a2 2 0 0 0-2 2" />
    <path d="M19 3a2 2 0 0 1 2 2" />
    <path d="M21 19a2 2 0 0 1-2 2" />
    <path d="M5 21a2 2 0 0 1-2-2" />
    <path d="M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1" />
  </>,
)
/** Component instance (lucide diamond, outlined): instance rows, the Component section (31). */
export const InstanceIcon = createIcon(
  'InstanceIcon',
  <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />,
)
const FOUR_DIAMONDS = (
  <>
    <path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z" />
    <path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z" />
    <path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z" />
    <path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z" />
  </>
)
/**
 * Main component (lucide component, filled): main rows in Layers and Components (31, 32).
 * Stroked and filled with the current colour, as drawn in the rows.
 */
export const MainComponentIcon = createIcon('MainComponentIcon', FOUR_DIAMONDS)
/** The same glyph filled only (canvas labels, picker captions). */
export const MainComponentSolidIcon = createIcon('MainComponentSolidIcon', FOUR_DIAMONDS, {
  filled: true,
})
/** Stroke weight (three lines of growing width), Stroke section (30). */
export const StrokeWeightIcon = createIcon(
  'StrokeWeightIcon',
  <>
    <path d="M3 5h18" strokeWidth="1.5" />
    <path d="M3 11h18" strokeWidth="2.5" />
    <path d="M3 18.5h18" strokeWidth="4" />
  </>,
)
/** Reset (lucide rotate-ccw): "Reset overrides" (31). */
export const ResetIcon = createIcon(
  'ResetIcon',
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </>,
)
/** Unlink (lucide unlink): "Detach" (31). */
export const DetachIcon = createIcon(
  'DetachIcon',
  <>
    <path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
    <path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
    <path d="M8 2v3M2 8h3M16 19v3M19 16h3" />
  </>,
)

/* --- Inspector (06, 07, 14) ---------------------------------------------- */

export const MaximizeIcon = createIcon(
  'MaximizeIcon',
  <>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </>,
)
export const RotationIcon = createIcon(
  'RotationIcon',
  <>
    <path d="M4 20h16" />
    <path d="M4 20 16 6" />
  </>,
)
/** Layout row: duplicate/link size (two stacked squares). */
export const DuplicateIcon = createIcon(
  'DuplicateIcon',
  <>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M4 16V5a1 1 0 0 1 1-1h11" />
  </>,
)
export const FlipIcon = createIcon(
  'FlipIcon',
  <>
    <path d="M12 3v18" />
    <path d="M8 7 4 17h4z" />
    <path d="m16 7 4 10h-4z" />
  </>,
)
export const WrapIcon = createIcon(
  'WrapIcon',
  <>
    <path d="M3 6h18" />
    <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
    <path d="m16 16-2 2 2 2" />
    <path d="M3 18h7" />
  </>,
)
export const GapIcon = createIcon(
  'GapIcon',
  <>
    <path d="M4 6h16" />
    <path d="M4 18h16" />
    <path d="M9 12h6" />
  </>,
)

const paddingIcon = (name: string, side: string) =>
  createIcon(
    name,
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" stroke={SECONDARY} />
      <path d={side} strokeWidth={3} strokeLinecap="butt" />
    </>,
  )
/** Two-tone: the box uses --icon-secondary, the active side uses currentColor. */
export const PaddingLeftIcon = paddingIcon('PaddingLeftIcon', 'M4 4v16')
export const PaddingTopIcon = paddingIcon('PaddingTopIcon', 'M4 4h16')
export const PaddingRightIcon = paddingIcon('PaddingRightIcon', 'M20 4v16')
export const PaddingBottomIcon = paddingIcon('PaddingBottomIcon', 'M4 20h16')
export const PaddingIndividualIcon = createIcon(
  'PaddingIndividualIcon',
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <rect x="8" y="8" width="8" height="8" rx="1" />
  </>,
)
export const CornersIcon = createIcon(
  'CornersIcon',
  <>
    <path d="M3 9V5a2 2 0 0 1 2-2h4" />
    <path d="M15 3h4a2 2 0 0 1 2 2v4" />
    <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
    <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
  </>,
)
export const OpacityIcon = createIcon(
  'OpacityIcon',
  <>
    <rect x="3" y="3" width="4" height="4" />
    <rect x="11" y="3" width="4" height="4" />
    <rect x="7" y="7" width="4" height="4" />
    <rect x="15" y="7" width="4" height="4" />
    <rect x="3" y="11" width="4" height="4" />
    <rect x="11" y="11" width="4" height="4" />
    <rect x="7" y="15" width="4" height="4" />
    <rect x="15" y="15" width="4" height="4" />
  </>,
  { filled: true },
)
export const DropletIcon = createIcon(
  'DropletIcon',
  <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />,
)
/** Design tokens (four circles). */
export const TokensIcon = createIcon(
  'TokensIcon',
  <>
    <circle cx="7" cy="7" r="3" />
    <circle cx="17" cy="7" r="3" />
    <circle cx="7" cy="17" r="3" />
    <circle cx="17" cy="17" r="3" />
  </>,
)
export const PipetteIcon = createIcon(
  'PipetteIcon',
  <>
    <path d="m2 22 1-1h3l9-9" />
    <path d="M3 21v-3l9-9" />
    <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
  </>,
  { strokeWidth: 1.75 },
)
export const TargetIcon = createIcon(
  'TargetIcon',
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" />
  </>,
)
export const LineHeightIcon = createIcon(
  'LineHeightIcon',
  <>
    <path d="M4 4h16" />
    <path d="M4 20h16" />
    <path d="M12 8v8" />
  </>,
)
export const LetterSpacingIcon = createIcon(
  'LetterSpacingIcon',
  <>
    <path d="M4 4v16" />
    <path d="M20 4v16" />
    <path d="m9 16 3-8 3 8" />
  </>,
)
export const TextAlignLeftIcon = createIcon(
  'TextAlignLeftIcon',
  <>
    <path d="M3 6h18" />
    <path d="M3 12h12" />
    <path d="M3 18h15" />
  </>,
)
export const TextAlignCenterIcon = createIcon(
  'TextAlignCenterIcon',
  <>
    <path d="M3 6h18" />
    <path d="M6 12h12" />
    <path d="M4 18h16" />
  </>,
)
export const TextAlignRightIcon = createIcon(
  'TextAlignRightIcon',
  <>
    <path d="M3 6h18" />
    <path d="M9 12h12" />
    <path d="M6 18h15" />
  </>,
)
export const SlidersIcon = createIcon(
  'SlidersIcon',
  <>
    <path d="M4 7h10" />
    <path d="M18 7h2" />
    <path d="M4 17h2" />
    <path d="M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </>,
)

/* Phase 4 — MCP / agents (artboards 34–36). */

/** The agent sparkle (lucide sparkle, filled): agent avatars and the "… is working" badge. */
export const SPARKLE_PATH =
  'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'
export const SparkleIcon = createIcon('SparkleIcon', <path d={SPARKLE_PATH} />, { filled: true })
/** "MCP server" tile in the Connect dialog (lucide server). */
export const ServerIcon = createIcon(
  'ServerIcon',
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <path d="M6 6h.01" strokeWidth="2" />
    <path d="M6 18h.01" strokeWidth="2" />
  </>,
  { strokeWidth: 1.75 },
)
/** "Read layers, styles and tokens" (lucide layers). */
export const LayersIcon = createIcon(
  'LayersIcon',
  <>
    <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
    <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
    <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
  </>,
  { strokeWidth: 1.75 },
)
/** "Create artboards and edit layers" (lucide pen-line). */
export const PenLineIcon = createIcon(
  'PenLineIcon',
  <>
    <path d="M12 20h9" />
    <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
  </>,
  { strokeWidth: 1.75 },
)
/** "Undoes in one step" (lucide undo-2). */
export const Undo2Icon = createIcon(
  'Undo2Icon',
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
  </>,
  { strokeWidth: 1.75 },
)
