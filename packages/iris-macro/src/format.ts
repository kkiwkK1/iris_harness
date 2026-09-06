/**
 * The slice of moment.js that the time macros need.
 *
 * SillyTavern's time macros are thin wrappers over moment: `{{time}}` is
 * `format('LT')`, `{{date}}` is `format('LL')`, and `{{datetimeformat::FMT}}`
 * hands the card's own format string straight through. Cards in the wild
 * therefore contain moment tokens, and an engine that invented its own syntax
 * would render them as literal text.
 *
 * Reimplemented rather than depended upon because moment is 70 kB of deprecated
 * library for what amounts to a token table, and this package is meant to have
 * no runtime dependencies. Only the tokens cards actually use are supported;
 * an unknown token renders as itself, exactly as an unknown macro does.
 *
 * @module @iris/macro/format
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

/**
 * moment's locale-dependent shorthands, pinned to `en`.
 *
 * SillyTavern never configures a moment locale, so upstream renders these in
 * whatever the browser reports. Pinning to English instead is the lesser evil:
 * a prompt whose date format silently changes with the user's OS locale is a
 * prompt that cannot be reproduced from a chat log.
 */
const LONG_FORMATS: ReadonlyArray<readonly [string, string]> = [
  ['LLLL', 'dddd, MMMM D, YYYY h:mm A'],
  ['LLL', 'MMMM D, YYYY h:mm A'],
  ['LTS', 'h:mm:ss A'],
  ['LT', 'h:mm A'],
  ['LL', 'MMMM D, YYYY'],
  ['L', 'MM/DD/YYYY'],
]

/** Tokens, longest first so `MMMM` is never read as `MM` + `MM`. */
const TOKEN_PATTERN = /\[([^\]]*)\]|dddd|ddd|YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g

/** Left-pad to two digits. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Expand `L`-family shorthands into their token spellings.
 *
 * Done as a separate pass because the expansions contain no `L` tokens
 * themselves, so one pass is enough and the tokenizer never has to recurse.
 * @param pattern - a format string.
 * @returns the pattern with shorthands replaced.
 */
function expandLongFormats(pattern: string): string {
  let result = pattern
  for (const [token, expansion] of LONG_FORMATS) {
    result = result.split(token).join(expansion)
  }
  return result
}

/**
 * Render an instant with a moment-style format string.
 * @param instant - the moment to render.
 * @param pattern - a moment format string. `[text]` escapes literal text.
 * @param utcOffsetMinutes - minutes east of UTC to render in; the host's own
 *   zone when omitted.
 * @returns the formatted string.
 */
export function formatDate(instant: Date, pattern: string, utcOffsetMinutes?: number): string {
  // Shifting the instant and then reading UTC fields renders any zone without
  // needing the host to know about that zone at all.
  const offset = utcOffsetMinutes ?? -instant.getTimezoneOffset()
  const shifted = new Date(instant.getTime() + offset * 60_000)

  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth()
  const day = shifted.getUTCDate()
  const weekday = shifted.getUTCDay()
  const hour24 = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const second = shifted.getUTCSeconds()
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const meridiem = hour24 < 12 ? 'AM' : 'PM'

  return expandLongFormats(pattern).replace(TOKEN_PATTERN, (token, literal?: string) => {
    if (literal !== undefined) return literal
    switch (token) {
      case 'YYYY': return String(year)
      case 'YY': return pad(year % 100)
      case 'MMMM': return MONTHS[month] ?? ''
      case 'MMM': return (MONTHS[month] ?? '').slice(0, 3)
      case 'MM': return pad(month + 1)
      case 'M': return String(month + 1)
      case 'DD': return pad(day)
      case 'D': return String(day)
      case 'dddd': return WEEKDAYS[weekday] ?? ''
      case 'ddd': return (WEEKDAYS[weekday] ?? '').slice(0, 3)
      case 'HH': return pad(hour24)
      case 'H': return String(hour24)
      case 'hh': return pad(hour12)
      case 'h': return String(hour12)
      case 'mm': return pad(minute)
      case 'm': return String(minute)
      case 'ss': return pad(second)
      case 's': return String(second)
      case 'A': return meridiem
      case 'a': return meridiem.toLowerCase()
      default: return token
    }
  })
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** moment's average month and year, in days: 146097 days per 400 years. */
const DAYS_PER_MONTH = 146097 / 4800
const DAYS_PER_YEAR = 146097 / 400

/**
 * moment's `duration.humanize()` for the `en` locale, thresholds and all.
 *
 * `{{idleDuration}}` is read by cards that branch on how long the user has been
 * away ("she notices you have been quiet for a few hours"), so the *buckets*
 * matter more than the precision: a card tuned against "a few seconds" and
 * "2 hours" breaks if this returns "0:03" instead. The cut-offs below are
 * moment's defaults (`ss:44 s:45 m:45 h:22 d:26 M:11`) applied in moment's own
 * order, where each unit is rounded from the whole duration rather than from
 * the remainder of the previous one.
 * @param milliseconds - elapsed time; negative values are treated as zero
 *   unless `suffix` asks for moment's signed phrasing.
 * @param suffix - render moment's `humanize(true)` form instead: the sign
 *   becomes a direction, `"in 3 hours"` for a non-negative duration and
 *   `"3 hours ago"` for a negative one. `{{timeDiff}}` needs this, because its
 *   whole answer is the direction the two arguments differ in.
 * @returns an English phrase such as `"a few seconds"` or `"3 days"`.
 */
export function humanizeDuration(milliseconds: number, suffix = false): string {
  // moment answers an invalid duration with its smallest bucket rather than an
  // error, and `{{timeDiff}}` inherits that: two unparsable arguments produce
  // "a few seconds", not a failure.
  if (Number.isNaN(milliseconds)) return 'a few seconds'
  // Suffix mode buckets the magnitude and reads the direction off the sign,
  // exactly as moment does; unsuffixed callers keep the clamp, because
  // "how long ago" has no answer for a clock in the future.
  const phrase = humanize(suffix ? Math.abs(milliseconds) : Math.max(0, milliseconds))
  if (!suffix) return phrase
  return milliseconds < 0 ? `${phrase} ago` : `in ${phrase}`
}

/** The unsuffixed bucket phrase for a non-negative duration. */
function humanize(elapsed: number): string {
  const seconds = Math.round(elapsed / SECOND)
  if (seconds <= 44) return 'a few seconds'

  const minutes = Math.round(elapsed / MINUTE)
  if (minutes <= 1) return 'a minute'
  if (minutes < 45) return `${minutes} minutes`

  const hours = Math.round(elapsed / HOUR)
  if (hours <= 1) return 'an hour'
  if (hours < 22) return `${hours} hours`

  const days = Math.round(elapsed / DAY)
  if (days <= 1) return 'a day'
  if (days < 26) return `${days} days`

  const months = Math.round(elapsed / DAY / DAYS_PER_MONTH)
  if (months <= 1) return 'a month'
  if (months < 11) return `${months} months`

  const years = Math.round(elapsed / DAY / DAYS_PER_YEAR)
  if (years <= 1) return 'a year'
  return `${years} years`
}
