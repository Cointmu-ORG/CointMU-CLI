import { generateConfigFiles } from "./configGenerator";

const TYPESCRIPT_LANG = "typescript";
const ENCODING = "utf8";
const FS_EXTRA_PKG = "fs-extra";
const PATH_PKG = "path";
const CHILD_PROCESS_PKG = "child_process";

export const templateChoices = [
  { name: "Blank (empty project with basic structure)", value: "blank" },
  { name: "ERC20 (standard fungible token)", value: "erc20" },
  { name: "ERC721 (standard NFT collection)", value: "erc721" },
  { name: "ERC1155 (multi-token standard)", value: "erc1155" },
  { name: "DAO (basic decentralized autonomous organization)", value: "dao" },
  { name: "Marketplace (NFT marketplace)", value: "marketplace" },
  { name: "Staking (ERC20 staking and yield farming)", value: "staking" },
  { name: "Airdrop (Merkle tree token airdrop)", value: "airdrop" },
  { name: "Vault (multisig timelock treasury)", value: "vault" },
  { name: "Kyberion (PQC research prototype)", value: "kyberion" },
] as const;

export const validTemplates = [
  ...templateChoices.map((choice) => choice.value),
  "nft",
];

function getDeployScript(
  contractName: string,
  contractArgs: string,
  language: string,
): string {
  const tsImports = `import { ethers } from 'ethers';
import fs from 'fs-extra';
import path from 'path';`;

  const jsImports = `const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');`;

  return `${language === TYPESCRIPT_LANG ? tsImports : jsImports}

async function main() {
  console.log('Deploying ${contractName}...');
  
  const artifactPath = path.resolve(__dirname, '../artifacts/${contractName}.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('Artifact not found. Run \`cmu compile\` first.');
  }

  const artifact = await fs.readJson(artifactPath);
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
  await fs.ensureDir(deploymentDir);
  const deploymentPath = path.join(deploymentDir, '${contractName}.json');
  
  await fs.writeJson(deploymentPath, {
    address,
    abi,
    network: await provider.getNetwork().then(n => ({ chainId: Number(n.chainId), name: n.name }))
  }, { spaces: 2 });
  console.log(\`Deployment saved to \${deploymentPath}\`);
}

main().catch(console.error);
`;
}

const blankDeployTemplate = (language: string): string =>
  `import { ethers } from 'ethers';

async function main() {
  console.log('Deploy script executed.');
  const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL || 'http://localhost:8545');
  // Add your deployment logic here
}

main().catch(console.error);
`.replace(
    "import { ethers } from 'ethers';",
    language === TYPESCRIPT_LANG
      ? "import { ethers } from 'ethers';"
      : "const { ethers } = require('ethers');",
  );

export async function generateProject(
  projectPath: string,
  template: string,
  language: string,
): Promise<void> {
  const fs =
    (await import(FS_EXTRA_PKG)).default || (await import(FS_EXTRA_PKG));
  const path = await import(PATH_PKG);
  const { execSync } = await import(CHILD_PROCESS_PKG);

  const dirs = [
    "contracts",
    "scripts",
    "artifacts",
    "deployments",
    "deploy",
    "test",
  ];
  for (const dir of dirs) {
    await fs.ensureDir(path.join(projectPath, dir));
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

  await fs.writeFile(
    path.join(projectPath, "test", `Template.test.${ext}`),
    templateTestContent,
    ENCODING,
  );

  await generateConfigFiles(projectPath, language);

  await fs.writeFile(
    path.join(projectPath, "artifacts", ".gitkeep"),
    "",
    ENCODING,
  );
  await fs.writeFile(
    path.join(projectPath, "deployments", ".gitkeep"),
    "",
    ENCODING,
  );
  await fs.writeFile(
    path.join(projectPath, "scripts", ".gitkeep"),
    "",
    ENCODING,
  );

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
    await fs.writeJson(path.join(projectPath, "tsconfig.json"), tsconfig, {
      spaces: 2,
    });
  }

  let contractSrc = "";
  let contractName = "";
  let deployArgs = "";

  if (template === "erc20") {
    const { erc20Template } = await import("../templates/erc20");
    contractSrc = erc20Template;
    contractName = "StandardERC20";
    deployArgs = "'MyToken', 'MTK', 1000000";
  } else if (template === "erc721" || template === "nft") {
    const { erc721Template } = await import("../templates/erc721");
    contractSrc = erc721Template;
    contractName = "StandardERC721";
    deployArgs = "'MyNFT', 'MNFT'";
  } else if (template === "erc1155") {
    const { erc1155Template } = await import("../templates/erc1155");
    contractSrc = erc1155Template;
    contractName = "StandardERC1155";
    deployArgs = "'MyTokens', 'MTKS'";
  } else if (template === "dao") {
    const { daoTemplate } = await import("../templates/dao");
    contractSrc = daoTemplate;
    contractName = "StandardDAO";
    deployArgs = "'MyDAO'";
  } else if (template === "marketplace") {
    const { marketplaceTemplate } = await import("../templates/marketplace");
    contractSrc = marketplaceTemplate;
    contractName = "StandardMarketplace";
    deployArgs = "";
  } else if (template === "staking") {
    const { stakingTemplate } = await import("../templates/staking");
    contractSrc = stakingTemplate;
    contractName = "StandardStaking";
    deployArgs =
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 1";
  } else if (template === "airdrop") {
    const { airdropTemplate } = await import("../templates/airdrop");
    contractSrc = airdropTemplate;
    contractName = "StandardAirdrop";
    deployArgs =
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000000000000000000000000000000'";
  } else if (template === "vault") {
    const { vaultTemplate } = await import("../templates/vault");
    contractSrc = vaultTemplate;
    contractName = "StandardVault";
    deployArgs = "['0x0000000000000000000000000000000000000001'], 1, 0";
  } else if (template === "kyberion") {
    const { kyberionTemplate } = await import("../templates/kyberion");
    contractSrc = kyberionTemplate;
    contractName = "Kyberion";
    deployArgs = "";
  }

  if (template === "blank") {
    await fs.writeFile(
      path.join(projectPath, "contracts", ".gitkeep"),
      "",
      ENCODING,
    );
    await fs.writeFile(
      path.join(projectPath, "deploy", `01_deploy.${ext}`),
      blankDeployTemplate(language),
      ENCODING,
    );
  } else {
    await fs.writeFile(
      path.join(projectPath, "contracts", `${contractName}.sol`),
      contractSrc,
      ENCODING,
    );
    await fs.writeFile(
      path.join(
        projectPath,
        "deploy",
        `01_${contractName.toLowerCase()}.${ext}`,
      ),
      getDeployScript(contractName, deployArgs, language),
      ENCODING,
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

  await fs.writeJson(path.join(projectPath, "package.json"), packageJson, {
    spaces: 2,
  });

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
