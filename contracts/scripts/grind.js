/**
 * Quai only accepts a contract address that lies in the creating zone and on the Quai (not Qi) ledger. For CREATE2
 * through the GremlinEconomics factory, the gremlin grinds a salt off-chain until the predicted address qualifies.
 */
const { getCreate2Address, getZoneForAddress, isQuaiAddress, keccak256, toUtf8Bytes } = require("quais");

function grindSalt(factory, initCodeHash, zone, seed = "gremlin", maxTries = 1_000_000) {
  for (let i = 0; i < maxTries; i++) {
    const salt = keccak256(toUtf8Bytes(`${seed}:${i}`));
    const address = getCreate2Address(factory, salt, initCodeHash);
    if (getZoneForAddress(address) === zone && isQuaiAddress(address)) return { salt, address, tries: i + 1 };
  }
  throw new Error(`no salt found in ${maxTries} tries`);
}

module.exports = { grindSalt };
