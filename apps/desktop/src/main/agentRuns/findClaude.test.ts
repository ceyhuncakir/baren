import { describe, expect, it } from 'vitest'
import { claudeCandidates, claudeLaunch, findClaude, type FindClaudeEnv } from './findClaude'

function env(over: Partial<FindClaudeEnv>): FindClaudeEnv {
  return {
    platform: 'linux',
    home: '/home/ana',
    path: '/usr/bin:/home/ana/bin',
    shell: '/bin/zsh',
    isExecutable: async () => false,
    askShell: async () => null,
    ...over,
  }
}

describe('finding claude', () => {
  it('tries the installer locations first, then PATH', () => {
    expect(claudeCandidates(env({}))).toEqual([
      '/home/ana/.local/bin/claude',
      '/home/ana/.claude/local/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/home/ana/bin/claude',
    ])
  })

  it('returns the first executable, else asks the login shell', async () => {
    expect(await findClaude(env({ isExecutable: async (f) => f === '/home/ana/bin/claude' }))).toBe(
      '/home/ana/bin/claude',
    )
    expect(
      await findClaude(
        env({
          isExecutable: async (f) => f === '/opt/claude/bin/claude',
          askShell: async () => '/opt/claude/bin/claude',
        }),
      ),
    ).toBe('/opt/claude/bin/claude')
    expect(await findClaude(env({ askShell: async () => 'claude: not found' }))).toBeNull()
    expect(await findClaude(env({ platform: 'win32', path: '' }))).toBeNull()
  })
})

describe('starting claude', () => {
  // What `npm install -g @anthropic-ai/claude-code` writes on Windows (cmd-shim), and pnpm's.
  const NPM_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n')
  const PNPM_SHIM = [
    '@SETLOCAL',
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
    ')',
  ].join('\r\n')
  const launchEnv = (shim: string, nodeNextToIt = false) => ({
    platform: 'win32' as const,
    readFile: async () => shim,
    exists: async () => nodeNextToIt,
  })

  it('runs a native claude as it is', async () => {
    expect(await claudeLaunch('/home/ana/.local/bin/claude', launchEnv(''))).toEqual({
      command: '/home/ana/.local/bin/claude',
      args: [],
    })
    expect(await claudeLaunch('C:\\Users\\ana\\.local\\bin\\claude.exe', launchEnv(''))).toEqual({
      command: 'C:\\Users\\ana\\.local\\bin\\claude.exe',
      args: [],
    })
  })

  it('runs the script of an npm or pnpm shim with node, never through cmd.exe', async () => {
    const npm = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\claude.cmd'
    expect(await claudeLaunch(npm, launchEnv(NPM_SHIM))).toEqual({
      command: 'node',
      args: [
        'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      ],
    })
    expect(await claudeLaunch(npm, launchEnv(NPM_SHIM, true))).toEqual({
      command: 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node.exe',
      args: [
        'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      ],
    })
    const pnpm = 'C:\\Users\\ana\\AppData\\Local\\pnpm\\claude.CMD'
    expect(await claudeLaunch(pnpm, launchEnv(PNPM_SHIM))).toEqual({
      command: 'node',
      args: ['C:\\Users\\ana\\AppData\\Local\\@anthropic-ai\\claude-code\\cli.js'],
    })
  })

  it('refuses a shim it cannot read instead of handing it to the shell', async () => {
    await expect(
      claudeLaunch('C:\\tools\\claude.cmd', launchEnv('@echo off\r\nclaude-real.exe %*')),
    ).rejects.toThrow('native installer')
  })
})
