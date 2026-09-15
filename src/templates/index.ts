/**
 * Single source of truth for the scaffolding templates: the label `cmu create`
 * shows in its picker, the contract each one writes, and the arguments its
 * generated deploy script passes to the constructor.
 *
 * `load` stays lazy so a template's Solidity source is only pulled in when that
 * template is actually chosen.
 */
export interface TemplateSpec {
  /** Text shown in the `cmu create` template picker. */
  label: string;
  /** Contract name written to contracts/<name>.sol. Absent for "blank". */
  contract?: string;
  /** Constructor arguments, rendered verbatim into the deploy script. */
  deployArgs?: string;
  /** Lazily resolves the Solidity source. Absent for "blank". */
  load?: () => Promise<string>;
}

/** Insertion order is the order the picker lists them in. */
export const templates: Record<string, TemplateSpec> = {
  blank: {
    label: "Blank (empty project with basic structure)",
  },
  erc20: {
    label: "ERC20 (standard fungible token)",
    contract: "StandardERC20",
    deployArgs: "'MyToken', 'MTK', 1000000",
    load: async () => (await import("./erc20")).erc20Template,
  },
  erc721: {
    label: "ERC721 (standard NFT collection)",
    contract: "StandardERC721",
    deployArgs: "'MyNFT', 'MNFT'",
    load: async () => (await import("./erc721")).erc721Template,
  },
  erc1155: {
    label: "ERC1155 (multi-token standard)",
    contract: "StandardERC1155",
    deployArgs: "'MyTokens', 'MTKS'",
    load: async () => (await import("./erc1155")).erc1155Template,
  },
  dao: {
    label: "DAO (basic decentralized autonomous organization)",
    contract: "StandardDAO",
    deployArgs: "'MyDAO'",
    load: async () => (await import("./dao")).daoTemplate,
  },
  marketplace: {
    label: "Marketplace (NFT marketplace)",
    contract: "StandardMarketplace",
    deployArgs: "",
    load: async () => (await import("./marketplace")).marketplaceTemplate,
  },
  staking: {
    label: "Staking (ERC20 staking and yield farming)",
    contract: "StandardStaking",
    deployArgs:
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 1",
    load: async () => (await import("./staking")).stakingTemplate,
  },
  airdrop: {
    label: "Airdrop (Merkle tree token airdrop)",
    contract: "StandardAirdrop",
    deployArgs:
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000000000000000000000000000000'",
    load: async () => (await import("./airdrop")).airdropTemplate,
  },
  vault: {
    label: "Vault (multisig timelock treasury)",
    contract: "StandardVault",
    deployArgs: "['0x0000000000000000000000000000000000000001'], 1, 0",
    load: async () => (await import("./vault")).vaultTemplate,
  },
  kyberion: {
    label: "Kyberion (PQC research prototype)",
    contract: "Kyberion",
    deployArgs: "",
    load: async () => (await import("./kyberion")).kyberionTemplate,
  },
};

/** Accepted on the command line but not offered in the picker. */
export const aliases: Record<string, string> = {
  nft: "erc721",
};
