/**
 * Static CSS knowledge: the property names write_html accepts (camelCase), the unitless list
 * (a copy of `packages/schema/src/html.ts` `UNITLESS`, checked by a parity test) and the
 * inherited text properties carried by snippet roots.
 */

const words = (s: string): string[] => s.trim().split(/\s+/)

/**
 * camelCase CSS properties (standard, plus the SVG paint properties). Vendor-prefixed forms
 * (`WebkitX`, `MozX`, `msX`) of a known property are accepted too (see `isKnownProperty`).
 */
export const KNOWN_CSS_PROPERTIES: ReadonlySet<string> = new Set(
  words(`
  accentColor alignContent alignItems alignSelf alignmentBaseline all animation animationComposition
  animationDelay animationDirection animationDuration animationFillMode animationIterationCount
  animationName animationPlayState animationTimingFunction appearance aspectRatio backdropFilter
  backfaceVisibility background backgroundAttachment backgroundBlendMode backgroundClip
  backgroundColor backgroundImage backgroundOrigin backgroundPosition backgroundPositionX
  backgroundPositionY backgroundRepeat backgroundSize baselineShift blockSize border borderBlock
  borderBlockColor borderBlockEnd borderBlockEndColor borderBlockEndStyle borderBlockEndWidth
  borderBlockStart borderBlockStartColor borderBlockStartStyle borderBlockStartWidth borderBlockStyle
  borderBlockWidth borderBottom borderBottomColor borderBottomLeftRadius borderBottomRightRadius
  borderBottomStyle borderBottomWidth borderCollapse borderColor borderEndEndRadius
  borderEndStartRadius borderImage borderImageOutset borderImageRepeat borderImageSlice
  borderImageSource borderImageWidth borderInline borderInlineColor borderInlineEnd
  borderInlineEndColor borderInlineEndStyle borderInlineEndWidth borderInlineStart
  borderInlineStartColor borderInlineStartStyle borderInlineStartWidth borderInlineStyle
  borderInlineWidth borderLeft borderLeftColor borderLeftStyle borderLeftWidth borderRadius
  borderRight borderRightColor borderRightStyle borderRightWidth borderSpacing borderStartEndRadius
  borderStartStartRadius borderStyle borderTop borderTopColor borderTopLeftRadius
  borderTopRightRadius borderTopStyle borderTopWidth borderWidth bottom boxDecorationBreak boxShadow
  boxSizing breakAfter breakBefore breakInside captionSide caretColor clear clip clipPath clipRule
  color colorInterpolation colorInterpolationFilters colorScheme columnCount columnFill columnGap
  columnRule columnRuleColor columnRuleStyle columnRuleWidth columnSpan columnWidth columns contain
  containIntrinsicSize container containerName containerType content contentVisibility
  counterIncrement counterReset counterSet cursor cx cy d direction display dominantBaseline
  emptyCells fill fillOpacity fillRule filter flex flexBasis flexDirection flexFlow flexGrow
  flexShrink flexWrap float floodColor floodOpacity font fontFamily fontFeatureSettings fontKerning
  fontOpticalSizing fontPalette fontSize fontSizeAdjust fontStretch fontStyle fontSynthesis
  fontVariant fontVariantCaps fontVariantEastAsian fontVariantLigatures fontVariantNumeric
  fontVariationSettings fontWeight forcedColorAdjust gap grid gridArea gridAutoColumns gridAutoFlow
  gridAutoRows gridColumn gridColumnEnd gridColumnGap gridColumnStart gridGap gridRow gridRowEnd
  gridRowGap gridRowStart gridTemplate gridTemplateAreas gridTemplateColumns gridTemplateRows
  hangingPunctuation height hyphenateCharacter hyphens imageOrientation imageRendering
  initialLetter inlineSize inset insetBlock insetBlockEnd insetBlockStart insetInline insetInlineEnd
  insetInlineStart isolation justifyContent justifyItems justifySelf left letterSpacing lightingColor
  lineBreak lineClamp lineHeight listStyle listStyleImage listStylePosition listStyleType margin
  marginBlock marginBlockEnd marginBlockStart marginBottom marginInline marginInlineEnd
  marginInlineStart marginLeft marginRight marginTop marker markerEnd markerMid markerStart mask
  maskBorder maskClip maskComposite maskImage maskMode maskOrigin maskPosition maskRepeat maskSize
  maskType maxBlockSize maxHeight maxInlineSize maxWidth minBlockSize minHeight minInlineSize
  minWidth mixBlendMode objectFit objectPosition offset offsetAnchor offsetDistance offsetPath
  offsetPosition offsetRotate opacity order orphans outline outlineColor outlineOffset outlineStyle
  outlineWidth overflow overflowAnchor overflowClipMargin overflowWrap overflowX overflowY
  overscrollBehavior overscrollBehaviorX overscrollBehaviorY padding paddingBlock paddingBlockEnd
  paddingBlockStart paddingBottom paddingInline paddingInlineEnd paddingInlineStart paddingLeft
  paddingRight paddingTop pageBreakAfter pageBreakBefore pageBreakInside paintOrder perspective
  perspectiveOrigin placeContent placeItems placeSelf pointerEvents position quotes r resize right
  rotate rowGap rubyAlign rubyPosition rx ry scale scrollBehavior scrollMargin scrollMarginBlock
  scrollMarginBottom scrollMarginInline scrollMarginLeft scrollMarginRight scrollMarginTop
  scrollPadding scrollPaddingBlock scrollPaddingBottom scrollPaddingInline scrollPaddingLeft
  scrollPaddingRight scrollPaddingTop scrollSnapAlign scrollSnapStop scrollSnapType scrollbarColor
  scrollbarGutter scrollbarWidth shapeImageThreshold shapeMargin shapeOutside shapeRendering
  stopColor stopOpacity stroke strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin
  strokeMiterlimit strokeOpacity strokeWidth tabSize tableLayout textAlign textAlignLast textAnchor
  textCombineUpright textDecoration textDecorationColor textDecorationLine textDecorationSkipInk
  textDecorationStyle textDecorationThickness textEmphasis textEmphasisColor textEmphasisPosition
  textEmphasisStyle textIndent textJustify textOrientation textOverflow textRendering textShadow
  textTransform textUnderlineOffset textUnderlinePosition textWrap textWrapMode textWrapStyle top
  touchAction transform transformBox transformOrigin transformStyle transition transitionBehavior
  transitionDelay transitionDuration transitionProperty transitionTimingFunction translate
  unicodeBidi userSelect vectorEffect verticalAlign visibility whiteSpace whiteSpaceCollapse widows
  width willChange wordBreak wordSpacing wordWrap writingMode x y zIndex zoom
  boxOrient lineClamp fontSmooth textFillColor textStroke textStrokeColor textStrokeWidth
  fontSmoothing osxFontSmoothing userDrag tapHighlightColor
`),
)

const VENDOR_PREFIXES = ['Webkit', 'Moz', 'ms', 'O'] as const

/** The unprefixed camelCase name of a vendor-prefixed key (`WebkitLineClamp` → `lineClamp`). */
export function unprefixed(key: string): string {
  for (const prefix of VENDOR_PREFIXES) {
    if (key.startsWith(prefix) && /^[A-Z]/.test(key.slice(prefix.length))) {
      const rest = key.slice(prefix.length)
      return (rest[0] as string).toLowerCase() + rest.slice(1)
    }
  }
  return key
}

export function isKnownProperty(key: string): boolean {
  if (key.startsWith('--')) return true
  return KNOWN_CSS_PROPERTIES.has(key) || KNOWN_CSS_PROPERTIES.has(unprefixed(key))
}

/** Copy of the schema exporter's `UNITLESS` (parity-tested against `cssDeclarationValue`). */
export const UNITLESS: ReadonlySet<string> = new Set(
  words(`
  animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex
  boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink
  flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn
  gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order
  orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray
  strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth
`),
)

/** Same rule as the schema exporter: custom properties and the unitless list (prefixes too). */
export function isUnitless(key: string): boolean {
  if (key.startsWith('--')) return true
  for (const prefix of VENDOR_PREFIXES) {
    if (key.startsWith(prefix) && /^[A-Z]/.test(key.slice(prefix.length))) {
      const r = key.slice(prefix.length)
      return UNITLESS.has((r[0] as string).toLowerCase() + r.slice(1))
    }
  }
  return UNITLESS.has(key)
}

/** Text properties a snippet root inherits from its ancestors (contract §8.1). */
export const INHERITED_TEXT_PROPERTIES: readonly string[] = [
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
]
