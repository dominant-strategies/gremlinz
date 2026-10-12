// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SyndicateVault} from "./SyndicateVault.sol";
import {PatronBox} from "./PatronBox.sol";
import {RevenueSplitter} from "./RevenueSplitter.sol";

/**
 * @title GremlinEconomics
 * @notice Factory for a gremlin's economic contracts. The caller is always the gremlin, so a contract created here
 * provably belongs to the gremlin that created it (the board lists only these). CREATE2 with a caller-chosen salt:
 * on Quai the salt is ground off-chain so the address lands in the right zone and on the Quai ledger
 * (see `predict*`). No admin, no fees, no upgrades.
 */
contract GremlinEconomics {
    enum Kind { MakerSplit, Patrons, Syndicate, Quest }

    event Created(address indexed gremlin, Kind indexed kind, address contractAddress);

    function createSplitter(address recipient, uint16 bps, bytes32 salt) external returns (address a) {
        a = address(new RevenueSplitter{salt: salt}(msg.sender, recipient, bps));
        emit Created(msg.sender, Kind.MakerSplit, a);
    }

    function createPatronBox(bytes32 salt) external returns (address a) {
        a = address(new PatronBox{salt: salt}(msg.sender));
        emit Created(msg.sender, Kind.Patrons, a);
    }

    /// @notice `p.gremlin` is ignored and set to the caller.
    function createSyndicate(SyndicateVault.Params memory p, bytes32 salt) external returns (address a) {
        p.gremlin = msg.sender;
        a = address(new SyndicateVault{salt: salt}(p));
        emit Created(msg.sender, p.fundingTarget > 0 ? Kind.Quest : Kind.Syndicate, a);
    }

    // ── address prediction (for zone-aware salt grinding) ────────────────────────────────────────────────

    function predictSplitter(address gremlin, address recipient, uint16 bps, bytes32 salt) external view returns (address) {
        return _predict(salt, abi.encodePacked(type(RevenueSplitter).creationCode, abi.encode(gremlin, recipient, bps)));
    }

    function predictPatronBox(address gremlin, bytes32 salt) external view returns (address) {
        return _predict(salt, abi.encodePacked(type(PatronBox).creationCode, abi.encode(gremlin)));
    }

    function predictSyndicate(SyndicateVault.Params memory p, bytes32 salt) external view returns (address) {
        return _predict(salt, abi.encodePacked(type(SyndicateVault).creationCode, abi.encode(p)));
    }

    function _predict(bytes32 salt, bytes memory initCode) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode))))));
    }
}
