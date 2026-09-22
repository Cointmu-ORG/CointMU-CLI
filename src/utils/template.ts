import { mkdir, writeFile } from "fs/promises";
import { generateConfigFiles } from "./configGenerator";
import { templates } from "../templates";

const TYPESCRIPT_LANG = "typescript";

/**
 * What every generated deploy script imports, as binding + module. One list
 * rather than a TS block and a JS block: the two used to be edited apart, and
 * a module added to only one of them scaffolds a broken script in the other
 * language.
 */
const DEPLOY_IMPORTS = [
  ["{ ethers }", "ethers"],
  ["{ existsSync }", "fs"],
  ["{ mkdir, readFile, writeFile }", "fs/promises"],
  ["path", "path"],
] as const;

export const templateChoices = Object.entries(templates).map(
  ([value, spec]) => ({ name: spec.label, value }),
);

export const validTemplates = Object.keys(templates);

export function getDeployScript(
  contractName: string,
  contractArgs: string,
  language: string,
): string {
  const imports = DEPLOY_IMPORTS.map(([binding, from]) =>
    language === TYPESCRIPT_LANG
      ? `import ${binding} from '${from}';`
      : `const ${binding} = require('${from}');`,
  ).join("\n");

  return `${imports}

async function main() {
  console.log('Deploying ${contractName}...');
  
  const artifactPath = path.resolve(__dirname, '../artifacts/${contractName}.json');
  if (!existsSync(artifactPath)) {
    throw new Error('Artifact not found. Run \`cmu compile\` first.');
  }

  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const abi = artifact.abi;
  const bytecode = artifact.evm?.bytecode?.object || artifact.bytecode;

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY is not set in the environment.');
  
  const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL || 'http://localhost:8545');
  const wallet = new ethers.Wallet(privateKey, provider);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(${contractArgs});
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  console.log(\`${contractName} deployed at \${address}\`);

  // Save artifact
  const deploymentDir = path.resolve(__dirname, '../deployments');
  await mkdir(deploymentDir, { recursive: true });
  const deploymentPath = path.join(deploymentDir, '${contractName}.json');
  
  await writeFile(deploymentPath, JSON.stringify({
    address,
    abi,
    network: await provider.getNetwork().then(n => ({ chainId: Number(n.chainId), name: n.name }))
  }, null, 2) + '\\n');
  console.log(\`Deployment saved to \${deploymentPath}\`);
}

main().catch((error) => {
  // Non-zero exit, so \`cmu deploy\` stops instead of reporting a failed
  // deploy as "All deploy scripts completed."
  console.error(error);
  process.exitCode = 1;
});
`;
}

export const blankDeployTemplate = (language: string): string => {
  const ethersImport =
    language === TYPESCRIPT_LANG
      ? "import { ethers } from 'ethers';"
      : "const { ethers } = require('ethers');";

  return `${ethersImport}

async function main() {
  console.log('Deploy script executed.');
  // Add your deployment logic here, e.g.
  // const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL);
}

main().catch((error) => {
  // Non-zero exit, so \`cmu deploy\` stops instead of reporting a failed
  // deploy as "All deploy scripts completed."
  console.error(error);
  process.exitCode = 1;
});
`;
};

export async function generateProject(
  projectPath: string,
  template: string,
  language: string,
): Promise<void> {
  const path = await import("path");
  const { execSync } = await import("child_process");

  const dirs = [
    "contracts",
    "scripts",
    "artifacts",
    "deployments",
    "deploy",
    "test",
  ];
  for (const dir of dirs) {
    await mkdir(path.join(projectPath, dir), { recursive: true });
  }

  const ext = language === TYPESCRIPT_LANG ? "ts" : "js";

  const templateTestContent = `import { expect } from "chai";
import { ethers } from "ethers";

describe("Deployment Template Test", function () {
  it("Should connect to the local ephemeral node successfully", async function () {
    const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL || "http://127.0.0.1:8555");
    const network = await provider.getNetwork();
    
    expect(Number(network.chainId)).to.be.greaterThan(0);
  });
});
`;

  await writeFile(
    path.join(projectPath, "test", `Template.test.${ext}`),
    templateTestContent,
    "utf8",
  );

  await generateConfigFiles(projectPath, language);

  await writeFile(path.join(projectPath, "artifacts", ".gitkeep"), "", "utf8");
  await writeFile(
    path.join(projectPath, "deployments", ".gitkeep"),
    "",
    "utf8",
  );
  await writeFile(path.join(projectPath, "scripts", ".gitkeep"), "", "utf8");

  if (language === TYPESCRIPT_LANG) {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "CommonJS",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ["scripts/**/*", "deploy/**/*"],
    };
    await writeFile(
      path.join(projectPath, "tsconfig.json"),
      `${JSON.stringify(tsconfig, null, 2)}\n`,
    );
  }

  const spec = templates[template];

  if (!spec?.load) {
    // "blank", and anything else with no contract behind it.
    await writeFile(
      path.join(projectPath, "contracts", ".gitkeep"),
      "",
      "utf8",
    );
    await writeFile(
      path.join(projectPath, "deploy", `01_deploy.${ext}`),
      blankDeployTemplate(language),
      "utf8",
    );
  } else {
    const contractName = spec.contract!;
    await writeFile(
      path.join(projectPath, "contracts", `${contractName}.sol`),
      await spec.load(),
      "utf8",
    );
    await writeFile(
      path.join(
        projectPath,
        "deploy",
        `01_${contractName.toLowerCase()}.${ext}`,
      ),
      getDeployScript(contractName, spec.deployArgs ?? "", language),
      "utf8",
    );
  }

  const projectName = path.basename(projectPath);
  const packageJson = {
    name: projectName,
    version: "1.0.0",
    description: `CointMU ${template} project`,
    scripts: {
      test: "cmu test",
    },
    dependencies: {},
  };

  await writeFile(
    path.join(projectPath, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  console.log("Installing dependencies...");
  execSync("npm install ethers", {
    cwd: projectPath,
    stdio: "inherit",
  });

  if (language === TYPESCRIPT_LANG) {
    console.log("Installing dev dependencies...");
    execSync(
      "npm install --save-dev @types/node mocha chai @types/mocha @types/chai ts-node typescript@5",
      {
        cwd: projectPath,
        stdio: "inherit",
      },
    );
  } else {
    console.log("Installing dev dependencies...");
    execSync("npm install --save-dev mocha chai", {
      cwd: projectPath,
      stdio: "inherit",
    });
  }
}
