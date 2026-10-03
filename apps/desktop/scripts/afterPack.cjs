/**
 * electron-builder afterPack hook (electron-builder.yml). Mac builds are not signed with an
 * Apple Developer ID (`mac.identity: null`), and packing changes the Electron app's files, so
 * its original signature no longer holds; Apple Silicon refuses to run unsigned code at all.
 * Sign the packed .app ad hoc before it is zipped: `codesign` on a Mac, `rcodesign`
 * (https://github.com/indygreg/apple-platform-rs, on PATH or in $RCODESIGN) elsewhere.
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command} not found: Mac builds made off a Mac need rcodesign to sign the app ad hoc ` +
        '(set RCODESIGN to its path; see README → Installers)',
    )
  }
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (process.platform === 'darwin') {
    run('codesign', ['--force', '--deep', '--sign', '-', app])
  } else {
    run(process.env.RCODESIGN || 'rcodesign', ['sign', app])
  }
}
