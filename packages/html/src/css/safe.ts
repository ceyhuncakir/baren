/**
 * Copy of the schema's `isSafeCssValue` (`packages/schema/src/svgSanitize.ts`, not exported;
 * contract §7.6 rule 3). `tests/parity.test.ts` runs both on the same cases.
 */
const GAP = '[\\s\\\\]*'
/** The schema's banned words with any whitespace or backslashes between their characters. */
const BANNED = new RegExp(
  ['javascript:', 'vbscript:', 'expression(', '@import', 'behavior:', '-moz-binding']
    .map((word) => [...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join(GAP))
    .join('|'),
  'i',
)

export function isSafeCssValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[<>{}\u0000-\u001f\u007f-\u009f]/.test(value)) return false
  // Same rule as the schema (which squashes whitespace and backslashes, lowercases, then
  // searches), without allocating.
  return !BANNED.test(value)
}
