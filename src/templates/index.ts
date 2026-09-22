import { erc20Template } from "./erc20";
import { erc721Template } from "./erc721";
import { erc1155Template } from "./erc1155";
import { daoTemplate } from "./dao";
import { marketplaceTemplate } from "./marketplace";
import { stakingTemplate } from "./staking";
import { airdropTemplate } from "./airdrop";
import { vaultTemplate } from "./vault";
import { kyberionTemplate } from "./kyberion";

/**
 * Single source of truth for the scaffolding templates: the label `cmu create`
 * shows in its picker, the contract each one writes, and the arguments its
 * generated deploy script passes to the constructor.
 */
export interface TemplateSpec {
  /** Text shown in the `cmu create` template picker. */
  label: string;
  /** Contract name written to contracts/<name>.sol. Absent for "blank". */
  contract?: string;
  /** Constructor arguments, rendered verbatim into the deploy script. */
  deployArgs?: string;
  /** The Solidity source to write. Absent for "blank". */
  source?: string;
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
    source: erc20Template,
  },
  erc721: {
    label: "ERC721 (standard NFT collection)",
    contract: "StandardERC721",
    deployArgs: "'MyNFT', 'MNFT'",
    source: erc721Template,
  },
  erc1155: {
    label: "ERC1155 (multi-token standard)",
    contract: "StandardERC1155",
    deployArgs: "'MyTokens', 'MTKS'",
    source: erc1155Template,
  },
  dao: {
    label: "DAO (basic decentralized autonomous organization)",
    contract: "StandardDAO",
    deployArgs: "'MyDAO'",
    source: daoTemplate,
  },
  marketplace: {
    label: "Marketplace (NFT marketplace)",
    contract: "StandardMarketplace",
    deployArgs: "",
    source: marketplaceTemplate,
  },
  staking: {
    label: "Staking (ERC20 staking and yield farming)",
    contract: "StandardStaking",
    deployArgs:
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 1",
    source: stakingTemplate,
  },
  airdrop: {
    label: "Airdrop (Merkle tree token airdrop)",
    contract: "StandardAirdrop",
    deployArgs:
      "'0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000000000000000000000000000000'",
    source: airdropTemplate,
  },
  vault: {
    label: "Vault (multisig timelock treasury)",
    contract: "StandardVault",
    deployArgs: "['0x0000000000000000000000000000000000000001'], 1, 0",
    source: vaultTemplate,
  },
  kyberion: {
    label: "Kyberion (PQC research prototype)",
    contract: "Kyberion",
    deployArgs: "",
    source: kyberionTemplate,
  },
};
