#!/usr/bin/env node
/**
 * pnpm release:linux | release:win | release:mac  [<version> | major | minor | patch] [options]
 *
 * Builds a release of Baren into apps/desktop/release/<version>/, then optionally rsyncs it to
 * the update server's UPDATES_DIR (served at <server>/updates/, which also makes it a download
 * link for new users):
 *
 *   linux  AppImage, deb and rpm + latest-linux.yml        (updates itself)
 *   win    baren-setup-<version>.exe + latest.yml           (per-user NSIS installer, updates itself)
 *   mac    baren-<version>-mac-arm64.zip and -x64.zip       (ad-hoc signed: no auto-update)
 *
 * Steps: version → native core → electron-vite build (server and feed URL baked in) →
 * electron-builder --publish never → rsync (update metadata last, so clients never see it for
 * files that are not there yet).
 *
 * All three are built on Linux. The Windows and macOS cores are cross-compiled in Docker
 * (rust:1-bookworm with MinGW; ghcr.io/rust-cross/cargo-zigbuild with clang, Rust's ld64.lld
 * and its macOS SDK). The Windows installer is packed with system wine when installed, else in
 * electronuserland/builder:wine. The Mac app is signed ad hoc with rcodesign (on PATH or
 * $RCODESIGN; https://github.com/indygreg/apple-platform-rs) and zipped with `zip -y`, which
 * keeps the frameworks' symlinks.
 *
 * Arguments:
 *   <version>              set apps/desktop/package.json's version (semver), or bump it with
 *   major | minor | patch  (default: release the current version)
 *   --platform <p>         linux (default), win or mac (the release:* scripts set it)
 *   --no-save              use that version for this build only (electron-builder extraMetadata);
 *                          package.json is left alone
 *   --targets <list>       Linux only: comma-separated subset of AppImage,deb,rpm (default: all)
 *   --skip-native          reuse the existing crates/napi/*.node instead of rebuilding it
 *   --out <dir>            output directory (default: apps/desktop/release/<version>)
 *   --feed <url>           update feed URL (default: VITE_UPDATE_URL, else <VITE_SERVER_URL>/updates/)
 *   --dry-run              print the plan, change nothing
 *
 * Environment (also read from apps/desktop/.env and .env.local, like the app build):
 *   VITE_SERVER_URL   server the app talks to, baked in at build time (default http://127.0.0.1:8787)
 *   VITE_UPDATE_URL   update feed, baked in at build time (default <VITE_SERVER_URL>/updates/)
 *   RELEASE_TARGET    rsync destination, e.g. deploy@example.com:/srv/baren/updates/
 *
 * Installing updates: AppImages replace themselves, and so does the Windows install (per user, no
 * admin rights). deb/rpm installs update through the system package manager (dpkg/apt,
 * dnf/zypper/yum/rpm), which electron-updater runs via pkexec: the user gets a polkit password
 * prompt when they click "Restart to update" (never on a plain quit).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = join(ROOT, 'apps', 'desktop')
const NAPI = join(ROOT, 'crates', 'napi')
const PACKAGE_JSON = join(DESKTOP, 'package.json')
const PLATFORMS = ['linux', 'win', 'mac']
const LINUX_TARGETS = ['AppImage', 'deb', 'rpm']
const MAC_ARCHS = [
  { arch: 'arm64', rust: 'aarch64', dir: 'mac-arm64' },
  { arch: 'x64', rust: 'x86_64', dir: 'mac' },
]
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787'
const IMAGES = {
  rust: 'rust:1-bookworm',
  zigbuild: 'ghcr.io/rust-cross/cargo-zigbuild:latest',
  wine: 'electronuserland/builder:wine',
}

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
    platform: 'linux',
    save: true,
    targets: null,
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
      case '--platform':
        opts.platform = value()
        break
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
  if (!PLATFORMS.includes(opts.platform)) fail(`--platform must be one of ${PLATFORMS.join(', ')}`)
  if (opts.platform !== 'linux') {
    if (opts.targets) fail('--targets is for Linux releases only')
    return opts
  }
  const targets = opts.targets ?? LINUX_TARGETS
  const unknown = targets.filter((t) => !LINUX_TARGETS.includes(t))
  if (unknown.length > 0 || targets.length === 0) {
    fail(`--targets must be a subset of ${LINUX_TARGETS.join(',')}`)
  }
  // AppImage must be packed first: the deb/rpm targets write resources/package-type into the
  // shared linux-unpacked directory, and an AppImage containing it would update like a deb/rpm.
  opts.targets = LINUX_TARGETS.filter((t) => targets.includes(t))
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
// Environment and feed URL (mirrors apps/desktop/src/main/updates/feed.ts)
// ---------------------------------------------------------------------------

/** `KEY=value` lines of a dotenv file (no expansion), or {} when it does not exist. */
function readDotenv(path) {
  if (!existsSync(path)) return {}
  const vars = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return vars
}

/** VITE_* settings as the app build sees them: the environment wins over .env.local over .env. */
function viteEnv() {
  const files = { ...readDotenv(join(DESKTOP, '.env')), ...readDotenv(join(DESKTOP, '.env.local')) }
  const pick = (key) => process.env[key] ?? files[key]
  return { serverUrl: pick('VITE_SERVER_URL'), updateUrl: pick('VITE_UPDATE_URL') }
}

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
  console.log(
    `  $ ${line.length > 400 ? `${line.slice(0, 400)} …` : line}${cwd === ROOT ? '' : `   (in ${shown(cwd)})`}`,
  )
  if (dryRun) return
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} exited with ${result.status ?? result.signal}`)
}

function hasCommand(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

/** `docker run` as root on the repo (same path inside), handing files back to the caller. */
function docker(image, script, { dryRun, targetDir, extraArgs = [] }) {
  const owner = `${process.getuid()}:${process.getgid()}`
  run(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${ROOT}:${ROOT}`,
      '-w',
      ROOT,
      '-e',
      `CARGO_TARGET_DIR=${join(ROOT, 'target', 'cross', targetDir)}`,
      '-e',
      `CARGO_HOME_CACHE=${join(ROOT, 'target', 'cross', 'cargo-registry')}`,
      ...extraArgs,
      image,
      'bash',
      '-c',
      `set -euo pipefail
REGISTRY="\${CARGO_HOME:-/usr/local/cargo}/registry"
mkdir -p "$CARGO_HOME_CACHE" && rm -rf "$REGISTRY" && ln -s "$CARGO_HOME_CACHE" "$REGISTRY"
trap 'chown -R ${owner} "${join(ROOT, 'target', 'cross')}" "${NAPI}"' EXIT
${script}`,
    ],
    { dryRun },
  )
}

/** The Windows core, cross-compiled with MinGW → crates/napi/baren-core.win32-x64-gnu.node. */
function buildWindowsCore(dryRun) {
  // napi-build requires some libnode.dll to link GNU builds against; with napi's dyn-symbols
  // (crates/napi/Cargo.toml) nothing references it, and the core finds N-API in Electron at runtime.
  docker(
    IMAGES.rust,
    `apt-get update -qq >/dev/null && apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null
rustup target add x86_64-pc-windows-gnu >/dev/null 2>&1
mkdir -p /tmp/stub && echo 'void baren_libnode_stub(void) {}' > /tmp/stub/s.c
x86_64-w64-mingw32-gcc -shared -o /tmp/stub/libnode.dll /tmp/stub/s.c
LIBNODE_PATH=/tmp/stub cargo build --release --locked -p baren-napi --target x86_64-pc-windows-gnu
cp "$CARGO_TARGET_DIR/x86_64-pc-windows-gnu/release/baren_napi.dll" "${join(NAPI, 'baren-core.win32-x64-gnu.node')}"`,
    { dryRun, targetDir: 'win' },
  )
}

/** Both macOS cores: clang + Rust's ld64.lld against the image's SDK → baren-core.darwin-*.node. */
function buildMacCores(dryRun) {
  const builds = MAC_ARCHS.map(({ arch, rust }) => {
    const t = `${rust}-apple-darwin`
    const T = t.toUpperCase().replace(/-/g, '_')
    const v = t.replace(/-/g, '_')
    const clangArch = rust === 'aarch64' ? 'arm64' : 'x86_64'
    return `printf '#!/bin/sh\\nexec clang --target=${clangArch}-apple-macos11 -isysroot %s -fuse-ld=lld --ld-path=%s/ld64.lld "$@"\\n' "$SDKROOT" "$GCCLD" > /tmp/tools/ld-${rust}
chmod +x /tmp/tools/ld-${rust}
rustup target add ${t} >/dev/null 2>&1
env CARGO_TARGET_${T}_LINKER=/tmp/tools/ld-${rust} CC_${v}=clang "CFLAGS_${v}=--target=${clangArch}-apple-macos11 -isysroot $SDKROOT" AR_${v}=/tmp/tools/ar \\
  cargo build --release --locked -p baren-napi --target ${t}
cp "$CARGO_TARGET_DIR/${t}/release/libbaren_napi.dylib" "${join(NAPI, `baren-core.darwin-${arch}.node`)}"`
  })
  docker(
    IMAGES.zigbuild,
    `GCCLD="$(rustc --print sysroot)/lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld"
mkdir -p /tmp/tools && printf '#!/bin/sh\\nexec zig ar "$@"\\n' > /tmp/tools/ar && chmod +x /tmp/tools/ar
${builds.join('\n')}`,
    { dryRun, targetDir: 'mac' },
  )
}

function buildNative(platform, dryRun) {
  if (platform === 'linux') {
    run('pnpm', ['build:native'], { dryRun })
    return
  }
  if (!hasCommand('docker'))
    fail(`the ${platform} core is cross-compiled in Docker: install docker`)
  if (platform === 'win') buildWindowsCore(dryRun)
  else buildMacCores(dryRun)
}

/** electron-builder arguments shared by every platform. */
function builderArgs(platformFlag, extra, { outDir, feed, version, pkg, opts }) {
  const args = [
    '--config',
    'electron-builder.yml',
    platformFlag,
    ...extra,
    '--publish',
    'never',
    `-c.directories.output=${outDir}`,
    '-c.publish.provider=generic',
    `-c.publish.url=${feed}`,
  ]
  if (version !== pkg.version && !opts.save) args.push(`-c.extraMetadata.version=${version}`)
  return args
}

function packageApp(opts, ctx) {
  const { buildEnv, outDir } = ctx
  if (opts.platform === 'linux') {
    run('pnpm', ['exec', 'electron-builder', ...builderArgs('--linux', opts.targets, ctx)], {
      cwd: DESKTOP,
      env: buildEnv,
      dryRun: opts.dryRun,
    })
    return
  }
  if (opts.platform === 'win') {
    const args = builderArgs('--win', [], ctx)
    if (hasCommand('wine')) {
      run('pnpm', ['exec', 'electron-builder', ...args], {
        cwd: DESKTOP,
        env: buildEnv,
        dryRun: opts.dryRun,
      })
      return
    }
    // electron-builder runs the installer once under wine to produce the uninstaller.
    if (!hasCommand('docker')) fail('the Windows installer needs wine or docker')
    const cache = join(homedir(), '.cache')
    const home = '/tmp/home'
    if (!opts.dryRun) {
      for (const dir of ['electron', 'electron-builder'])
        mkdirSync(join(cache, dir), { recursive: true })
    }
    run(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '-e',
        `HOME=${home}`,
        '-e',
        'ELECTRON_CACHE=/cache/electron',
        '-e',
        'ELECTRON_BUILDER_CACHE=/cache/electron-builder',
        '-v',
        `${ROOT}:${ROOT}`,
        ...(outDir.startsWith(ROOT) ? [] : ['-v', `${outDir}:${outDir}`]),
        '-v',
        `${join(cache, 'electron')}:/cache/electron`,
        '-v',
        `${join(cache, 'electron-builder')}:/cache/electron-builder`,
        '-w',
        DESKTOP,
        IMAGES.wine,
        'bash',
        '-c',
        `mkdir -p ${home} && node ${join(ROOT, 'node_modules', 'electron-builder', 'cli.js')} ${args.map((a) => `'${a}'`).join(' ')}`,
      ],
      { dryRun: opts.dryRun },
    )
    return
  }
  // mac: Baren.app per architecture (signed ad hoc by scripts/afterPack.cjs), then zipped here.
  if (process.platform !== 'darwin' && !process.env.RCODESIGN && !hasCommand('rcodesign')) {
    fail(
      'Mac builds made off a Mac sign the app ad hoc with rcodesign: put it on PATH or set RCODESIGN',
    )
  }
  if (!hasCommand('zip')) fail('zipping the Mac app needs zip (Info-ZIP)')
  run('pnpm', ['exec', 'electron-builder', ...builderArgs('--mac', [], ctx)], {
    cwd: DESKTOP,
    env: buildEnv,
    dryRun: opts.dryRun,
  })
  for (const { arch, dir } of MAC_ARCHS) {
    const zip = join(outDir, `baren-${ctx.version}-mac-${arch}.zip`)
    if (!opts.dryRun) rmSync(zip, { force: true })
    // -y stores the frameworks' symlinks as symlinks (copies would break the signed bundle).
    run('zip', ['-qry', zip, 'Baren.app'], { cwd: join(outDir, dir), dryRun: opts.dryRun })
  }
}

/** The files a release consists of, in upload order (update metadata last). */
function releaseFiles(platform, outDir, version) {
  const names = readdirSync(outDir).filter((n) => n.includes(version) && !n.startsWith('.'))
  const pick = (re) => names.filter((n) => re.test(n)).sort()
  const files = {
    linux: () => [...pick(/\.(AppImage|deb|rpm|blockmap)$/), 'latest-linux.yml'],
    win: () => [...pick(/^baren-setup-.*\.exe(\.blockmap)?$/), 'latest.yml'],
    mac: () => pick(/^baren-.*-mac-(arm64|x64)\.zip$/),
  }[platform]()
  const meta = { linux: 'latest-linux.yml', win: 'latest.yml', mac: null }[platform]
  if (meta && !readdirSync(outDir).includes(meta)) fail(`no ${meta} in ${outDir}`)
  if (files.length === 0) fail(`no ${platform} release files in ${outDir}`)
  return { files: files.map((n) => join(outDir, n)), meta }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const version = nextVersion(pkg.version, opts.version)
  const env = viteEnv()
  const feed = feedUrl({ feed: opts.feed, updateUrl: env.updateUrl, serverUrl: env.serverUrl })
  const outDir = opts.out ?? join(DESKTOP, 'release', version)
  const target = process.env.RELEASE_TARGET?.trim() || null
  const label = { linux: 'Linux', win: 'Windows', mac: 'macOS' }[opts.platform]

  console.log(`Baren ${label} release`)
  console.log(
    `  version   ${version}${version === pkg.version ? '' : ` (was ${pkg.version}${opts.save ? '' : ', not saved'})`}`,
  )
  console.log(`  server    ${env.serverUrl || `${DEFAULT_SERVER_URL} (VITE_SERVER_URL unset)`}`)
  console.log(
    `  feed      ${opts.platform === 'mac' ? `${feed} (not used: no Mac auto-update)` : feed}`,
  )
  if (opts.platform === 'linux') console.log(`  targets   ${opts.targets.join(', ')}`)
  console.log(`  output    ${shown(outDir)}`)
  console.log(`  upload    ${target ?? '(RELEASE_TARGET unset: no upload)'}`)
  if (!env.serverUrl) {
    console.warn('  warning   VITE_SERVER_URL is unset: this build talks to a local server only')
  }
  if (process.platform !== 'linux') fail('releases are built on Linux')
  if (opts.platform === 'linux' && opts.targets.includes('rpm') && !hasCommand('rpmbuild')) {
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

  const addonPattern = {
    linux: /\.linux-.*\.node$/,
    win: /\.win32-.*\.node$/,
    mac: /\.darwin-.*\.node$/,
  }[opts.platform]
  if (opts.skipNative) {
    log('native core: reusing crates/napi/*.node (--skip-native)')
    if (!readdirSync(NAPI).some((n) => addonPattern.test(n)))
      console.warn(`  warning   no ${label} native addon: the release will use the JS core`)
  } else {
    log(`native core (${label})`)
    buildNative(opts.platform, opts.dryRun)
  }

  const buildEnv = { ...process.env, VITE_UPDATE_URL: feed }
  log('app bundle (electron-vite)')
  run('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: DESKTOP,
    env: buildEnv,
    dryRun: opts.dryRun,
  })

  log(`packages (electron-builder: ${label})`)
  const absOut = isAbsolute(outDir) ? outDir : resolve(outDir)
  packageApp(opts, { buildEnv, outDir: absOut, feed, version, pkg, opts })

  if (opts.dryRun) {
    log('dry run: nothing was built')
    return
  }

  const { files, meta } = releaseFiles(opts.platform, outDir, version)
  if (meta) {
    const text = readFileSync(join(outDir, meta), 'utf8')
    if (!text.includes(`version: ${version}`)) fail(`${meta} is not for ${version}:\n${text}`)
  }
  log('release files')
  for (const f of files) console.log(`  ${shown(f)}`)

  if (target) {
    const dest = target.endsWith('/') ? target : `${target}/`
    log(`upload → ${dest}`)
    const packages = files.filter((f) => !meta || !f.endsWith(meta))
    run('rsync', ['-av', '--partial', '--chmod=F644', ...packages, dest])
    if (meta) run('rsync', ['-av', '--chmod=F644', join(outDir, meta), dest])
  }
  log(`done: ${version}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
