import { writeFile } from "fs/promises";

const TYPESCRIPT_LANG = "typescript";
const TS_CONFIG_FILE = "cmu.config.ts";
const JS_CONFIG_FILE = "cmu.config.js";
const ENV_EXAMPLE_FILE = ".env.example";
const GITIGNORE_FILE = ".gitignore";

const cmuConfigJs = `module.exports = {
  defaultNetwork: "local",
  networks: {
    local: {
      url: "http://127.0.0.1:8585",
      chainId: 1912,
    },
    // Set this to your own CointMU mainnet RPC endpoint before deploying.
    // Keep it on https://: a plaintext http:// endpoint can be intercepted and
    // made to return spoofed chain state (balances, nonces, gas, receipts).
    mainnet: {
      url: "",
      chainId: 1912,
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

const cmuConfigTs = `export default {
  defaultNetwork: "local",
  networks: {
    local: {
      url: "http://127.0.0.1:8585",
      chainId: 1912,
    },
    // Set this to your own CointMU mainnet RPC endpoint before deploying.
    // Keep it on https://: a plaintext http:// endpoint can be intercepted and
    // made to return spoofed chain state (balances, nonces, gas, receipts).
    mainnet: {
      url: "",
      chainId: 1912,
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
    const configFileName = isTypeScript ? TS_CONFIG_FILE : JS_CONFIG_FILE;
    const configContent = isTypeScript ? cmuConfigTs : cmuConfigJs;

    await writeFile(
      path.join(projectPath, configFileName),
      configContent,
      "utf8",
    );

    await writeFile(
      path.join(projectPath, ENV_EXAMPLE_FILE),
      envExampleTemplate,
      "utf8",
    );

    await writeFile(
      path.join(projectPath, GITIGNORE_FILE),
      gitignoreTemplate,
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `could not write the project config files: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
