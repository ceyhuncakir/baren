/** Remembers the last screen across launches and the last home screen for "back". */
import { readString, writeString } from '../lib/storage'
import { DEFAULT_PATH, isHomeLike, isRememberable, resolveRoute } from './routes'

const KEY = 'lastRoute'

let lastHome: string = DEFAULT_PATH

export function rememberLocation(location: string): void {
  const route = resolveRoute(location)
  if (isRememberable(route)) writeString(KEY, location)
  if (isHomeLike(route)) lastHome = location
}

/** Where to start when the window opens without a route. */
export function initialLocation(): string {
  const saved = readString(KEY)
  return saved && isRememberable(resolveRoute(saved)) ? saved : DEFAULT_PATH
}

/** The last Recents/Files/Archive/Team screen (the editor's "back"). */
export function lastHomeLocation(): string {
  return lastHome
}
