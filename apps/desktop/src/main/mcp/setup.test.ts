import { describe, expect, it } from 'vitest'
import { buildSetup } from './setup'

const URL = 'http://127.0.0.1:29170/mcp'
const TOKEN = 'brn_abcDEF123_-xyz'

describe('setup snippets (contract §4.13)', () => {
  const setup = buildSetup({
    url: URL,
    token: TOKEN,
    command: '/opt/baren.dev/baren',
    args: ['/home/u/.config/baren.dev/mcp/baren-mcp-stdio.cjs'],
  })

  it('splits the Claude Code command over three short lines', () => {
    expect(setup.snippets.claudeCode).toBe(
      [
        'claude mcp add --scope user --transport http \\',
        `  baren ${URL} \\`,
        `  --header "Authorization: Bearer ${TOKEN}"`,
      ].join('\n'),
    )
    for (const line of setup.snippets.claudeCode.split('\n')) {
      expect(line.replace(TOKEN, '••••••••7f3a').length).toBeLessThanOrEqual(50)
    }
  })

  it('produces valid Cursor and generic JSON', () => {
    expect(JSON.parse(setup.snippets.cursor)).toEqual({
      mcpServers: { baren: { url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } },
    })
    expect(JSON.parse(setup.snippets.json)).toEqual({
      mcpServers: {
        baren: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    })
    expect(setup.snippets.cursor).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "baren": {',
        `      "url": "${URL}",`,
        `      "headers": { "Authorization": "Bearer ${TOKEN}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('produces the Codex TOML table', () => {
    expect(setup.snippets.codex).toBe(
      [
        '[mcp_servers.baren]',
        `url = "${URL}"`,
        `http_headers = { "Authorization" = "Bearer ${TOKEN}" }`,
      ].join('\n'),
    )
  })

  it('produces the stdio config with ELECTRON_RUN_AS_NODE and no secret', () => {
    const parsed = JSON.parse(setup.snippets.stdioJson)
    expect(parsed).toEqual({
      mcpServers: {
        baren: {
          command: '/opt/baren.dev/baren',
          args: ['/home/u/.config/baren.dev/mcp/baren-mcp-stdio.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    })
    expect(setup.snippets.stdioJson).not.toContain(TOKEN)
    expect(setup.stdio).toEqual(parsed.mcpServers.baren)
  })

  it('escapes Windows paths and quotes in JSON and TOML', () => {
    const win = buildSetup({
      url: URL,
      token: 'brn_"quoted"\\x',
      command: 'C:\\Program Files\\Baren\\Baren.exe',
      args: ['C:\\Users\\Ana "A"\\AppData\\Roaming\\Baren\\mcp\\baren-mcp-stdio.cjs'],
    })
    const stdio = JSON.parse(win.snippets.stdioJson).mcpServers.baren
    expect(stdio.command).toBe('C:\\Program Files\\Baren\\Baren.exe')
    expect(stdio.args[0]).toContain('Ana "A"')
    expect(JSON.parse(win.snippets.cursor).mcpServers.baren.headers.Authorization).toBe(
      'Bearer brn_"quoted"\\x',
    )
    // TOML basic strings use the same escapes as JSON for quotes and backslashes.
    expect(win.snippets.codex).toContain('"Bearer brn_\\"quoted\\"\\\\x"')
  })
})
