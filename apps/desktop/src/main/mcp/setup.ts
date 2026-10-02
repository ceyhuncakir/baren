/**
 * Setup snippets for the Connect dialog (contract §4.13, `bridge.mcp.setup()`).
 *
 * Pure string building with no imports, so the browser-mode mock bridge uses the same code
 * (`renderer/lib/mockBridge.ts`). Every value is inserted as a JSON string literal
 * (`JSON.stringify`), which is also a valid TOML basic string, so URLs, tokens and Windows paths
 * are escaped the same way in every format.
 */

export interface SetupInput {
  /** The running endpoint, e.g. `http://127.0.0.1:29170/mcp`. */
  url: string
  token: string
  /** The stdio launch: the app executable (`$APPIMAGE` or `process.execPath`). */
  command: string
  /** `[<userData>/mcp/baren-mcp-stdio.cjs]`. */
  args: string[]
}

export interface SetupSnippets {
  claudeCode: string
  cursor: string
  codex: string
  json: string
  stdioJson: string
}

export interface SetupInfo {
  url: string
  token: string
  snippets: SetupSnippets
  stdio: { command: string; args: string[]; env: Record<string, string> }
}

/** The server name every snippet registers. */
export const MCP_SERVER_NAME = 'baren'

/** Environment of the stdio shim launch: the app binary runs as plain Node. */
export const STDIO_ENV: Readonly<Record<string, string>> = { ELECTRON_RUN_AS_NODE: '1' }

const q = (value: string): string => JSON.stringify(value)

/**
 * The Claude Code command is split over three lines (≤ 50 monospace characters each for the
 * dialog's code block); the URL is a plain shell word (it never contains spaces or quotes).
 */
export function claudeCodeSnippet(url: string, token: string): string {
  return [
    `claude mcp add --scope user --transport http \\`,
    `  ${MCP_SERVER_NAME} ${url} \\`,
    `  --header ${q(`Authorization: Bearer ${token}`)}`,
  ].join('\n')
}

export function cursorSnippet(url: string, token: string): string {
  return [
    '{',
    '  "mcpServers": {',
    `    ${q(MCP_SERVER_NAME)}: {`,
    `      "url": ${q(url)},`,
    `      "headers": { "Authorization": ${q(`Bearer ${token}`)} }`,
    '    }',
    '  }',
    '}',
  ].join('\n')
}

export function codexSnippet(url: string, token: string): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = ${q(url)}`,
    `http_headers = { "Authorization" = ${q(`Bearer ${token}`)} }`,
  ].join('\n')
}

export function jsonSnippet(url: string, token: string): string {
  return [
    '{',
    '  "mcpServers": {',
    `    ${q(MCP_SERVER_NAME)}: {`,
    '      "type": "http",',
    `      "url": ${q(url)},`,
    `      "headers": { "Authorization": ${q(`Bearer ${token}`)} }`,
    '    }',
    '  }',
    '}',
  ].join('\n')
}

export function stdioJsonSnippet(command: string, args: readonly string[]): string {
  return [
    '{',
    '  "mcpServers": {',
    `    ${q(MCP_SERVER_NAME)}: {`,
    `      "command": ${q(command)},`,
    `      "args": [${args.map(q).join(', ')}],`,
    `      "env": { "ELECTRON_RUN_AS_NODE": "1" }`,
    '    }',
    '  }',
    '}',
  ].join('\n')
}

export function buildSetup(input: SetupInput): SetupInfo {
  const { url, token, command, args } = input
  return {
    url,
    token,
    snippets: {
      claudeCode: claudeCodeSnippet(url, token),
      cursor: cursorSnippet(url, token),
      codex: codexSnippet(url, token),
      json: jsonSnippet(url, token),
      stdioJson: stdioJsonSnippet(command, args),
    },
    stdio: { command, args: [...args], env: { ...STDIO_ENV } },
  }
}
