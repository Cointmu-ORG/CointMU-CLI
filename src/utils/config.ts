const CONFIG_FILE_NAME = "cmu.config.ts";
const MODULE_FORMAT = "CommonJS";
const TS_COMPILER = "typescript";
const FS_EXTRA_PKG = "fs-extra";
const PATH_PKG = "path";
const TS_NODE_PKG = "ts-node";

export interface CmuConfig {
  network?: {
    rpcUrl?: string;
    explorerUrl?: string;
    chainId?: number;
  };
  compiler?: {
    version?: string;
  };
}

/**
 * Loads the cmu.config.ts file from the current working directory.
 * @returns {Promise<CmuConfig>} Resolves with the parsed configuration object.
 */
export async function loadConfig(): Promise<CmuConfig> {
  const fs =
    (await import(FS_EXTRA_PKG)).default || (await import(FS_EXTRA_PKG));
  const path = await import(PATH_PKG);

  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);

  if (!(await fs.pathExists(configPath))) {
    throw new Error(
      `${CONFIG_FILE_NAME} not found.\n` +
        "\x1b[2mhint:\x1b[0m run this command from the root of your CointMU project.",
    );
  }

  const tsNode = await import(TS_NODE_PKG);
  tsNode.register({
    transpileOnly: true,
    compiler: TS_COMPILER,
    compilerOptions: {
      module: MODULE_FORMAT,
    },
  });

  const configModule = require(configPath);
  return configModule.default || configModule;
}
