/** A stream as far as colour is concerned. */
export type ColorStream = {
  isTTY?: boolean;
  write(...args: unknown[]): boolean;
};

/** FORCE_COLOR values that turn colour off, as Node reads them. */
const FORCE_COLOR_OFF = new Set(["0", "false"]);

const ESC = "\u001b";
/**
 * SGR, the colour and style codes: ESC [ params m. Cursor movement and line
 * erasing (ESC [ 1A, ESC [ 2K, ESC [ ?25h) end in other letters and are kept,
 * so a prompt still draws and a status line still redraws.
 */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const gated = new WeakSet<ColorStream>();

/**
 * Whether colour codes belong on a stream: FORCE_COLOR decides when set
 * ("0" or "false" for off, anything else for on), then a non-empty NO_COLOR
 * turns colour off (no-color.org), and otherwise only a terminal gets colour.
 * Read from the environment directly, not from Node's tty helpers, which
 * disagree about an empty NO_COLOR between Node 20 and 24.
 *
 * @param {{isTTY?: boolean}} stream - The stream about to be written to.
 * @param {NodeJS.ProcessEnv} [env] - The environment to read.
 * @returns {boolean} True when colour codes may be written to it.
 */
export function isColorEnabled(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.FORCE_COLOR !== undefined) {
    return !FORCE_COLOR_OFF.has(env.FORCE_COLOR);
  }
  if (env.NO_COLOR) return false;
  return stream.isTTY === true;
}

/**
 * Drops colour codes from everything later written to a stream that should
 * not get them. The labels cmu prints carry their codes inline, so they are
 * taken out on the way to the stream rather than at every call site. A
 * stream that may have colour is left as it is.
 *
 * ponytail: strings only, one write at a time. A code split across two
 * writes, or inside a Buffer, passes through. console.log writes each line
 * whole, which is how cmu prints; carry a partial code over to the next
 * write if another writer ever needs it.
 *
 * @param {ColorStream} stream - process.stdout or process.stderr.
 * @param {NodeJS.ProcessEnv} [env] - The environment to read.
 * @returns {void}
 */
export function stripColorWhenDisabled(
  stream: ColorStream,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (gated.has(stream) || isColorEnabled(stream, env)) return;
  gated.add(stream);
  const write = stream.write.bind(stream);
  stream.write = (chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === "string" ? chunk.replace(SGR, "") : chunk, ...rest);
}
