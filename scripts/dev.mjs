#!/usr/bin/env node
// One-command local setup: build the Rust core (napi addon) when it is missing, start the sync
// server (unless one already answers), wait for it, then run the desktop app in dev mode.
// Ctrl+C stops both; the server gets SIGTERM so it flushes and compacts open rooms.
//
//   pnpm dev:all
//
// Environment: BIND (server address, default 127.0.0.1:8787), VITE_SERVER_URL (what the app
// talks to, default http://<BIND>), plus any baren-server setting (DATABASE_URL, …).
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bind = process.env.BIND ?? '127.0.0.1:8787'
const serverUrl = process.env.VITE_SERVER_URL ?? `http://${bind}`
const children = new Set()

function log(message) {
  console.log(`\x1b[2m[dev]\x1b[0m ${message}`)
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function stopAll(code = 0) {
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 3000).unref()
  if (children.size === 0) process.exit(code)
}

async function serverUp() {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

// 1. Native core: the app falls back to a JS core without it, but dev should use the real one.
const hasAddon = readdirSync(join(root, 'crates/napi')).some((f) => f.endsWith('.node'))
if (!hasAddon) {
  log('building the Rust core (crates/napi) …')
  const built = spawnSync('pnpm', ['build:native'], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

// 2. Sync server.
if (await serverUp()) {
  log(`using the server already running at ${serverUrl}`)
} else {
  log(`starting baren-server on ${bind} (first build takes a minute) …`)
  const server = run('cargo', ['run', '-p', 'baren-server'], {
    env: { ...process.env, BIND: bind },
  })
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      log(`baren-server exited with ${code}`)
      stopAll(code)
    }
  })
  const deadline = Date.now() + 10 * 60_000
  while (!(await serverUp())) {
    if (Date.now() > deadline || server.exitCode !== null) {
      log('the server did not come up')
      stopAll(1)
      await new Promise(() => {}) // wait for the exit scheduled by stopAll
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  log(`server ready at ${serverUrl} — verification codes are printed in its log`)
}

// 3. Desktop app (electron-vite dev: renderer HMR, main/preload rebuild on change).
const app = run('pnpm', ['--filter', '@baren/desktop', 'dev'], {
  env: { ...process.env, VITE_SERVER_URL: serverUrl },
})
app.on('exit', (code) => stopAll(code ?? 0))

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
