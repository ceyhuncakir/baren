import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'

/**
 * Register the bundled Inter variable font under both "Inter" (what design
 * documents reference) and "Inter Variable" (what @fontsource registers), so
 * bench/e2e text renders with the real font instead of a fallback.
 */
export async function loadFonts(): Promise<void> {
  const faces = ['Inter', 'Inter Variable'].map(
    (family) =>
      new FontFace(family, `url(${interUrl}) format('woff2')`, {
        weight: '100 900',
        style: 'normal',
      }),
  )
  for (const f of faces) document.fonts.add(f)
  await Promise.all(faces.map((f) => f.load().catch(() => undefined)))
}
