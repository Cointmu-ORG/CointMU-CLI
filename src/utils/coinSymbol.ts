/**
 * The label printed next to every amount. Only ever a label: wei, formatEther()
 * and the 18 decimals are the same on every network.
 */

/** What a network saved without a symbol is labelled with. */
export const DEFAULT_SYMBOL = "ETH";

/** 1-11 ASCII letters or digits: nothing a terminal could interpret. */
const SYMBOL_PATTERN = /^[A-Za-z0-9]{1,11}$/;

/** The rule, as error messages state it. */
export const SYMBOL_RULE = "expected 1-11 letters or digits, e.g. CMU";

/**
 * Whether a value can be used as a coin symbol. Stored as typed: tickers such
 * as tCMU are not all uppercase.
 * @param {unknown} value - The candidate, from a flag or a file.
 * @returns {boolean} True if it is a string of 1-11 ASCII letters or digits.
 */
export function isValidSymbol(value: unknown): value is string {
  return typeof value === "string" && SYMBOL_PATTERN.test(value);
}

/**
 * The coin symbol of a saved network, ETH when it was saved without one.
 *
 * The symbol is re-checked here because ~/.cmu-networks.json can be edited by
 * hand, and whatever it holds is printed straight to the terminal.
 *
 * @param {object} network - The saved entry, as loadNetworks() returned it.
 * @returns {string} The symbol to label amounts with.
 * @throws {Error} When the stored symbol is not a valid one.
 */
export function coinSymbol(network: {
  name: string;
  rpcUrl: string;
  symbol?: unknown;
}): string {
  if (network.symbol === undefined) return DEFAULT_SYMBOL;
  if (isValidSymbol(network.symbol)) return network.symbol;
  throw new Error(
    `network '${network.name}' has an invalid symbol ${JSON.stringify(network.symbol)} in ~/.cmu-networks.json - ${SYMBOL_RULE}.\n` +
      `\x1b[2mhint:\x1b[0m set it again with \`cmu network save ${network.rpcUrl} --name ${network.name} --symbol <SYMBOL>\`.`,
  );
}
