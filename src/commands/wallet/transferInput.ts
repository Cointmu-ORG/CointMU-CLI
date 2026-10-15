/** Exactly 0x and 40 hex digits: no ENS name, ICAP, missing prefix or padding. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** A plain decimal ETH amount, at most 18 decimals (1 wei). */
const AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,18})?$/;

/**
 * Turns the transfer recipient into a checksummed hex address.
 *
 * Stricter than ethers.isAddress(), which also takes a bare 40-digit hex
 * string and an ICAP "XE..." one. Only the getAddress() result is ever handed
 * to the provider, so nothing that looks like a name can reach ENS resolution.
 *
 * @param {string} to - The recipient as typed.
 * @returns {Promise<string>} The checksummed address.
 * @throws {Error} When it is not a 0x-prefixed address, or its mixed-case
 *   checksum is wrong.
 */
export async function parseTransferAddress(to: string): Promise<string> {
  if (!ADDRESS_PATTERN.test(to)) {
    throw new Error(
      `invalid recipient ${JSON.stringify(to)} - expected a 0x-prefixed 40-digit hex address.\n` +
        "\x1b[2mhint:\x1b[0m ENS names are not resolved; paste the address itself.",
    );
  }
  const { ethers } = await import("ethers");
  try {
    return ethers.getAddress(to);
  } catch {
    throw new Error(
      `bad address checksum for '${to}'.\n` +
        "\x1b[2mhint:\x1b[0m a mixed-case address encodes a checksum - check for a typo, or paste it all lowercase.",
    );
  }
}

/**
 * Turns the transfer amount, in ETH, into wei.
 *
 * Stricter than parseEther(), which on its own takes "-1", "0", "1." and
 * ".5". Only plain positive decimals pass.
 *
 * @param {string} amount - The amount as typed, in ETH.
 * @returns {Promise<bigint>} The amount in wei.
 * @throws {Error} When it is not a positive decimal with at most 18 decimals.
 */
export async function parseTransferAmount(amount: string): Promise<bigint> {
  if (/^[0-9]+\.[0-9]{19,}$/.test(amount)) {
    throw new Error(
      // Unit-neutral: parsed before the network, and so its symbol, is known.
      `amount '${amount}' has more than 18 decimals - the smallest unit (1 wei) is 0.000000000000000001.`,
    );
  }
  if (!AMOUNT_PATTERN.test(amount)) {
    throw new Error(
      `invalid amount ${JSON.stringify(amount)} - expected a positive decimal amount like 0.5.\n` +
        "\x1b[2mhint:\x1b[0m no sign, exponent, separators or bare leading/trailing dot: write 1 or 0.5.",
    );
  }
  const { ethers } = await import("ethers");
  const wei = ethers.parseEther(amount);
  if (wei === 0n) {
    throw new Error("amount must be greater than 0.");
  }
  return wei;
}
