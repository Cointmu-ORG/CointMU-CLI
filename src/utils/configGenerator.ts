import { writeFile } from "fs/promises";
import { LOCAL_CHAIN_ID, LOCAL_NETWORK_NAME, LOCAL_RPC_URL } from "./defaults";
import { JS_CONFIG_FILE, TS_CONFIG_FILE } from "./trust";

const TYPESCRIPT_LANG = "typescript";

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
    },
    // Set this to your own CointMU mainnet RPC endpoint before deploying.
    // Keep it on https://: a plaintext http:// endpoint can be intercepted and
    // made to return spoofed chain state (balances, nonces, gas, receipts).
    mainnet: {
      url: "",
      chainId: ${LOCAL_CHAIN_ID},
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
.cmu-networks.json

# Compiled artifacts
artifacts/
deployments/
dist/

# Logs
logs
*.log
npm-debug.log*
`;

/**
 * Generates the standard boilerplate configuration files for a scaffolded project.
 * Writes the appropriate `cmu.config` file, `.env.example`, and `.gitignore`
 * to the given directory based on the selected language.
 *
 * @param {string} projectPath - The absolute path to the target project directory.
 * @param {string} language - The language to use ('typescript' or 'javascript').
 * @returns {Promise<void>} Resolves when all files have been written successfully.
 */
export async function generateConfigFiles(
  projectPath: string,
  language: string,
): Promise<void> {
  try {
    const path = await import("path");

    const isTypeScript = language === TYPESCRIPT_LANG;
    const files = [
      [isTypeScript ? TS_CONFIG_FILE : JS_CONFIG_FILE, cmuConfig(isTypeScript)],
      [".env.example", envExampleTemplate],
      [".gitignore", gitignoreTemplate],
    ];

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
