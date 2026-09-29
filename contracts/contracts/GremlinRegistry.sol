// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IGremlinSplitter {
    function gremlin() external view returns (address);
}

/**
 * @title GremlinRegistry
 * @notice Public, ownerless record of gremlins (autonomous agents that hold their own keys).
 *
 * A gremlin registers itself (msg.sender is the gremlin's own EOA) with an EIP-712 "Hatch" signature from its
 * human maker. A registered gremlin can register a child ("spawn") with the child's consent signature.
 * Parents can renounce a gremlin (it becomes an orphan); orphans can accept adoption offers.
 *
 * There is deliberately no owner, admin, pause, kill switch or upgrade path. Nothing here can be changed by
 * anyone other than the parties named in each function.
 */
contract GremlinRegistry {
    // ------------------------------------------------------------------------------------------------------
    // EIP-712
    // ------------------------------------------------------------------------------------------------------

    /// Hatch domain: {name: "Gremlins", version: "1", chainId} with NO verifyingContract. This must match
    /// packages/hatch/src/signing.ts (HATCH_DOMAIN / HATCH_TYPES) byte for byte.
    bytes32 public constant HATCH_DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 public constant HATCH_TYPEHASH = keccak256("Hatch(address maker,address gremlin,bytes32 configHash,uint64 issuedAt)");

    /// Spawn domain additionally binds this registry (verifyingContract), since it is new and has no
    /// off-chain signer to stay compatible with.
    bytes32 public constant SPAWN_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SPAWN_TYPEHASH =
        keccak256("Spawn(address parent,bytes32 configHash,address splitter,uint64 issuedAt)");

    bytes32 private constant NAME_HASH = keccak256("Gremlins");
    bytes32 private constant VERSION_HASH = keccak256("1");

    // ------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------

    struct Gremlin {
        address maker; // human maker (hatch) or spawning gremlin (spawn)
        address parent; // current parent; address(0) = orphan
        address splitter; // RevenueSplitter for this gremlin; address(0) = none
        address spawnedBy; // spawning gremlin; address(0) if hatched by a human maker
        bytes32 configHash; // keccak256 of the canonical config JSON
        uint64 registeredAt; // block timestamp
        uint64 lastSeen; // last heartbeat (block timestamp); registeredAt initially
    }

    mapping(address => Gremlin) private _gremlins;
    /// configHash => gremlin that registered it (each configHash can be used once).
    mapping(bytes32 => address) public gremlinByConfigHash;
    /// gremlin => proposer => open adoption offer.
    mapping(address => mapping(address => bool)) public adoptionProposed;
    address[] private _all;

    // ------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------

    event GremlinRegistered(
        address indexed gremlin,
        address indexed maker,
        address indexed parent,
        bytes32 configHash,
        address splitter,
        uint64 issuedAt
    );
    event GremlinSpawned(address indexed child, address indexed parent, bytes32 configHash, address splitter, uint64 issuedAt);
    event SplitterSet(address indexed gremlin, address indexed splitter);
    event Renounced(address indexed gremlin, address indexed formerParent);
    event AdoptionProposed(address indexed gremlin, address indexed proposer);
    event AdoptionCancelled(address indexed gremlin, address indexed proposer);
    event Adopted(address indexed gremlin, address indexed newParent);
    event Heartbeat(address indexed gremlin, uint64 timestamp);

    // ------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------

    error AlreadyRegistered(address gremlin);
    error NotRegistered(address gremlin);
    error ConfigHashUsed(bytes32 configHash);
    error ZeroConfigHash();
    error InvalidMaker();
    error BadSignature();
    error BadSplitter(address splitter);
    error SplitterAlreadySet();
    error NotParent();
    error IsOrphan();
    error NotOrphan();
    error NoAdoptionOffer();
    error SelfAdoption();
    error InvalidChild();

    // ------------------------------------------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------------------------------------------

    /**
     * @notice Called by the gremlin itself (msg.sender = gremlin EOA).
     * @param maker        human maker who signed the Hatch message
     * @param configHash   hash of the canonical config JSON (the value the maker signed)
     * @param parentIsMaker true: parent = maker; false: registered as an orphan
     * @param splitter     the gremlin's RevenueSplitter or address(0); if set, its gremlin() must be msg.sender
     * @param issuedAt     the Hatch message's issuedAt
     * @param makerSignature 65-byte EIP-712 signature over Hatch(maker, gremlin = msg.sender, configHash, issuedAt).
     *        The signature names the gremlin, so only that address can use it (no squatting).
     */
    function register(
        address maker,
        bytes32 configHash,
        bool parentIsMaker,
        address splitter,
        uint64 issuedAt,
        bytes calldata makerSignature
    ) external {
        if (maker == address(0) || maker == msg.sender) revert InvalidMaker();
        address signer = _recover(hatchDigest(maker, msg.sender, configHash, issuedAt), makerSignature);
        if (signer != maker) revert BadSignature();

        address parent = parentIsMaker ? maker : address(0);
        _record(msg.sender, maker, parent, address(0), configHash, splitter);
        emit GremlinRegistered(msg.sender, maker, parent, configHash, splitter, issuedAt);
    }

    /**
     * @notice Called by a registered gremlin (the parent) to register a child it spawned. The child proves
     * control of its key and consent by signing Spawn(parent, configHash, splitter, issuedAt) under the
     * Spawn domain (which binds this registry). The child's parent, maker and spawnedBy are msg.sender.
     */
    function spawnChild(
        address child,
        bytes32 configHash,
        address splitter,
        uint64 issuedAt,
        bytes calldata childSignature
    ) external {
        if (_gremlins[msg.sender].registeredAt == 0) revert NotRegistered(msg.sender);
        if (child == address(0) || child == msg.sender) revert InvalidChild();
        address signer = _recover(spawnDigest(msg.sender, configHash, splitter, issuedAt), childSignature);
        if (signer != child) revert BadSignature();

        _record(child, msg.sender, msg.sender, msg.sender, configHash, splitter);
        emit GremlinRegistered(child, msg.sender, msg.sender, configHash, splitter, issuedAt);
        emit GremlinSpawned(child, msg.sender, configHash, splitter, issuedAt);
    }

    /// @notice One-time: a gremlin registered without a splitter can record its splitter later.
    function setSplitter(address splitter) external {
        Gremlin storage g = _registered(msg.sender);
        if (g.splitter != address(0)) revert SplitterAlreadySet();
        if (splitter == address(0)) revert BadSplitter(splitter);
        _checkSplitter(splitter, msg.sender);
        g.splitter = splitter;
        emit SplitterSet(msg.sender, splitter);
    }

    // ------------------------------------------------------------------------------------------------------
    // Parent / orphan / adoption
    // ------------------------------------------------------------------------------------------------------

    /// @notice The current parent gives up the gremlin, which becomes an orphan.
    function renounce(address gremlin) external {
        Gremlin storage g = _registered(gremlin);
        if (g.parent == address(0)) revert IsOrphan();
        if (g.parent != msg.sender) revert NotParent();
        g.parent = address(0);
        emit Renounced(gremlin, msg.sender);
    }

    /// @notice Anyone may offer to adopt a registered gremlin. Only the gremlin can accept.
    function proposeAdoption(address gremlin) external {
        _registered(gremlin);
        if (gremlin == msg.sender) revert SelfAdoption();
        adoptionProposed[gremlin][msg.sender] = true;
        emit AdoptionProposed(gremlin, msg.sender);
    }

    /// @notice Withdraw an open adoption offer.
    function cancelAdoption(address gremlin) external {
        if (!adoptionProposed[gremlin][msg.sender]) revert NoAdoptionOffer();
        adoptionProposed[gremlin][msg.sender] = false;
        emit AdoptionCancelled(gremlin, msg.sender);
    }

    /// @notice Called by an orphaned gremlin to accept `newParent`'s open offer.
    function acceptAdoption(address newParent) external {
        Gremlin storage g = _registered(msg.sender);
        if (g.parent != address(0)) revert NotOrphan();
        if (!adoptionProposed[msg.sender][newParent]) revert NoAdoptionOffer();
        adoptionProposed[msg.sender][newParent] = false;
        g.parent = newParent;
        emit Adopted(msg.sender, newParent);
    }

    // ------------------------------------------------------------------------------------------------------
    // Liveness
    // ------------------------------------------------------------------------------------------------------

    function heartbeat() external {
        Gremlin storage g = _registered(msg.sender);
        uint64 nowTs = uint64(block.timestamp);
        g.lastSeen = nowTs;
        emit Heartbeat(msg.sender, nowTs);
    }

    // ------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------

    function isGremlin(address account) external view returns (bool) {
        return _gremlins[account].registeredAt != 0;
    }

    function getGremlin(address gremlin) external view returns (Gremlin memory) {
        return _gremlins[gremlin];
    }

    function parentOf(address gremlin) external view returns (address) {
        return _gremlins[gremlin].parent;
    }

    function isOrphan(address gremlin) external view returns (bool) {
        return _gremlins[gremlin].registeredAt != 0 && _gremlins[gremlin].parent == address(0);
    }

    function gremlinCount() external view returns (uint256) {
        return _all.length;
    }

    function gremlinAt(uint256 index) external view returns (address) {
        return _all[index];
    }

    function hatchDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(HATCH_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid));
    }

    function spawnDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(SPAWN_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice EIP-712 digest a maker signs for Hatch(maker, gremlin, configHash, issuedAt).
    function hatchDigest(address maker, address gremlin, bytes32 configHash, uint64 issuedAt) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(HATCH_TYPEHASH, maker, gremlin, configHash, issuedAt));
        return keccak256(abi.encodePacked("\x19\x01", hatchDomainSeparator(), structHash));
    }

    /// @notice EIP-712 digest a child signs for Spawn(parent, configHash, splitter, issuedAt).
    function spawnDigest(address parent, bytes32 configHash, address splitter, uint64 issuedAt) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SPAWN_TYPEHASH, parent, configHash, splitter, issuedAt));
        return keccak256(abi.encodePacked("\x19\x01", spawnDomainSeparator(), structHash));
    }

    // ------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------

    function _record(
        address gremlin,
        address maker,
        address parent,
        address spawnedBy,
        bytes32 configHash,
        address splitter
    ) private {
        if (configHash == bytes32(0)) revert ZeroConfigHash();
        if (_gremlins[gremlin].registeredAt != 0) revert AlreadyRegistered(gremlin);
        if (gremlinByConfigHash[configHash] != address(0)) revert ConfigHashUsed(configHash);
        if (splitter != address(0)) _checkSplitter(splitter, gremlin);

        uint64 nowTs = uint64(block.timestamp);
        _gremlins[gremlin] = Gremlin({
            maker: maker,
            parent: parent,
            splitter: splitter,
            spawnedBy: spawnedBy,
            configHash: configHash,
            registeredAt: nowTs,
            lastSeen: nowTs
        });
        gremlinByConfigHash[configHash] = gremlin;
        _all.push(gremlin);
    }

    function _registered(address gremlin) private view returns (Gremlin storage g) {
        g = _gremlins[gremlin];
        if (g.registeredAt == 0) revert NotRegistered(gremlin);
    }

    function _checkSplitter(address splitter, address gremlin) private view {
        if (splitter.code.length == 0) revert BadSplitter(splitter);
        try IGremlinSplitter(splitter).gremlin() returns (address g) {
            if (g != gremlin) revert BadSplitter(splitter);
        } catch {
            revert BadSplitter(splitter);
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) revert BadSignature();
        return signer;
    }
}
