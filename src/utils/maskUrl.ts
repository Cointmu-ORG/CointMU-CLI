/**
 * Masking for URLs about to be printed. A saved RPC endpoint can carry
 * credentials (`https://user:pass@host`, `?apikey=...`), and anything printed
 * ends up in scrollback, CI logs and pasted bug reports.
 *
 * Works on the string rather than through `new URL()`, whose `href` adds a
 * trailing slash and re-encodes: a URL with nothing to hide is printed exactly
 * as the user typed it.
 *
 * ponytail: a key in the path (`/v3/<key>`) is not recognised; it would need
 * per-provider rules.
 */

const MASK = "***";

/** scheme://, then the userinfo up to the last @ before the path, query or fragment. */
const USERINFO = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)@/i;

/**
 * A scheme:// URL inside free text, such as an error message. It stops at
 * whitespace and quotes, and leaves sentence punctuation after it
 * ("...", "'.", ")") outside the match.
 */
const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s'"`<>]*[^\s'"`<>.,;:!?)\]]/gi;

/**
 * In input that need not be a URL: every run of characters ending in @, never
 * reaching back past a path, query or fragment separator.
 */
const INPUT_USERINFO = /[^\s/?#@]+@/g;

/** Keeps the username, which is not a secret on its own; a lone one usually is. */
function maskCredentials(userinfo: string): string {
  const colon = userinfo.indexOf(":");
  return colon === -1 ? MASK : `${userinfo.slice(0, colon)}:${MASK}`;
}

function maskUserinfo(url: string): string {
  return url.replace(
    USERINFO,
    (_match, scheme: string, userinfo: string) =>
      `${scheme}${maskCredentials(userinfo)}@`,
  );
}

/** Every query value, since any of them can be a key (`?k=`, `?apikey=`). */
function maskQueryValues(url: string): string {
  const hash = url.indexOf("#");
  const end = hash === -1 ? url.length : hash;
  const query = url.indexOf("?");
  if (query === -1 || query > end) return url;

  const masked = url.slice(query + 1, end).replace(/=[^&]*/g, `=${MASK}`);
  return `${url.slice(0, query + 1)}${masked}${url.slice(end)}`;
}

/**
 * The URL with its password (or lone username) and query values replaced by
 * `***`, e.g. `http://user:***@host/rpc?k=***`. Unchanged when there is
 * neither; also works on strings that are not valid URLs.
 * @param {string} url - The URL to print.
 * @returns {string} The masked URL.
 */
export function maskUrl(url: string): string {
  return maskQueryValues(maskUserinfo(url));
}

/**
 * Applies maskUrl() to every URL in a piece of text: error messages, and the
 * inspected errors (with their cause and info) that --verbose prints.
 * @param {string} text - The text about to be printed.
 * @returns {string} The same text with every URL masked.
 */
export function maskUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, maskUrl);
}

/**
 * maskUrl() for what the user typed where a URL was expected but which is not
 * one, so there may be no `scheme://` to anchor on (`user:pw@host:8545`).
 * Masks everything in front of each @ back to the previous `/`, which can
 * hide a little more than the userinfo but never less.
 * @param {string} input - The rejected input, about to be printed back.
 * @returns {string} The input with credentials and query values masked.
 */
export function maskUrlInput(input: string): string {
  return maskQueryValues(input).replace(
    INPUT_USERINFO,
    (match) => `${maskCredentials(match.slice(0, -1))}@`,
  );
}

/**
 * The URL for a hint that is a command to run again. A masked copy would run
 * and save `***` as the password, so a URL with anything to mask becomes the
 * `<url>` placeholder; any other URL is kept so the hint still runs as is.
 * @param {string} url - The URL the hint would contain.
 * @returns {string} The URL, or `<url>`.
 */
export function urlForHint(url: string): string {
  return maskUrl(url) === url ? url : "<url>";
}
