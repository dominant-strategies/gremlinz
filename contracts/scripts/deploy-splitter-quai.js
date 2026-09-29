/**
 * Deploy a RevenueSplitter from the gremlin's own key (the gremlin is the deployer and the `gremlin` arg).
 * Reference for the runtime; the runtime will normally do this in-process.
 *
 *   QUAI_RPC_URL=... QUAI_PRIVATE_KEY=<gremlin key> SPLITTER_RECIPIENT=0x... SPLITTER_BPS=500 \
 *     node scripts/deploy-splitter-quai.js
 *
 * Afterwards the gremlin calls GremlinRegistry.setSplitter(splitter) (or passes it to register()).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ContractFactory, JsonRpcProvider, Wallet, getAddress, getZoneForAddress } = require("quais");

const PLACEHOLDER_IPFS_HASH = "Qm11111111111111111111111111111111111111111111";

async function main() {
  const { QUAI_RPC_URL: rpcUrl, QUAI_PRIVATE_KEY: pk, SPLITTER_RECIPIENT, SPLITTER_BPS } = process.env;
  if (!rpcUrl || !pk) throw new Error("Set QUAI_RPC_URL and QUAI_PRIVATE_KEY.");
  if (!SPLITTER_RECIPIENT || !SPLITTER_BPS) throw new Error("Set SPLITTER_RECIPIENT and SPLITTER_BPS (1..10000).");
  const bps = Number(SPLITTER_BPS);
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error("SPLITTER_BPS must be an integer in 1..10000.");
  const expectedChainId = BigInt(process.env.EXPECTED_CHAIN_ID || "9");

  const provider = new JsonRpcProvider(rpcUrl, undefined, { usePathing: false });
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) throw new Error(`chainId ${network.chainId}, expected ${expectedChainId}.`);
  const wallet = new Wallet(pk, provider);
  const recipient = getAddress(SPLITTER_RECIPIENT);

  const file = path.join(__dirname, "..", "artifacts", "contracts", "RevenueSplitter.sol", "RevenueSplitter.json");
  const { abi, bytecode } = JSON.parse(fs.readFileSync(file, "utf8"));
  const factory = new ContractFactory(abi, bytecode, wallet);
  factory.setIPFSHash(process.env.IPFS_HASH || PLACEHOLDER_IPFS_HASH);
  const splitter = await factory.deploy(wallet.address, recipient, bps);
  console.log("deploy tx:", splitter.deploymentTransaction().hash);
  await splitter.waitForDeployment();
  const address = await splitter.getAddress();
  console.log("RevenueSplitter:", address, "zone:", getZoneForAddress(address));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
