# 🚀 CointMU CLI (cmu-cli) 🌟

## 🌟 Project Overview

The CointMU CLI (`cmu-cli`) is the ultimate, hyper-charged development toolkit for the **CointMU blockchain ecosystem**! ⚡ It provides developers with a blazing fast, modern command-line interface to interactively scaffold new projects, compile Solidity smart contracts, execute sequential deployment scripts, manage secure wallets, and seamlessly interact with the local CointMU node.

Built beautifully with **TypeScript** and packing **Vite-like** interactive prompts, it streamlines the entire Web3 development lifecycle for the CointMU network so you can focus on building the future! 🛠️💎

## 📦 Installation Guide

> **Node.js:** 20.12 or newer for the CLI itself. `cmu test` and `cmu node start`
> need **Node.js 22 or newer**, because the local DevNet runs on EDR, which does
> not install its native binary on older Node.

### 🌍 Global Installation via NPM

To install the `cointmu-cli` package globally so you can use the magic `cmu` command from anywhere, run:

```bash
npm install -g cointmu-cli
```

### ⬆️ Updating

To upgrade an existing global install to the latest published release:

```bash
cmu update
```

To pin a specific published version instead of the latest:

```bash
cmu update --to 1.3.1
```

`cmu update` installs from the npm registry, so it always matches what a fresh `npm install -g cointmu-cli` would give you.

> **Stuck on 1.3.2 or older?** Those builds updated from git, which npm 12+ blocks
> (`npm error code EALLOWGIT`). Escape once with `npm install -g cointmu-cli@latest`
> — from 1.3.3 onward `cmu update` goes through the registry and works normally.

### 💻 Local Development Setup (NPM)

If you are developing or contributing to the CLI itself, you can easily set it up locally:

1. Clone the repository and navigate into the directory: 📂

```bash
git clone <repository_url>
cd CointMU-CLI
```

2. Install dependencies: 📦

```bash
npm install
```

3. Build the TypeScript source code: 🔨

```bash
npm run build
```

4. Link the package globally for local testing: 🔗

```bash
npm install -g .
```

## 📁 Template Structure Explanation

When you scaffold a new project using `cmu create`, the following pristine directory structure is generated to separate concerns and organize your workflow:

- 📜 `contracts/`: For your raw Solidity smart contracts. This is where your core on-chain logic and magic resides!
- 🚀 `deploy/`: For sequential deployment scripts. Scripts here are executed natively in alphanumeric order (e.g., `01_token.ts`, `02_dao.ts`) when you deploy.
- 💾 `deployments/`: For storing immutable JSON artifacts of successfully deployed contracts. These files contain the contract address, ABI, and network details, serving as a permanent historical record.
- 🛠️ `scripts/`: For ad-hoc utility scripts. Use this sandbox directory for tasks like checking balances, interacting with deployed contracts, or database seeding.
- ⚙️ `cmu.config.ts`: The main brain/configuration file where you define your target networks, RPC URLs, chain IDs, and compiler versions.
- 🔐 `.env`: For sensitive variables like private keys. (A `.env.example` is generated for you automatically!)

The `cmu create` command now offers these templates: `blank`, `erc20`, `erc721`, `erc1155`, `dao`, `marketplace`, `staking`, `airdrop`, `vault`, and `kyberion`.

## 🧰 CLI Help Output

When you run `cmu --help` in your terminal, you will see the following output:

```text
Usage: cmu [options] [command]

Primary development toolkit for the CointMU blockchain
Tip: Run cmu <command> -h to see detailed options for a specific command.

Options:
  -h, --help                  display help for command

Commands:
  compile [options]           Compiles smart contracts into ABI and bytecode artifacts
  deploy [options]            Executes deployment scripts to broadcast contracts on-chain
  console [options]           Opens an interactive REPL against the configured network
  explorer [options]          Queries block and contract information over RPC
  wallet                      Wallet management commands
    create                    Generates a new, secure EVM-compatible wallet
    login                     Securely log into your wallet and create an encrypted session
    balance                   Fetch and display the native token balance of the logged-in wallet
    info                      Display the current active wallet session information
  create [options] [project]  Initializes a new CointMU workspace with pre-configured templates
  node [options]              Manages the local EVM node for development and testing
    connect                   Pings the configured RPC endpoint to test connectivity
    start                     Starts a local development network with pre-funded accounts
  audit [options]             Performs static security analysis on contracts and dependencies
  version [options]           Displays detailed CLI, runtime, and dependency versions
  test [options]              Executes the automated smart contract test suite
  mine                        Mining control commands
    start                     Starts mining blocks on the active network using the logged-in wallet
    stop                      Stops mining blocks on the active network
  network [options]           Manage active RPC networks locally
    save <url> -n <name>      Save a new network or update an existing one
    use <name>                Switch the active network to the specified name
    list                      List all saved networks
    delete <name>             Delete a saved network
    info                      Display the active network configuration
    ping [name]               Ping a network to check connectivity and latency
  update [options]            Updates the CointMU CLI to the latest release from the npm registry
  help [command]              display help for command
```

> **Deprecated in 1.4.0:** `cmu network` used to take `--save`, `--use`, `--list`
> and `--delete` as flags. They still work and still do the same thing, but they
> now print a deprecation notice and will be removed in **2.0.0**. Use the
> subcommands above instead — `cmu network save <url> --name <name>` in place of
> `cmu network --save <url> --name <name>`, and so on. `cmu network` on its own
> still lists the saved networks.

## 🔐 Trust Model

`cmu deploy` and `cmu compile` **execute arbitrary code from the project directory**:

- every `.ts`/`.js` file in `deploy/` is run as a program, and receives your decrypted `PRIVATE_KEY` through the environment so it can sign transactions;
- `cmu.config.ts` / `cmu.config.js` is `require()`d from the current working directory, by `cmu compile`, `cmu test`, `cmu deploy`, `cmu console` and `cmu explorer` alike;
- `cmu console` then runs whatever you type at the prompt, with your full environment and the key it decrypted for `signer`.

This is by design and cannot be removed without breaking deployment itself — it is the same trust model as Hardhat, Foundry and Truffle. A deploy script that wants to exfiltrate your key only has to read `process.env.PRIVATE_KEY`, and encrypting `.cmu-session` at rest does not help once the script is running.

**Never run `cmu deploy`, `cmu compile`, `cmu test`, `cmu console` or `cmu explorer` in a project you did not write or do not trust.** Read `deploy/` and `cmu.config.ts` before the first run, the same way you would read any script before executing it.

To make the boundary explicit, the CLI lists every file it is about to execute and asks for confirmation first:

```text
warning: the following project files will be executed as code:
      cmu.config.ts  ->  /home/you/my-dapp/cmu.config.ts
      00_deploy.ts   ->  /home/you/my-dapp/deploy/00_deploy.ts

    They run with your full environment, including the PRIVATE_KEY decrypted from
    your session and injected for deploy scripts, and can do anything your user
    account can. This is the same trust model as Hardhat, Foundry and Truffle;
    see the 'Trust Model' section of the README.

? Execute these files? (y/N)
```

Pass `-y` / `--yes` to skip the prompt in CI or other non-interactive use:

```bash
cmu deploy --yes
cmu compile --yes
cmu test --yes
cmu console --yes
cmu explorer --block 0 --yes
```

When stdin is not a TTY and `--yes` was not given, the command **fails with an error instead of continuing**. The prompt is not silently skipped just because nobody is watching — an unattended run of an untrusted project is exactly the case this gate exists for.

> Note: this confirmation reduces the chance of executing a hostile project by accident. It is not a sandbox — once you confirm, the scripts have full access to your environment. Sandboxed execution is tracked separately.

## ⚡ Quick Start

Here is a standard, lightning-fast workflow to get a new CointMU project up and running:

1. **Create a new development wallet**: 🔐

```bash
cmu wallet create
```

_(Make sure to save your private key securely in a safe place! The key and mnemonic
stay in your terminal scrollback, so clear it if you ran this somewhere shared.)_

To keep the key off the screen entirely, let `cmu` encrypt it into a session instead:

```bash
cmu wallet create --login
```

The key is never printed on that path — it exists only inside `.cmu-session`, so
there is no printed backup to fall back on if you lose that file or its password.

2. **Scaffold a new CointMU project**: ✨

```bash
cmu create my-awesome-dapp
```

_(You will be interactively prompted to choose between TypeScript/JavaScript and select a template like blank, erc20, erc721, erc1155, dao, marketplace, staking, airdrop, vault, or kyberion!)_

3. **Navigate into your new project directory**: 📂

```bash
cd my-awesome-dapp
```

4. **Configure your environment**: ⚙️
   Rename `.env.example` to `.env` and paste your newly generated private key into the `PRIVATE_KEY` variable.

5. **Compile your smart contracts**: 🔨

```bash
cmu compile
```

6. **Deploy your contracts to the network**: 🚀

```bash
cmu deploy
```

_(This will automatically and sequentially execute the scripts in your `deploy/` folder and save the precious artifacts to `deployments/`)_

7. **Test the connection to your local node**: 📡

```bash
cmu node connect
```

8. **Poke at a deployed contract without writing a script**: 🛠️

```bash
cmu console
```

```text
cmu> await provider.getBlockNumber()
cmu> const token = getContract("Token", "0xYOUR_CONTRACT_ADDRESS")
cmu> await token.totalSupply()
cmu> .exit
```

_(The REPL preloads `provider`, `signer`, `ethers` and `getContract(name, address)`. The address is required - the CLI does not track deployed addresses per network yet - and `name` is the contract name, the one `cmu compile` wrote to `artifacts/<Name>.json`.)_

Without `cmu wallet login` or a `PRIVATE_KEY`, `signer` is `undefined` and the console is read-only; `--no-signer` starts that way deliberately and skips the session password prompt. The network follows `defaultNetwork` in `cmu.config.ts` rather than `cmu network use`, exactly like `cmu deploy`.

9. **Look up a block or a contract without leaving the terminal**: 🔍

```bash
cmu explorer --block 1
cmu explorer --contract 0xYOUR_CONTRACT_ADDRESS
```

```text
--- Block 1 on 'local' ---
Hash         : 0x62165bb2c481efbbcabbca8701155c8297307e09e1328bf2360a2564b4316558
Parent       : 0xa87456ab91ba4a30f9436411cf25f4e4f9291c43ad020278d6c38d5fc3580cb2
Timestamp    : 2026-09-21T14:20:58.000Z (1790000458)
Transactions : 1
Gas used     : 54274 / 60000000 (0.09%)
Validator    : 0xC014BA5EC014ba5ec014Ba5EC014ba5Ec014bA5E

--- Address on 'local' ---
Address      : 0x47aD01814e2Bfeb6dEA1B0262723899188bD4F5E
Bytecode     : 1842 bytes
Balance      : 0.0 (0 wei)
```

_(Exactly one of `--block` or `--contract` per run: they answer unrelated questions, and passing neither would otherwise do nothing at all. An address with no bytecode is reported as such and still exits `0` - "not a contract" is an answer, not a failure.)_

The explorer is read-only: there is no signer, so it never asks for your session password even when `.cmu-session` is locked. Like `cmu console` and `cmu deploy`, the network follows `defaultNetwork` in `cmu.config.ts` unless `-n/--network` overrides it.

---

Happy building on CointMU! 🎉✨
