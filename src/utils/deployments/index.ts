/**
 * Per-network deployment records: deployments/<network>/<Contract>.json.
 *
 * The deploy scripts run as child processes with inherited stdio, so they
 * cannot hand anything back to `cmu deploy`. Instead the parent reads the
 * chain itself: it notes the head block and the deployer's nonce before the
 * scripts run, then scans the blocks they produced for contract creations sent
 * by the deployer, and names each one by matching its creation input against
 * the compiled artifacts. That covers hand-written scripts too, with no
 * cooperation from them.
 *
 * Not seen: contracts created by another contract (a factory - the
 * transaction's `to` is the factory, not null), anything deployed with a key
 * other than the injected PRIVATE_KEY, and contracts whose artifact still has
 * unlinked library placeholders (its bytecode is then not a prefix of the
 * linked input). The last kind is listed as unrecognised rather than dropped.
 */

export {
  RECORD_FORMAT,
  findRecordsByAddress,
  networkDir,
  readRecord,
  writeRecord,
} from "./records";
export type { DeploymentRecord } from "./records";
export {
  codeMatchesArtifact,
  loadArtifactBytecodes,
  matchArtifact,
  verifyDeployed,
} from "./artifacts";
export type { ArtifactBytecode } from "./artifacts";
export {
  MAX_SCAN_BLOCKS,
  recordAndSummarise,
  scanDeployments,
  startRecording,
} from "./recording";
export type { FoundCreation } from "./recording";
