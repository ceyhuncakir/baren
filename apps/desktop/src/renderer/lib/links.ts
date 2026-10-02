/** External destinations (Help menu, sidebar cards, footer links). Opened with bridge.shell. */
import type { CommandId } from './commands'

export const SITE_URL = 'https://baren.dev'

export const HELP_LINKS = {
  'help.documentation': `${SITE_URL}/docs`,
  'help.videoTutorials': `${SITE_URL}/tutorials`,
  'help.releaseNotes': `${SITE_URL}/changelog`,
  'help.discord': `${SITE_URL}/discord`,
  'help.slack': `${SITE_URL}/slack`,
  'help.reddit': 'https://www.reddit.com/r/baren',
  'help.twitter': 'https://x.com/barendesign',
} as const satisfies Partial<Record<CommandId, string>>

export type HelpCommandId = keyof typeof HELP_LINKS

export const LINKS = {
  learn: `${SITE_URL}/learn`,
  agents: `${SITE_URL}/docs/mcp`,
  feedback: `${SITE_URL}/feedback`,
  whatsNew: HELP_LINKS['help.releaseNotes'],
} as const
