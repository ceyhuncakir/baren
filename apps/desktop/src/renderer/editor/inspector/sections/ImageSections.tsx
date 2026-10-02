/**
 * Image controls (artboard 24): the Fill section's Image tab for frames/rectangles with an
 * image fill, and the Image section for image layers. Both show a preview, the file name
 * with the natural size, the fit mode, and Replace plus Remove / Reset size.
 */
import { assetCssUrl, type DesignNode, type StylePatch, type Styles } from '@baren/schema'
import { Lucide, MaximizeIcon, NumberField, OpacityIcon, InspectorSection, toast } from '@baren/ui'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { assetCss, loadAssetUrl, subscribeAssets } from '../../../lib/assets'
import { pickImageAsset } from '../../images/insert'
import { patchStylesAndProps } from '../../model/docOps'
import { removeFillPatch, readFill } from '../../model/effects'
import {
  IMAGE_FILL_MODES,
  OBJECT_FIT_MODES,
  imageModePatch,
  imageOpacityPatch,
  naturalSizePatch,
  objectFitOf,
  readImageFill,
  setImageFillPatch,
  styleBox,
  type ImageFillMode,
  type ObjectFitMode,
  type Size,
} from '../../model/imageFill'
import { common, MIXED } from '../../model/styles'
import { useEditor } from '../../session/context'
import type { NodesSnapshot } from '../../session/docEvents'
import { MenuSelect } from '../controls'
import { useStyleEdit } from '../hooks'
import css from '../Inspector.module.css'

// ---------------------------------------------------------------------------
// Natural sizes (decoded off the main thread by the browser; cached per asset)
// ---------------------------------------------------------------------------

const sizes = new Map<string, Promise<Size | null>>()

function naturalSize(assetId: string): Promise<Size | null> {
  let p = sizes.get(assetId)
  if (!p) {
    p = loadAssetUrl(assetId).then(async (url) => {
      if (!url) return null
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      try {
        await img.decode()
        return { width: img.naturalWidth, height: img.naturalHeight }
      } catch {
        return null
      }
    })
    sizes.set(assetId, p)
    // Missing now, maybe downloaded later: do not cache the failure.
    void p.then((s) => {
      if (!s) sizes.delete(assetId)
    })
  }
  return p
}

let assetVersion = 0
const versionListeners = new Set<() => void>()
subscribeAssets((hashes) => {
  for (const h of hashes) sizes.delete(h)
  assetVersion++
  for (const l of versionListeners) l()
})

/** Re-render when asset bytes arrive (previews in browser mode, downloads). */
function useAssetVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      versionListeners.add(cb)
      return () => versionListeners.delete(cb)
    },
    () => assetVersion,
  )
}

function useNaturalSize(assetId: string | null): Size | null {
  const version = useAssetVersion()
  const [size, setSize] = useState<{ id: string; size: Size | null } | null>(null)
  useEffect(() => {
    if (!assetId) return
    let live = true
    void naturalSize(assetId).then((s) => {
      if (live) setSize({ id: assetId, size: s })
    })
    return () => {
      live = false
    }
  }, [assetId, version])
  return assetId && size?.id === assetId ? size.size : null
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

function ImagePreview({ assetId, fit }: { assetId: string | null; fit: 'cover' | 'contain' }) {
  useAssetVersion()
  const image = assetId ? assetCss(assetCssUrl(assetId)) : 'none'
  return (
    <div className={css.imagePreview} data-testid="image-preview">
      <div
        className={css.imagePreviewImage}
        style={{ backgroundImage: image, backgroundSize: fit }}
      />
    </div>
  )
}

function ImageMeta({ name, size }: { name: string; size: Size | null }) {
  return (
    <div className={css.imageMeta}>
      <span className={css.imageName} title={name}>
        {name}
      </span>
      {size && (
        <span className={css.imageSize}>
          {size.width} × {size.height}
        </span>
      )}
    </div>
  )
}

function ImageButton({
  icon,
  children,
  onClick,
  primary = false,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      className={primary ? css.imageButtonWide : css.imageButton}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}

const uploadIcon = <Lucide.Upload size={11} strokeWidth={2} aria-hidden />
const trashIcon = <Lucide.Trash size={11} strokeWidth={2} aria-hidden />
const resetIcon = <Lucide.Scaling size={11} strokeWidth={2} aria-hidden />

function displayName(node: DesignNode | undefined, fallback: string): string {
  return node?.assetName || fallback
}

// ---------------------------------------------------------------------------
// Fill section → Image tab
// ---------------------------------------------------------------------------

/** Body of the Fill section when the fill is an image (rendered under the type row). */
export function ImageFillBody({ snapshot }: { snapshot: NodesSnapshot }) {
  const { doc, canvas } = useEditor()
  const edit = useStyleEdit()
  const nodes = snapshot.nodes
  const fills = nodes.map((n) => readImageFill(n.styles))
  const first = fills.find((f) => f !== null) ?? null
  const firstNode = nodes[fills.indexOf(first)]
  const natural = useNaturalSize(first?.assetId ?? null)
  const mode = common(fills.map((f) => f?.mode ?? 'fill'))
  const opacity = common(fills.map((f) => Math.round((f?.opacity ?? 1) * 100)))
  const ids = nodes.map((n) => n.id)

  const boxOf = (styles: Styles, id: string): Size | null =>
    styleBox(styles) ?? canvas.current?.getNodeBounds(id) ?? null

  const setMode = (m: ImageFillMode) =>
    edit((styles, id) =>
      readImageFill(styles) ? imageModePatch(m, natural, boxOf(styles, id)) : null,
    )

  const replace = async () => {
    const picked = await pickImageAsset()
    if (!picked) return
    patchStylesAndProps(
      doc,
      ids,
      (styles, id) => setImageFillPatch(styles, picked.assetId, picked.size, boxOf(styles, id)),
      { assetName: picked.fileName },
    )
  }

  const remove = () =>
    patchStylesAndProps(
      doc,
      ids,
      (styles: Styles, id: string): StylePatch | null => {
        const type = nodes.find((n) => n.id === id)?.type ?? 'frame'
        const f = readFill(styles, type)
        return f?.kind === 'image' ? removeFillPatch(f) : null
      },
      { assetName: null },
    )

  return (
    <>
      <ImagePreview assetId={first?.assetId ?? null} fit="cover" />
      <ImageMeta name={displayName(firstNode, 'Image')} size={natural} />
      <div className={css.imageRow}>
        <MenuSelect<ImageFillMode>
          className={css.imageFit}
          prefix={<MaximizeIcon size={11} />}
          value={mode === MIXED ? MIXED : (mode ?? 'fill')}
          options={IMAGE_FILL_MODES}
          onChange={setMode}
          menuWidth={160}
          aria-label="Image fit"
        />
        <NumberField
          prefix={<OpacityIcon size={11} />}
          value={opacity === MIXED || opacity === undefined ? null : opacity}
          unit="%"
          min={0}
          max={100}
          width={84}
          onChange={(v, m) => edit((styles) => imageOpacityPatch(styles, v / 100), m.final)}
          aria-label="Image opacity"
        />
      </div>
      <div className={css.imageRow}>
        <ImageButton primary icon={uploadIcon} onClick={() => void replace()}>
          Replace
        </ImageButton>
        <ImageButton icon={trashIcon} onClick={remove}>
          Remove
        </ImageButton>
      </div>
    </>
  )
}

/** First image for a fill (the Image tab was chosen): pick a file, then apply it. */
export async function chooseImageFill(
  session: ReturnType<typeof useEditor>,
  ids: readonly string[],
): Promise<void> {
  const picked = await pickImageAsset()
  if (!picked) return
  const { doc, canvas } = session
  patchStylesAndProps(
    doc,
    ids,
    (styles, id) =>
      setImageFillPatch(
        styles,
        picked.assetId,
        picked.size,
        styleBox(styles) ?? canvas.current?.getNodeBounds(id) ?? null,
      ),
    { assetName: picked.fileName },
  )
}

// ---------------------------------------------------------------------------
// Image layers
// ---------------------------------------------------------------------------

export function ImageLayerSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const { doc } = useEditor()
  const edit = useStyleEdit()
  const nodes = snapshot.nodes.filter((n) => n.type === 'image')
  const first = nodes[0]
  const natural = useNaturalSize(first?.assetId ?? null)
  const fit = common(nodes.map((n) => objectFitOf(n.styles)))
  const ids = nodes.map((n) => n.id)
  if (!first) return null

  const replace = async () => {
    const picked = await pickImageAsset()
    if (!picked) return
    patchStylesAndProps(doc, ids, () => null, {
      assetId: picked.assetId,
      assetName: picked.fileName,
    })
  }

  const resetSize = async () => {
    const results = await Promise.all(nodes.map((n) => (n.assetId ? naturalSize(n.assetId) : null)))
    if (results.every((r) => !r)) {
      toast("The image's size isn't available yet.")
      return
    }
    edit((_styles, id) => {
      const s = results[nodes.findIndex((n) => n.id === id)]
      return s ? naturalSizePatch(s) : null
    })
  }

  return (
    <InspectorSection title="Image">
      <ImagePreview
        assetId={first.assetId ?? null}
        fit={fit === 'contain' || fit === 'none' ? 'contain' : 'cover'}
      />
      <ImageMeta name={displayName(first, first.name || 'Image')} size={natural} />
      <div className={css.imageRow}>
        <MenuSelect<ObjectFitMode>
          className={css.imageFit}
          prefix={<MaximizeIcon size={11} />}
          value={fit === MIXED ? MIXED : (fit ?? 'fill')}
          options={OBJECT_FIT_MODES}
          onChange={(m) => edit(() => ({ objectFit: m }))}
          menuWidth={160}
          aria-label="Image fit"
        />
      </div>
      <div className={css.imageRow}>
        <ImageButton primary icon={uploadIcon} onClick={() => void replace()}>
          Replace
        </ImageButton>
        <ImageButton icon={resetIcon} onClick={() => void resetSize()}>
          Reset size
        </ImageButton>
      </div>
    </InspectorSection>
  )
}
