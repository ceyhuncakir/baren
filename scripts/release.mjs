#!/usr/bin/env node
/**
 * pnpm release:linux [<version> | major | minor | patch] [options]
 *
 * Builds the Linux release of Baren — AppImage, deb and rpm plus latest-linux.yml
 * (electron-updater's feed metadata) — into apps/desktop/release/<version>/, then optionally
 * rsyncs them to the update server's UPDATES_DIR (served at <server>/updates/).
 *
 * Steps: version → native core (pnpm build:native) → electron-vite build (feed URL baked in) →
 * electron-builder --linux AppImage deb rpm --publish never → rsync (latest-linux.yml last, so
 * clients never see metadata for files that are not there yet).
 *
 * Arguments:
 *   <version>              set apps/desktop/package.json's version (semver), or bump it with
 *   major | minor | patch  (default: release the current version)
 *   --no-save              use that version for this build only (electron-builder extraMetadata);
 *                          package.json is left alone
 *   --targets <list>       comma-separated subset of AppImage,deb,rpm (default: all three)
 *   --skip-native          reuse the existing crates/napi/*.node instead of rebuilding it
 *   --out <dir>            output directory (default: apps/desktop/release/<version>)
 *   --feed <url>           update feed URL (default: VITE_UPDATE_URL, else <VITE_SERVER_URL>/updates/)
 *   --dry-run              print the plan, change nothing
 *
 * Environment:
 *   VITE_SERVER_URL   server the app talks to, baked in at build time (default http://127.0.0.1:8787)
 *   VITE_UPDATE_URL   update feed, baked in at build time (default <VITE_SERVER_URL>/updates/)
 *   RELEASE_TARGET    rsync destination, e.g. deploy@example.com:/srv/baren/updates/
 *
 * Installing updates: AppImages replace themselves. deb/rpm installs update through the system
 * package manager (dpkg/apt, dnf/zypper/yum/rpm), which electron-updater runs via pkexec: the user
 * gets a polkit password prompt when they click "Restart to update" (never on a plain quit).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = join(ROOT, 'apps', 'desktop')
const PACKAGE_JSON = join(DESKTOP, 'package.json')
const ALL_TARGETS = ['AppImage', 'deb', 'rpm']
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787'

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`\n▸ ${message}`)
}

/** Repo-relative when inside the repo, else absolute. */
function shown(path) {
  const rel = relative(ROOT, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    version: null,
    save: true,
    targets: ALL_TARGETS,
    skipNative: false,
    out: null,
    feed: null,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--no-save':
        opts.save = false
        break
      case '--targets':
        opts.targets = value()
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        break
      case '--skip-native':
        opts.skipNative = true
        break
      case '--out':
        opts.out = resolve(value())
        break
      case '--feed':
        opts.feed = value()
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--help':
      case '-h':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) fail(`unknown option ${arg}`)
        if (opts.version !== null) fail(`unexpected argument ${arg}`)
        opts.version = arg
    }
  }
  const unknown = opts.targets.filter((t) => !ALL_TARGETS.includes(t))
  if (unknown.length > 0 || opts.targets.length === 0) {
    fail(`--targets must be a subset of ${ALL_TARGETS.join(',')}`)
  }
  // AppImage must be packed first: the deb/rpm targets write resources/package-type into the
  // shared linux-unpacked directory, and an AppImage containing it would update like a deb/rpm.
  opts.targets = ALL_TARGETS.filter((t) => opts.targets.includes(t))
  return opts
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function nextVersion(current, request) {
  if (request === null) return current
  const m = SEMVER.exec(current)
  if (['major', 'minor', 'patch'].includes(request)) {
    if (!m) fail(`current version ${current} is not semver`)
    const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (request === 'major') return `${major + 1}.0.0`
    if (request === 'minor') return `${major}.${minor + 1}.0`
    // A prerelease (1.2.3-beta.1) is released as 1.2.3.
    return m[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
  }
  const v = request.replace(/^v/, '')
  if (!SEMVER.test(v)) fail(`${request} is not a semver version (or major|minor|patch)`)
  return v
}

// ---------------------------------------------------------------------------
// Feed URL (mirrors apps/desktop/src/main/updates/feed.ts)
// ---------------------------------------------------------------------------

function httpUrl(value, what) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${what} is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    fail(`${what} must be http(s): ${value}`)
  if (url.username || url.password) fail(`${what} must not contain credentials`)
  url.search = ''
  url.hash = ''
  return url
}

export function feedUrl({ feed, updateUrl, serverUrl }) {
  const explicit = feed?.trim() || updateUrl?.trim()
  if (explicit) {
    const url = httpUrl(explicit, 'the update feed')
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.toString()
  }
  const url = httpUrl(serverUrl?.trim() || DEFAULT_SERVER_URL, 'VITE_SERVER_URL')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/updates/`
  return url.toString()
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function run(command, args, { cwd = ROOT, env = process.env, dryRun = false } = {}) {
  const line = [command, ...args].join(' ')
  console.log(`  $ ${line}${cwd === ROOT ? '' : `   (in ${shown(cwd)})`}`)
  if (dryRun) return
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`${line} exited with ${result.status ?? result.signal}`)
}

function hasCommand(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

/** The files a release consists of, in upload order (metadata last). */
function releaseFiles(outDir, version) {
  const names = readdirSync(outDir)
  const ours = names.filter(
    (n) => n.includes(version) && /\.(AppImage|deb|rpm|blockmap)$/.test(n) && !n.startsWith('.'),
  )
  if (!names.includes('latest-linux.yml')) fail(`no latest-linux.yml in ${outDir}`)
  return [...ours.sort(), 'latest-linux.yml'].map((n) => join(outDir, n))
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const version = nextVersion(pkg.version, opts.version)
  const feed = feedUrl({
    feed: opts.feed,
    updateUrl: process.env.VITE_UPDATE_URL,
    serverUrl: process.env.VITE_SERVER_URL,
  })
  const outDir = opts.out ?? join(DESKTOP, 'release', version)
  const target = process.env.RELEASE_TARGET?.trim() || null

  console.log('Baren Linux release')
  console.log(
    `  version   ${version}${version === pkg.version ? '' : ` (was ${pkg.version}${opts.save ? '' : ', not saved'})`}`,
  )
  console.log(
    `  server    ${process.env.VITE_SERVER_URL || `${DEFAULT_SERVER_URL} (VITE_SERVER_URL unset)`}`,
  )
  console.log(`  feed      ${feed}`)
  console.log(`  targets   ${opts.targets.join(', ')}`)
  console.log(`  output    ${shown(outDir)}`)
  console.log(`  upload    ${target ?? '(RELEASE_TARGET unset: no upload)'}`)
  if (!process.env.VITE_SERVER_URL) {
    console.warn('  warning   VITE_SERVER_URL is unset: this build talks to a local server only')
  }
  if (process.platform !== 'linux') fail('Linux releases must be built on Linux')
  if (opts.targets.includes('rpm') && !hasCommand('rpmbuild')) {
    fail('the rpm target needs rpmbuild (Fedora: dnf install rpm-build; Debian: apt install rpm)')
  }
  if (target && !hasCommand('rsync')) fail('RELEASE_TARGET is set but rsync is not installed')

  if (version !== pkg.version && opts.save) {
    log(`version ${pkg.version} → ${version} (apps/desktop/package.json)`)
    if (!opts.dryRun) {
      pkg.version = version
      writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`)
    }
  }

  if (opts.skipNative) {
    log('native core: reusing crates/napi/*.node (--skip-native)')
    const addon = readdirSync(join(ROOT, 'crates', 'napi')).filter((n) => n.endsWith('.node'))
    if (addon.length === 0)
      console.warn('  warning   no native addon: the release will use the JS core')
  } else {
    log('native core')
    run('pnpm', ['build:native'], { dryRun: opts.dryRun })
  }

  const buildEnv = { ...process.env, VITE_UPDATE_URL: feed }
  log('app bundle (electron-vite)')
  run('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: DESKTOP,
    env: buildEnv,
    dryRun: opts.dryRun,
  })

  log(`packages (electron-builder: ${opts.targets.join(', ')})`)
  const builderArgs = [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.yml',
    '--linux',
    ...opts.targets,
    '--publish',
    'never',
    `-c.directories.output=${isAbsolute(outDir) ? outDir : resolve(outDir)}`,
    '-c.publish.provider=generic',
    `-c.publish.url=${feed}`,
  ]
  if (version !== pkg.version && !opts.save) builderArgs.push(`-c.extraMetadata.version=${version}`)
  run('pnpm', builderArgs, { cwd: DESKTOP, env: buildEnv, dryRun: opts.dryRun })

  if (opts.dryRun) {
    log('dry run: nothing was built')
    return
  }

  const files = releaseFiles(outDir, version)
  const meta = readFileSync(join(outDir, 'latest-linux.yml'), 'utf8')
  if (!meta.includes(`version: ${version}`))
    fail(`latest-linux.yml is not for ${version}:\n${meta}`)
  const updateConfig = join(outDir, 'linux-unpacked', 'resources', 'app-update.yml')
  log('release files')
  for (const f of files) console.log(`  ${shown(f)}`)
  if (existsSync(updateConfig)) {
    console.log(
      `  app-update.yml: ${readFileSync(updateConfig, 'utf8').trim().replace(/\n/g, ' | ')}`,
    )
  }

  if (target) {
    const dest = target.endsWith('/') ? target : `${target}/`
    log(`upload → ${dest}`)
    const packages = files.filter((f) => !f.endsWith('latest-linux.yml'))
    run('rsync', ['-av', '--partial', '--chmod=F644', ...packages, dest])
    run('rsync', ['-av', '--chmod=F644', join(outDir, 'latest-linux.yml'), dest])
  }
  log(`done: ${version}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
