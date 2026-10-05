/**
 * Where the `claude` executable is. An app started from the desktop often lacks the user's
 * shell PATH (no `~/.local/bin`), so this checks the installer's usual locations, then PATH,
 * then asks the login shell (`command -v claude`).
 */
import { execFile } from 'node:child_process'
import { access, constants, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'

export interface FindClaudeEnv {
  platform: NodeJS.Platform
  home: string
  path: string
  shell: string | null
  /** True when `file` exists and can be executed. */
  isExecutable(file: string): Promise<boolean>
  /** Run the login shell's `command -v claude` (null when it fails). */
  askShell(shell: string): Promise<string | null>
}

/** Candidate paths in the order they are tried (without the login shell). */
export function claudeCandidates(env: Pick<FindClaudeEnv, 'platform' | 'home' | 'path'>): string[] {
  const names = env.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const known =
    env.platform === 'win32'
      ? [
          join(env.home, '.local', 'bin', 'claude.exe'),
          join(env.home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        ]
      : [
          join(env.home, '.local', 'bin', 'claude'),
          join(env.home, '.claude', 'local', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          '/usr/bin/claude',
        ]
  const fromPath = env.path
    .split(env.platform === 'win32' ? ';' : delimiter)
    .filter((dir) => dir !== '')
    .flatMap((dir) => names.map((n) => join(dir, n)))
  return [...new Set([...known, ...fromPath])]
}

export async function findClaude(env: FindClaudeEnv = defaultEnv()): Promise<string | null> {
  for (const file of claudeCandidates(env)) {
    if (await env.isExecutable(file)) return file
  }
  if (env.platform !== 'win32' && env.shell) {
    const found = await env.askShell(env.shell)
    if (found && found.startsWith('/') && (await env.isExecutable(found))) return found
  }
  return null
}

export interface LaunchEnv {
  platform: NodeJS.Platform
  readFile(file: string): Promise<string>
  exists(file: string): Promise<boolean>
}

/** The script an npm (or pnpm) `.cmd` shim runs, relative to the shim's folder. */
const SHIM_SCRIPT = /"%~?dp0%?\\([^"]+?\.[cm]?js)"/i

/**
 * How to start `claude`. A native install runs as it is. An npm install on Windows is a `.cmd`
 * shim, which Node only starts through `cmd.exe` (CVE-2024-27980), where the prompt (text
 * collaborators wrote) would be parsed by the shell: run the script the shim points to with
 * Node instead (the shim's own `node.exe` when it has one, like the shim does).
 */
export async function claudeLaunch(
  claude: string,
  env: LaunchEnv = defaultLaunchEnv(),
): Promise<{ command: string; args: string[] }> {
  if (env.platform !== 'win32' || !/\.(cmd|bat)$/i.test(claude))
    return { command: claude, args: [] }
  const shim = await env.readFile(claude).catch(() => '')
  const script = SHIM_SCRIPT.exec(shim)?.[1]
  if (!script) {
    throw new Error(
      `${win32.basename(claude)} is not an npm shim Baren can start. Install Claude Code with its native installer.`,
    )
  }
  const dir = win32.dirname(claude)
  const localNode = win32.join(dir, 'node.exe')
  return {
    command: (await env.exists(localNode)) ? localNode : 'node',
    args: [win32.resolve(dir, script)],
  }
}

function defaultLaunchEnv(): LaunchEnv {
  return {
    platform: process.platform,
    readFile: (file) => readFile(file, 'utf8'),
    exists: async (file) => {
      try {
        await access(file, constants.F_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

function defaultEnv(): FindClaudeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    path: process.env['PATH'] ?? '',
    shell: process.env['SHELL'] ?? null,
    isExecutable: async (file) => {
      try {
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    askShell: (shell) =>
      new Promise((resolve) => {
        execFile(shell, ['-lc', 'command -v claude'], { timeout: 3_000 }, (error, stdout) => {
          resolve(error ? null : stdout.trim().split('\n').pop()?.trim() || null)
        })
      }),
  }
}
