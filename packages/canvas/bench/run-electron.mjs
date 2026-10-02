// Runs the canvas bench inside Electron (real GPU raster/compositing, hidden window):
//   pnpm --filter @baren/canvas bench:electron [20k] [50k] [overlay]
// Builds the bench, serves it with `vite preview`, runs each mode and prints a table.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('..', import.meta.url))
const modes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['20k', '50k', 'overlay']
const port = 5184
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', ...opts })

if (
  run('pnpm', ['exec', 'vite', 'build', '--config', 'bench/vite.config.ts'], { stdio: 'inherit' })
    .status !== 0
)
  process.exit(1)
const server = spawn(
  'pnpm',
  [
    'exec',
    'vite',
    'preview',
    '--config',
    'bench/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: dir, stdio: 'ignore', detached: true },
)
await new Promise((r) => setTimeout(r, 1500))
try {
  for (const mode of modes) {
    const res = run('pnpm', ['exec', 'electron', 'bench/electron-main.cjs'], {
      env: { ...process.env, BENCH_MODE: mode, BENCH_URL: `http://127.0.0.1:${port}` },
      timeout: 240_000,
    })
    const out = res.stdout ?? ''
    const gpu = out.split('\n').find((l) => l.startsWith('GPU '))
    const line = out.split('\n').find((l) => l.startsWith('RESULT '))
    console.log(`\n== ${mode} (${gpu ?? 'GPU unknown'})`)
    if (/tile memory limits exceeded/.test(`${out}${res.stderr ?? ''}`))
      console.log('WARNING: Chromium reported tile memory limits exceeded')
    if (!line) {
      console.log(out, res.stderr)
      continue
    }
    const r = JSON.parse(line.slice('RESULT '.length))
    if (mode === 'overlay') {
      for (const x of r)
        console.log(`${x.impl.padEnd(9)} work p50 ${x.workP50} ms  p95 ${x.workP95} ms`)
      continue
    }
    console.log(`${r.nodes} nodes — generate ${r.generateMs} ms, first frame ${r.firstFrameMs} ms`)
    console.log(
      'phase'.padEnd(20),
      'kind'.padEnd(8),
      'work p50/p95/max'.padEnd(20),
      'interval p50/p95'.padEnd(18),
      'long',
      'live',
    )
    for (const p of r.phases) {
      console.log(
        p.name.padEnd(20),
        p.kind.padEnd(8),
        `${p.workP50}/${p.workP95}/${p.workMax}`.padEnd(20),
        `${p.intervalP50}/${p.intervalP95}`.padEnd(18),
        String(p.longTasks).padEnd(4),
        p.mountedNodes,
      )
    }
  }
} finally {
  try {
    process.kill(-server.pid)
  } catch {
    server.kill()
  }
}
