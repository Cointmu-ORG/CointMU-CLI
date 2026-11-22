import { writeFile } from "fs/promises";
import * as path from "path";
import {
  LOCAL_CHAIN_ID,
  LOCAL_NETWORK_NAME,
  LOCAL_RPC_URL,
  LOCAL_SYMBOL,
} from "./defaults";
import { JS_CONFIG_FILE, TS_CONFIG_FILE } from "./trust";

const TYPESCRIPT_LANG = "typescript";

/**
 * Where a scaffolded project reads its networks from: the global
 * ~/.cmu-networks.json (no cmu.config is written), or a cmu.config of its own.
 */
export type ConfigLocation = "global" | "project";

/**
 * The scaffolded cmu.config, which differs between the two languages only in
 * how it exports the object.
 *
 * @param {boolean} isTypeScript - Whether to emit the TS or the JS form.
 * @returns {string} The file contents.
 */
const cmuConfig = (isTypeScript: boolean) => `${
  isTypeScript ? "export default" : "module.exports ="
} {
  defaultNetwork: "${LOCAL_NETWORK_NAME}",
  networks: {
    ${LOCAL_NETWORK_NAME}: {
      url: "${LOCAL_RPC_URL}",
      chainId: ${LOCAL_CHAIN_ID},
      symbol: "${LOCAL_SYMBOL}",
    },
    // Set this to your own CointMU mainnet RPC endpoint before deploying.
    // Keep it on https://: a plaintext http:// endpoint can be intercepted and
    // made to return spoofed chain state (balances, nonces, gas, receipts).
    mainnet: {
      url: "",
      chainId: ${LOCAL_CHAIN_ID},
      symbol: "${LOCAL_SYMBOL}",
    },
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
  },
  compiler: {
    version: "0.8.20",
  },
};
`;

const envExampleTemplate = `PRIVATE_KEY=insert_your_private_key_here
`;

const gitignoreTemplate = `# Dependency directories
node_modules/

# Coverage output
coverage/

# Environment files
.env
.env.local
.env.test
.env.production

# CointMU local session & network state (encrypted key / local-only config)
.cmu-session
.cmu-session.*.tmp
.cmu-session.bak-*
.cmu-networks.json
.cmu-wallets.json

# Compiled artifacts
artifacts/
dist/

# Local devnet deployment records (other networks' records are meant to be committed)
deployments/${LOCAL_NETWORK_NAME}/

# Logs
logs
*.log
npm-debug.log*
`;

/**
 * Generates the standard boilerplate configuration files for a scaffolded project.
 * Writes `.env.example` and `.gitignore`, plus the `cmu.config` file for the
 * selected language when the project keeps its own config.
 *
 * @param {string} projectPath - The absolute path to the target project directory.
 * @param {string} language - The language to use ('typescript' or 'javascript').
 * @param {ConfigLocation} [location] - "global" writes no cmu.config.
 * @returns {Promise<void>} Resolves when all files have been written successfully.
 */
export async function generateConfigFiles(
  projectPath: string,
  language: string,
  location: ConfigLocation = "project",
): Promise<void> {
  try {
    const isTypeScript = language === TYPESCRIPT_LANG;
    const files = [
      [".env.example", envExampleTemplate],
      [".gitignore", gitignoreTemplate],
    ];
    if (location === "project") {
      files.push([
        isTypeScript ? TS_CONFIG_FILE : JS_CONFIG_FILE,
        cmuConfig(isTypeScript),
      ]);
    }

    for (const [name, content] of files) {
      await writeFile(path.join(projectPath, name), content, "utf8");
    }
  } catch (error) {
    throw new Error(
      `could not write the project config files: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
