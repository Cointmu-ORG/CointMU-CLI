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
- 💾 `deployments/`: Deployment records, one per network and contract: `deployments/<network>/<Contract>.json`, holding the address, chain ID, deployer, transaction hash, block number, block time and a hash of the deployed code. `cmu deploy` writes them itself by reading the chain after your scripts run, so hand-written scripts are covered too. The ABI stays in `artifacts/`. A redeploy overwrites the record; `deployments/local/` is gitignored, other networks' records are meant to be committed.
  - Not detected: contracts created by another contract (factories), contracts deployed with a key other than the one `cmu deploy` injects, and contracts whose artifact still has unlinked library placeholders (listed as `(unrecognised)` in the summary). A deploy that spans more than 1000 blocks is not recorded.
  - Older scaffolds wrote a flat `deployments/<Contract>.json`; CointMU never reads that file.
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
    create [--save <name>]    Generates a new wallet; --save stores it encrypted under <name>
    login                     Deprecated: use `wallet save` + `wallet use`
    balance                   Fetch and display the native token balance of the active wallet
    info                      Display the current active wallet session information
    save|add <name>           Save a private key as a named, encrypted wallet
                              (--session: save this project's session key instead)
    use <name>                Make a saved wallet the active session in this project
    list                      List saved wallets
    delete <name>             Delete a saved wallet
    transfer|tf <to> <amount> Send ETH from the session wallet (-y skips the confirmation)
  create [options] [project]  Initializes a new CointMU workspace with pre-configured templates
  node [options]              Manages the local EVM node for development and testing
    connect                   Pings the configured RPC endpoint to test connectivity
    start                     Starts a local development network with pre-funded accounts
  audit [options]             Performs static security analysis on contracts and dependencies
  version [options]           Displays detailed CLI, runtime, and dependency versions
  test [options]              Executes the automated smart contract test suite
  mine                        Mining control commands
    start [--watch]           Starts mining blocks on the active network using the active wallet
    stop                      Stops mining blocks on the active network
    status                    Shows mining state, hashrate, etherbase and your balance
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

`cmu compile` and `cmu explorer` load `cmu.config.ts` but never resolve a key, so they print the same file list with wording that claims no more than they do — no `PRIVATE_KEY` sentence, and an explicit note that the command does not sign anything and does not unlock your session.

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
cmu wallet create --save deployer
```

_(You are asked for a password twice. The private key is encrypted into
`~/.cmu-wallets.json` and never printed; only the address and the mnemonic are
shown, once. The store does not keep the mnemonic, so write it down: it is the
only backup if you lose that file or the password. It also stays in your
terminal scrollback, so clear it if you ran this somewhere shared.)_

Plain `cmu wallet create` still prints the private key and mnemonic instead of
storing anything. See [Named Wallets](#-named-wallets) for juggling several keys.

2. **Scaffold a new CointMU project**: ✨

```bash
cmu create my-awesome-dapp
```

_(You will be interactively prompted to choose between TypeScript/JavaScript and select a template like blank, erc20, erc721, erc1155, dao, marketplace, staking, airdrop, vault, or kyberion!)_

3. **Navigate into your new project directory**: 📂

```bash
cd my-awesome-dapp
```

4. **Pick the wallet for this project**: ⚙️

```bash
cmu wallet use deployer
```

_(`cmu deploy` then asks for that wallet's password. In CI, rename `.env.example`
to `.env` and set `PRIVATE_KEY` instead - it takes precedence over the wallet.)_

5. **Compile your smart contracts**: 🔨

```bash
cmu compile
```

6. **Deploy your contracts to the network**: 🚀

```bash
cmu deploy
```

_(This will automatically and sequentially execute the scripts in your `deploy/` folder, then print a summary of the contracts they deployed and record each one under `deployments/<network>/`)_

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
cmu> const token = await getDeployed("Token")
getDeployed: Token -> 0x5FbD... on 'local' (chain 1912), recorded 2026-10-13T08:00:00.000Z from deployments/local/Token.json
cmu> await token.totalSupply()
cmu> const other = getContract("Token", "0xANOTHER_ADDRESS")
cmu> .exit
```

_(The REPL preloads `provider`, `signer`, `ethers`, `getContract(name, address)` and `getDeployed(name)`. `name` is the contract name, the one `cmu compile` wrote to `artifacts/<Name>.json`.)_

- `getContract(name, address)` is synchronous and attaches the ABI to the address you give it; it never looks anything up.
- `getDeployed(name)` is always async (`await` it). It resolves the address from `deployments/<network>/<Name>.json` for the console's network, as recorded by `cmu deploy`. Before it hands back a contract, it checks the record against the chain:
  - the chain ID is the recorded one;
  - the address still holds code (a restarted devnet leaves none);
  - that code is the code that was recorded;
  - that code is what your local `artifacts/<Name>.json` compiles to, with immutables masked.

  A failed check is an error, never a silent fallback. Every successful resolve prints the address and the record it came from. Records in a cloned repository were written by someone else; the artifact check is what stops one from pointing your console at a different contract. Run `cmu compile` after cloning so that `artifacts/` is your own build. Contracts with linked libraries cannot be checked yet, so `getDeployed` refuses them.

Without an active wallet (`cmu wallet use <name>`) or a `PRIVATE_KEY`, `signer` is `undefined` and the console is read-only; `--no-signer` starts that way deliberately and skips the session password prompt. The network follows `defaultNetwork` in `cmu.config.ts` rather than `cmu network use`, exactly like `cmu deploy`.

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
Recorded as  : Token (deployments/local/Token.json, recorded 2026-09-21T14:20:58.000Z)
Record check : code matches the record
```

_(Exactly one of `--block` or `--contract` per run: they answer unrelated questions, and passing neither would otherwise do nothing at all. An address with no bytecode is reported as such and still exits `0` - "not a contract" is an answer, not a failure.)_

When a deployment record on the same network names the address, the explorer shows it under `Recorded as`. `Record check` compares the record's code hash with what is on-chain. A stale record is labelled, not refused: the explorer only reads.

The explorer is read-only: there is no signer, so it never asks for your session password even when `.cmu-session` is locked. Like `cmu console` and `cmu deploy`, the network follows `defaultNetwork` in `cmu.config.ts` unless `-n/--network` overrides it.

## 👛 Named Wallets

Save each key once under a name, then pick one per project:

```bash
cmu wallet create --save dev # new wallet: prompts for a password (twice), prints the mnemonic
cmu wallet save deployer     # existing key: prompts for it and a password (twice)
cmu wallet save admin        # every wallet has its own password
cmu wallet save old --session # keep this project's session key; opens with the session password
cmu wallet list              # names and addresses; no password needed
cmu wallet use deployer      # prompts for deployer's password
cmu wallet delete admin      # asks first; --yes skips the question
```

- **Saved wallets are global, the active wallet is per project.** Wallets live
  in `~/.cmu-wallets.json`. `cmu wallet use` writes `.cmu-session` in the
  current directory, so two projects can use different wallets at the same
  time. `cmu wallet list` marks the one this project uses.
- **Same encryption as the session.** Each key is stored with AES-256-GCM and a
  PBKDF2-derived key, exactly like `.cmu-session`; only the name and address
  are stored in plaintext. `use` copies the encrypted key into `.cmu-session`,
  so `cmu deploy` asks for that wallet's password.
- **`use` keeps your network.** The active network picked with
  `cmu network use` carries over.
- **`create --save` does not activate the wallet.** Run `cmu wallet use <name>`
  in each project that should sign with it. The private key is never printed;
  the mnemonic is printed once and is the only backup, since the store keeps
  just the encrypted key.
- **Deleting is local to the store.** A project that already ran
  `cmu wallet use <name>` keeps its own encrypted copy in `.cmu-session` and
  keeps working. cmu keeps no other copy of a deleted wallet's key.
- **Names** are 1-32 lowercase letters, digits, `-` or `_`. Saving under a name
  that is taken is refused - delete the old wallet first.
- **`cmu wallet login` and `cmu wallet create --login` are deprecated.** They
  still work and print a warning to stderr naming the replacement
  (`wallet save` + `wallet use`, or `wallet create --save <name>` then
  `wallet use <name>`); they will be removed in a later 1.x release. A
  `.cmu-session` written by `login` stays valid - the file format does not
  change.
- **A key that is not saved is never replaced without asking.** `use`,
  `login` and `create --login` check `.cmu-session` before any prompt. If it
  holds a key whose address is not a saved wallet - such as one from
  `create --login`, which was never printed - they name that address and ask
  `Replace it anyway? (y/N)`. Answering no (or Ctrl-C) leaves the file as it
  was and exits 1; replacing it deletes that key for good. Keep it first with
  `cmu wallet save <name> --session`: it copies the encrypted key into
  `~/.cmu-wallets.json` without decrypting it, so it needs no terminal and
  the saved wallet opens with the session's password. A session with no
  readable key (missing, corrupt, or from before AES-GCM) is replaced without
  a question.

**Prompts need a terminal.** `save`, `create --save`, `use`, `login` and `delete` without `--yes`
fail with an error when stdin is not a TTY instead of hanging. So does the
replace question above; there is no flag to skip it. `save --session` asks
nothing and works anywhere. In CI, set
`PRIVATE_KEY` instead - `cmu deploy` uses it before any session.

**File permissions.** On Linux and macOS, `~/.cmu-wallets.json` and
`.cmu-session` are written with mode `0600` (owner only), and an existing file
with a looser mode is tightened on the next write. Both are written to a temp
file and renamed into place, so an interrupted write leaves the old file
intact. On Windows, `chmod` only
toggles the read-only attribute: the file is protected by the ACL it inherits
from your user profile folder (by default you, SYSTEM and Administrators), and
the keys inside still need their password.

**Windows terminals.** Git Bash (mintty) does not present itself as a TTY, so
the prompts above refuse to run there. Use Windows Terminal, PowerShell or
`cmd`, or prefix the command with `winpty` (`winpty cmu wallet save dev`,
`winpty cmu wallet create --save dev`).

## 💸 Sending ETH

```bash
cmu wallet transfer 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 1.5
cmu wallet tf 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0.25 --yes
```

`transfer` sends from the wallet in this project's `.cmu-session`, on its
active network (the same ones `cmu wallet balance` uses). It checks
everything it can before asking for anything:

- `<to>` must be a `0x`-prefixed 40-digit hex address. ENS names are not
  resolved, and a mixed-case address with a wrong checksum is rejected.
- `<amount>` is in ETH: a plain positive decimal such as `1`, `0.5` or
  `0.000000000000000001`, at most 18 decimals. No sign, exponent,
  separators, `1.` or `.5`.
- The balance must cover the amount **plus the maximum fee**. The fee is
  capped up front (EIP-1559 `maxFeePerGas`, or `gasPrice` on a chain
  without it), so the actual fee is never higher than the one shown.
- The recipient must accept plain ETH. If a contract would reject the
  transfer, it stops here.

Only then does it ask for the session password, show a summary (network,
chain ID, from, to, amount and max fee) and ask `Send this transaction?`,
which defaults to **No**.

- `-y, --yes` skips that one question and **nothing else**. Every check
  above still applies, and sending to the zero address (which burns the
  funds) is refused under `--yes`, so a burn always needs an interactive
  confirmation.
- Warnings are printed for the zero address, for sending to yourself, and
  for a recipient that is a contract.
- The key always comes from `.cmu-session`. `PRIVATE_KEY` (including one
  loaded from `.env`) is **ignored** here, with a warning, so that the
  account that pays is always the one shown.
- The session password has to be typed, so `transfer` needs a terminal.
  Without one it fails, with or without `--yes`.

After sending, the transaction hash is printed straight away. `transfer`
then waits up to 120 seconds for one confirmation and prints the block
and the new balance. Blocks only appear while something mines, so on a
chain that is not mining run `cmu mine start`.

| Exit code | Meaning                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Sent and confirmed in a block.                                                                                                                                                                                                                           |
| `1`       | **Nothing was sent**: refused, aborted, or failed before sending. There are two exceptions, and the error says which: a transaction that was mined but reverted (the fee was paid), and a network error while broadcasting (it may still have gone out). |
| `2`       | The transaction **was sent but is not confirmed yet**. Do **not** retry before checking `cmu wallet balance`: a retry can send the funds twice.                                                                                                          |

## ⛏️ Mining

```bash
cmu mine start            # point the etherbase at the session wallet and start
cmu mine start --watch    # same, then keep watching progress
cmu mine status           # one-shot, read-only, no password
cmu mine stop
```

`cmu mine` needs a geth node with the `miner` API enabled. The local DevNet
mines a block for each transaction by itself and has no miner API, so
`start` and `stop` say so there. `status` still works on the DevNet and
shows `n/a` for what it cannot report.

The etherbase and the miner are **node-wide**: `mine start` moves the
rewards to your wallet for everyone, and `mine stop` stops mining for
everyone. When the node is already mining to another address, `mine start`
warns before taking it over.

`--watch` polls every few seconds and shows the height, the hashrate, the
blocks mined by your wallet since the watch started, and your balance. It
also prints a line when the etherbase moves to someone else or comes back,
when mining stops, after a reorg, and when the connection drops and comes
back. The **balance change** counts block rewards, uncle rewards and fees,
plus any transfer in or out, so it is not the same thing as the reward.
Ctrl-C leaves the watch only: **mining keeps running** until
`cmu mine stop`. Without a terminal, `--watch` prints one line per event
instead of redrawing.

---

Happy building on CointMU! 🎉✨
