/**
 * Deploy GremlinRegistry to Quai (zone cyprus1, chainId 9) with quais.
 *
 *   npx hardhat compile
 *   QUAI_RPC_URL=https://rpc.quai.network/cyprus1 QUAI_PRIVATE_KEY=0x... node scripts/deploy-quai.js
 *
 * quais' ContractFactory grinds a salt appended to the init code so the contract address lands in the
 * deployer's zone and on the Quai (not Qi) ledger. The IPFS hash is required by quais but only used as metadata.
 * Env: QUAI_RPC_URL, QUAI_PRIVATE_KEY, optional GAS_LIMIT, GAS_PRICE_WEI, IPFS_HASH, EXPECTED_CHAIN_ID (default 9).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ContractFactory, Contract, JsonRpcProvider, Wallet, TypedDataEncoder, formatQuai, getZoneForAddress } = require("quais");

const PLACEHOLDER_IPFS_HASH = "Qm11111111111111111111111111111111111111111111"; // 46 chars, as in the QNS deploys

function artifact(name) {
  const file = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run \`npx hardhat compile\` first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const rpcUrl = process.env.QUAI_RPC_URL;
  const pk = process.env.QUAI_PRIVATE_KEY;
  if (!rpcUrl) throw new Error("Set QUAI_RPC_URL (e.g. https://rpc.quai.network/cyprus1).");
  if (!pk) throw new Error("Set QUAI_PRIVATE_KEY.");
  const expectedChainId = BigInt(process.env.EXPECTED_CHAIN_ID || "9");

  const provider = new JsonRpcProvider(rpcUrl, undefined, { usePathing: false });
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) {
    throw new Error(`Refusing to deploy: chainId ${network.chainId}, expected ${expectedChainId}.`);
  }
  const wallet = new Wallet(pk, provider);
  console.log("RPC:", rpcUrl);
  console.log("chainId:", network.chainId.toString());
  console.log("deployer:", wallet.address, "zone:", getZoneForAddress(wallet.address));
  console.log("balance:", formatQuai(await provider.getBalance(wallet.address)), "QUAI");

  const overrides = {};
  if (process.env.GAS_LIMIT) overrides.gasLimit = BigInt(process.env.GAS_LIMIT);
  if (process.env.GAS_PRICE_WEI) overrides.gasPrice = BigInt(process.env.GAS_PRICE_WEI);

  const { abi, bytecode } = artifact("GremlinRegistry");
  const factory = new ContractFactory(abi, bytecode, wallet);
  factory.setIPFSHash(process.env.IPFS_HASH || PLACEHOLDER_IPFS_HASH);
  const registry = await factory.deploy(overrides);
  const tx = registry.deploymentTransaction();
  console.log("deploy tx:", tx.hash);
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  console.log("GremlinRegistry:", address, "zone:", getZoneForAddress(address));

  // Post-deploy check: the on-chain Hatch domain must equal the one packages/hatch signs with.
  const deployed = new Contract(address, abi, provider);
  const expected = TypedDataEncoder.hashDomain({ name: "Gremlins", version: "1", chainId: Number(expectedChainId) });
  const onChain = await deployed.hatchDomainSeparator();
  if (onChain !== expected) {
    throw new Error(`hatchDomainSeparator mismatch: on-chain ${onChain}, expected ${expected}. Do not use this deployment.`);
  }
  console.log("hatchDomainSeparator OK:", onChain);

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `registry-${network.chainId}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ chainId: network.chainId.toString(), registry: address, tx: tx.hash, deployer: wallet.address, deployedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log("wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
