/**
 * Deploy the GremlinEconomics factory to Quai (zone cyprus1, chainId 9) with quais, then smoke-test it: create a
 * PatronBox through the factory with a salt ground off-chain so the CREATE2 address lands in the deployer's zone
 * on the Quai ledger, and check its code and owner.
 *
 *   npx hardhat compile
 *   QUAI_RPC_URL=https://rpc.quai.network/cyprus1 QUAI_PRIVATE_KEY=0x... node scripts/deploy-economics-quai.js
 *
 * Env: QUAI_RPC_URL, QUAI_PRIVATE_KEY, optional GAS_LIMIT, GAS_PRICE_WEI, IPFS_HASH, EXPECTED_CHAIN_ID (default 9),
 * SKIP_SMOKE=1, FACTORY (reuse an existing deployment and only run the smoke test).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ContractFactory, Contract, JsonRpcProvider, Wallet, formatQuai, getZoneForAddress, isQuaiAddress, getCreate2Address, keccak256, solidityPacked, toUtf8Bytes, AbiCoder } = require("quais");
const { grindSalt } = require("./grind.js");

const PLACEHOLDER_IPFS_HASH = "Qm11111111111111111111111111111111111111111111";

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
  if (network.chainId !== expectedChainId) throw new Error(`Refusing to deploy: chainId ${network.chainId}, expected ${expectedChainId}.`);
  const wallet = new Wallet(pk, provider);
  const zone = getZoneForAddress(wallet.address);
  console.log("deployer:", wallet.address, "zone:", zone, "balance:", formatQuai(await provider.getBalance(wallet.address)), "QUAI");

  const overrides = {};
  if (process.env.GAS_LIMIT) overrides.gasLimit = BigInt(process.env.GAS_LIMIT);
  if (process.env.GAS_PRICE_WEI) overrides.gasPrice = BigInt(process.env.GAS_PRICE_WEI);

  const econ = artifact("GremlinEconomics");
  let address = process.env.FACTORY;
  let txHash;
  if (!address) {
    const factory = new ContractFactory(econ.abi, econ.bytecode, wallet);
    factory.setIPFSHash(process.env.IPFS_HASH || PLACEHOLDER_IPFS_HASH);
    const deployed = await factory.deploy(overrides);
    txHash = deployed.deploymentTransaction().hash;
    console.log("deploy tx:", txHash);
    await deployed.waitForDeployment();
    address = await deployed.getAddress();
    console.log("GremlinEconomics:", address, "zone:", getZoneForAddress(address));
    const out = path.join(__dirname, "..", "deployments", `economics-${network.chainId}.json`);
    fs.writeFileSync(out, JSON.stringify({ chainId: network.chainId.toString(), factory: address, tx: txHash, deployer: wallet.address, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    console.log("wrote", out);
  }
  if (process.env.SKIP_SMOKE) return;

  // Smoke test: zone-aware CREATE2 through the factory.
  const f = new Contract(address, econ.abi, wallet);
  const box = artifact("PatronBox");
  const initCode = solidityPacked(["bytes", "bytes"], [box.bytecode, AbiCoder.defaultAbiCoder().encode(["address"], [wallet.address])]);
  const { salt, address: predicted, tries } = grindSalt(address, keccak256(initCode), zone, `smoke-${Date.now()}`);
  const onChainPredicted = await f.predictPatronBox(wallet.address, salt);
  if (onChainPredicted.toLowerCase() !== predicted.toLowerCase()) throw new Error(`prediction mismatch: local ${predicted}, factory ${onChainPredicted}`);
  console.log(`ground salt in ${tries} tries →`, predicted);
  const tx = await f.createPatronBox(salt, overrides);
  console.log("createPatronBox tx:", tx.hash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("createPatronBox reverted");
  const code = await provider.getCode(predicted);
  if (code === "0x") throw new Error("no code at the predicted address");
  const created = new Contract(predicted, box.abi, provider);
  const owner = await created.gremlin();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`PatronBox gremlin ${owner}, expected ${wallet.address}`);
  console.log("smoke test OK: PatronBox", predicted, "owned by", owner);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
