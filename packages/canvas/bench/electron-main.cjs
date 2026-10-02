// Electron entry for `pnpm --filter @baren/canvas bench:electron` (see run-electron.mjs).
// Runs one bench page in a hidden window with the real GPU (vsync and frame-rate limit off)
// and prints `RESULT <json>` on stdout.
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('disable-frame-rate-limit')

const base = process.env.BENCH_URL || 'http://127.0.0.1:5183'
const mode = process.env.BENCH_MODE || '20k'

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  })
  const url =
    mode === 'overlay' ? `${base}/overlay.html` : `${base}/index.html?preset=${mode}&hud=0`
  await win.loadURL(url)
  const gpu = await win.webContents.executeJavaScript(
    `(() => { const gl = document.createElement('canvas').getContext('webgl'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl ? gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null })()`,
  )
  console.log(`GPU ${gpu}`)
  const script =
    mode === 'overlay'
      ? 'new Promise((r) => { const w = () => (window.__overlayCompare ? r(window.__overlayCompare.run()) : setTimeout(w, 50)); w() })'
      : 'new Promise((r) => { const w = () => (window.__bench ? window.__bench.ready.then(() => r(window.__bench.run())) : setTimeout(w, 50)); w() })'
  const timer = setTimeout(() => {
    console.log('TIMEOUT')
    app.exit(1)
  }, 180_000)
  try {
    console.log(`RESULT ${JSON.stringify(await win.webContents.executeJavaScript(script))}`)
  } catch (err) {
    console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`)
  }
  clearTimeout(timer)
  app.quit()
})
