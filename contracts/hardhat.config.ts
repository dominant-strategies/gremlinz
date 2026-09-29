import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

// Quai mainnet: zone cyprus1, chainId 9. Solidity 0.8.24 (default EVM target "shanghai") is the
// version/target proven on Quai mainnet by the QNS contracts. Deploys to Quai go through quais
// (scripts/deploy-quai.js), NOT `hardhat run`, because Quai needs zone-aware contract-address grinding.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "shanghai",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // The local test network runs with chainId 9 so the EIP-712 domain matches packages/hatch exactly.
    hardhat: { chainId: 9 },
  },
};

export default config;
