/**
 * Tiny structured logger for the main process. Writes to stderr so stdout
 * stays machine-readable (BAREN_SMOKE prints its JSON report there).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  child(scope: string): Logger
}

export type LogSink = (line: string) => void

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`)
}

function describe(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) return ` ${data.stack ?? data.message}`
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ` ${String(data)}`
  }
}

export function createLogger(
  scope = 'main',
  options: { debug?: boolean; sink?: LogSink } = {},
): Logger {
  const sink = options.sink ?? stderrSink
  const debugEnabled = options.debug ?? process.env['BAREN_DEBUG'] === '1'
  const write = (level: LogLevel, message: string, data: unknown): void => {
    if (level === 'debug' && !debugEnabled) return
    sink(`[baren:${scope}] ${level} ${message}${describe(data)}`)
  }
  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
    child: (child) => createLogger(`${scope}:${child}`, { debug: debugEnabled, sink }),
  }
}

export const log: Logger = createLogger()
