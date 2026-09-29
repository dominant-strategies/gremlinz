import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { TypedDataEncoder, keccak256, toUtf8Bytes, type Signer, type TypedDataDomain } from "ethers";
import * as fs from "fs";
import * as path from "path";

// Must equal packages/hatch/src/signing.ts (checked below by reading that file).
const HATCH_DOMAIN: TypedDataDomain = { name: "Gremlins", version: "1", chainId: 9 };
const HATCH_TYPES = {
  Hatch: [
    { name: "maker", type: "address" },
    { name: "gremlin", type: "address" },
    { name: "configHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
};
const SPAWN_TYPES = {
  Spawn: [
    { name: "parent", type: "address" },
    { name: "configHash", type: "bytes32" },
    { name: "splitter", type: "address" },
    { name: "issuedAt", type: "uint64" },
  ],
};

const cfg = (s: string) => keccak256(toUtf8Bytes(s));
const ZERO = ethers.ZeroAddress;

async function signHatch(maker: Signer, gremlin: string, configHash: string, issuedAt: bigint, domain = HATCH_DOMAIN) {
  const message = { maker: await maker.getAddress(), gremlin, configHash, issuedAt };
  return maker.signTypedData(domain, HATCH_TYPES, message);
}

describe("GremlinRegistry", () => {
  async function deploy() {
    const [maker, gremlin, other, stranger, child, maker2] = await ethers.getSigners();
    const registry = await ethers.deployContract("GremlinRegistry");
    const spawnDomain: TypedDataDomain = { ...HATCH_DOMAIN, verifyingContract: await registry.getAddress() };
    return { registry, maker, gremlin, other, stranger, child, maker2, spawnDomain };
  }

  async function registered() {
    const f = await deploy();
    const h = cfg("config-A");
    const issuedAt = 1_700_000_000n;
    const sig = await signHatch(f.maker, f.gremlin.address, h, issuedAt);
    await f.registry.connect(f.gremlin).register(f.maker.address, h, true, ZERO, issuedAt, sig);
    return { ...f, h, issuedAt, sig };
  }

  describe("EIP-712 compatibility with packages/hatch", () => {
    it("test constants match packages/hatch/src/signing.ts", () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "packages", "hatch", "src", "signing.ts"), "utf8");
      expect(src).to.match(/QUAI_CHAIN_ID\s*=\s*9\b/);
      expect(src).to.match(/HATCH_DOMAIN[^=]*=\s*\{\s*name:\s*'Gremlins',\s*version:\s*'1',\s*chainId:\s*QUAI_CHAIN_ID\s*\}/);
      expect(src).to.not.match(/verifyingContract/);
      const types = src.replace(/\s+/g, "");
      expect(types).to.contain(
        "Hatch:[{name:'maker',type:'address'},{name:'gremlin',type:'address'},{name:'configHash',type:'bytes32'},{name:'issuedAt',type:'uint64'},]",
      );
    });

    it("hardhat network runs with chainId 9", async () => {
      expect((await ethers.provider.getNetwork()).chainId).to.equal(9n);
    });

    it("Solidity hatch domain separator and digest equal ethers TypedDataEncoder", async () => {
      const { registry, maker, gremlin } = await loadFixture(deploy);
      expect(await registry.hatchDomainSeparator()).to.equal(TypedDataEncoder.hashDomain(HATCH_DOMAIN));
      for (const [h, t] of [
        [cfg("x"), 0n],
        [cfg("config-A"), 1_700_000_000n],
        [ethers.hexlify(ethers.randomBytes(32)), 2n ** 64n - 1n],
      ] as const) {
        const message = { maker: maker.address, gremlin: gremlin.address, configHash: h, issuedAt: t };
        expect(await registry.hatchDigest(maker.address, gremlin.address, h, t)).to.equal(TypedDataEncoder.hash(HATCH_DOMAIN, HATCH_TYPES, message));
      }
      expect(await registry.HATCH_TYPEHASH()).to.equal(cfg("Hatch(address maker,address gremlin,bytes32 configHash,uint64 issuedAt)"));
    });

    it("Solidity spawn digest equals ethers TypedDataEncoder", async () => {
      const { registry, maker, other, spawnDomain } = await loadFixture(deploy);
      const message = { parent: maker.address, configHash: cfg("c"), splitter: other.address, issuedAt: 5n };
      expect(await registry.spawnDigest(message.parent, message.configHash, message.splitter, message.issuedAt)).to.equal(
        TypedDataEncoder.hash(spawnDomain, SPAWN_TYPES, message),
      );
    });
  });

  describe("register", () => {
    it("registers a gremlin with a valid maker signature (parent = maker)", async () => {
      const { registry, maker, gremlin } = await loadFixture(deploy);
      const h = cfg("config-A");
      const issuedAt = 1_700_000_000n;
      const sig = await signHatch(maker, gremlin.address, h, issuedAt);
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, issuedAt, sig))
        .to.emit(registry, "GremlinRegistered")
        .withArgs(gremlin.address, maker.address, maker.address, h, ZERO, issuedAt);
      const g = await registry.getGremlin(gremlin.address);
      expect(g.maker).to.equal(maker.address);
      expect(g.parent).to.equal(maker.address);
      expect(g.spawnedBy).to.equal(ZERO);
      expect(g.configHash).to.equal(h);
      expect(g.registeredAt).to.be.greaterThan(0n);
      expect(g.lastSeen).to.equal(g.registeredAt);
      expect(await registry.isGremlin(gremlin.address)).to.equal(true);
      expect(await registry.gremlinByConfigHash(h)).to.equal(gremlin.address);
      expect(await registry.gremlinCount()).to.equal(1n);
      expect(await registry.gremlinAt(0)).to.equal(gremlin.address);
    });

    it("registers an orphan when parentIsMaker = false", async () => {
      const { registry, maker, gremlin } = await loadFixture(deploy);
      const h = cfg("orphan");
      const sig = await signHatch(maker, gremlin.address, h, 1n);
      await registry.connect(gremlin).register(maker.address, h, false, ZERO, 1n, sig);
      expect(await registry.parentOf(gremlin.address)).to.equal(ZERO);
      expect(await registry.isOrphan(gremlin.address)).to.equal(true);
    });

    it("rejects a signature from the wrong signer", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(deploy);
      const h = cfg("config-A");
      // `other` signs a message claiming maker = maker
      const sig = await other.signTypedData(HATCH_DOMAIN, HATCH_TYPES, { maker: maker.address, gremlin: gremlin.address, configHash: h, issuedAt: 1n });
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, sig)).to.be.revertedWithCustomError(
        registry,
        "BadSignature",
      );
    });

    it("rejects tampered fields, a wrong domain, and malformed signatures", async () => {
      const { registry, maker, gremlin } = await loadFixture(deploy);
      const h = cfg("config-A");
      const sig = await signHatch(maker, gremlin.address, h, 1n);
      await expect(registry.connect(gremlin).register(maker.address, cfg("config-B"), true, ZERO, 1n, sig)).to.be.revertedWithCustomError(registry, "BadSignature");
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 2n, sig)).to.be.revertedWithCustomError(registry, "BadSignature");
      const wrongChain = await signHatch(maker, gremlin.address, h, 1n, { ...HATCH_DOMAIN, chainId: 1 });
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, wrongChain)).to.be.revertedWithCustomError(registry, "BadSignature");
      const withContract = await signHatch(maker, gremlin.address, h, 1n, { ...HATCH_DOMAIN, verifyingContract: await registry.getAddress() });
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, withContract)).to.be.revertedWithCustomError(registry, "BadSignature");
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, "0x1234")).to.be.revertedWithCustomError(registry, "BadSignature");
      // high-s (malleated) signature is rejected
      const s = ethers.Signature.from(sig);
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = ethers.concat([s.r, ethers.toBeHex(n - BigInt(s.s), 32), s.v === 27 ? "0x1c" : "0x1b"]);
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, highS)).to.be.revertedWithCustomError(registry, "BadSignature");
    });

    it("rejects zero maker, maker == gremlin, and zero configHash", async () => {
      const { registry, maker, gremlin } = await loadFixture(deploy);
      const sig = await signHatch(maker, gremlin.address, cfg("a"), 1n);
      await expect(registry.connect(gremlin).register(ZERO, cfg("a"), true, ZERO, 1n, sig)).to.be.revertedWithCustomError(registry, "InvalidMaker");
      await expect(registry.connect(maker).register(maker.address, cfg("a"), true, ZERO, 1n, sig)).to.be.revertedWithCustomError(registry, "InvalidMaker");
      const zsig = await signHatch(maker, gremlin.address, ethers.ZeroHash, 1n);
      await expect(registry.connect(gremlin).register(maker.address, ethers.ZeroHash, true, ZERO, 1n, zsig)).to.be.revertedWithCustomError(registry, "ZeroConfigHash");
    });

    it("rejects a second gremlin for an already-used configHash, even with a valid maker signature for it", async () => {
      const { registry, maker, other, h, issuedAt } = await loadFixture(registered);
      const sigForOther = await signHatch(maker, other.address, h, issuedAt);
      await expect(registry.connect(other).register(maker.address, h, true, ZERO, issuedAt, sigForOther))
        .to.be.revertedWithCustomError(registry, "ConfigHashUsed")
        .withArgs(h);
    });

    it("rejects a signature naming a different gremlin (tampered gremlin field)", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(deploy);
      const h = cfg("for-other");
      const sigForOther = await signHatch(maker, other.address, h, 1n);
      await expect(registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, sigForOther)).to.be.revertedWithCustomError(registry, "BadSignature");
    });

    it("squatting is rejected: a public signed config can only be registered by the gremlin it names", async () => {
      const { registry, maker, gremlin, stranger } = await loadFixture(deploy);
      const h = cfg("public-config");
      const sig = await signHatch(maker, gremlin.address, h, 1n);
      // a squatter replaying the maker's (public) signature from its own address fails: msg.sender != gremlin
      await expect(registry.connect(stranger).register(maker.address, h, true, ZERO, 1n, sig)).to.be.revertedWithCustomError(registry, "BadSignature");
      expect(await registry.gremlinByConfigHash(h)).to.equal(ZERO);
      expect(await registry.isGremlin(stranger.address)).to.equal(false);
      // the named gremlin can still register
      await registry.connect(gremlin).register(maker.address, h, true, ZERO, 1n, sig);
      expect(await registry.gremlinByConfigHash(h)).to.equal(gremlin.address);
    });

    it("rejects double registration of the same gremlin", async () => {
      const { registry, maker, gremlin } = await loadFixture(registered);
      const h2 = cfg("config-B");
      const sig2 = await signHatch(maker, gremlin.address, h2, 1n);
      await expect(registry.connect(gremlin).register(maker.address, h2, true, ZERO, 1n, sig2))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered")
        .withArgs(gremlin.address);
    });

    it("validates the splitter: must be a contract whose gremlin() is the caller", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(deploy);
      const h = cfg("s");
      const sig = await signHatch(maker, gremlin.address, h, 1n);
      await expect(registry.connect(gremlin).register(maker.address, h, true, other.address, 1n, sig)).to.be.revertedWithCustomError(registry, "BadSplitter");
      const wrong = await ethers.deployContract("RevenueSplitter", [other.address, maker.address, 1000]);
      await expect(registry.connect(gremlin).register(maker.address, h, true, await wrong.getAddress(), 1n, sig)).to.be.revertedWithCustomError(registry, "BadSplitter");
      const noGetter = await ethers.deployContract("MockERC20");
      await expect(registry.connect(gremlin).register(maker.address, h, true, await noGetter.getAddress(), 1n, sig)).to.be.revertedWithCustomError(registry, "BadSplitter");
      const good = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 1000], gremlin);
      await registry.connect(gremlin).register(maker.address, h, true, await good.getAddress(), 1n, sig);
      expect((await registry.getGremlin(gremlin.address)).splitter).to.equal(await good.getAddress());
    });

    it("setSplitter: one time, gremlin only, validated", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(registered);
      const good = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 1000], gremlin);
      await expect(registry.connect(other).setSplitter(await good.getAddress())).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(gremlin).setSplitter(ZERO)).to.be.revertedWithCustomError(registry, "BadSplitter");
      await expect(registry.connect(gremlin).setSplitter(await good.getAddress()))
        .to.emit(registry, "SplitterSet")
        .withArgs(gremlin.address, await good.getAddress());
      const another = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 1], gremlin);
      await expect(registry.connect(gremlin).setSplitter(await another.getAddress())).to.be.revertedWithCustomError(registry, "SplitterAlreadySet");
    });
  });

  describe("parent / orphan / adoption", () => {
    it("parent can renounce; others cannot; orphan cannot be renounced again", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(registered);
      await expect(registry.connect(other).renounce(gremlin.address)).to.be.revertedWithCustomError(registry, "NotParent");
      await expect(registry.connect(gremlin).renounce(gremlin.address)).to.be.revertedWithCustomError(registry, "NotParent");
      await expect(registry.connect(maker).renounce(other.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(maker).renounce(gremlin.address)).to.emit(registry, "Renounced").withArgs(gremlin.address, maker.address);
      expect(await registry.isOrphan(gremlin.address)).to.equal(true);
      await expect(registry.connect(maker).renounce(gremlin.address)).to.be.revertedWithCustomError(registry, "IsOrphan");
    });

    it("anyone can propose; only the gremlin can accept; only while orphaned", async () => {
      const { registry, maker, gremlin, other, stranger } = await loadFixture(registered);
      await expect(registry.connect(other).proposeAdoption(stranger.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(gremlin).proposeAdoption(gremlin.address)).to.be.revertedWithCustomError(registry, "SelfAdoption");
      await expect(registry.connect(other).proposeAdoption(gremlin.address)).to.emit(registry, "AdoptionProposed").withArgs(gremlin.address, other.address);
      expect(await registry.adoptionProposed(gremlin.address, other.address)).to.equal(true);

      // not an orphan yet
      await expect(registry.connect(gremlin).acceptAdoption(other.address)).to.be.revertedWithCustomError(registry, "NotOrphan");
      await registry.connect(maker).renounce(gremlin.address);

      // only the gremlin can accept: the proposer or a stranger calling acceptAdoption acts on *their own* record
      await expect(registry.connect(other).acceptAdoption(other.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      await expect(registry.connect(stranger).acceptAdoption(other.address)).to.be.revertedWithCustomError(registry, "NotRegistered");
      // no offer from stranger
      await expect(registry.connect(gremlin).acceptAdoption(stranger.address)).to.be.revertedWithCustomError(registry, "NoAdoptionOffer");

      await expect(registry.connect(gremlin).acceptAdoption(other.address)).to.emit(registry, "Adopted").withArgs(gremlin.address, other.address);
      expect(await registry.parentOf(gremlin.address)).to.equal(other.address);
      expect(await registry.adoptionProposed(gremlin.address, other.address)).to.equal(false);

      // new parent can renounce; old maker cannot
      await expect(registry.connect(maker).renounce(gremlin.address)).to.be.revertedWithCustomError(registry, "NotParent");
      await registry.connect(other).renounce(gremlin.address);
      // consumed offer cannot be reused
      await expect(registry.connect(gremlin).acceptAdoption(other.address)).to.be.revertedWithCustomError(registry, "NoAdoptionOffer");
    });

    it("a proposer can cancel its offer", async () => {
      const { registry, maker, gremlin, other } = await loadFixture(registered);
      await registry.connect(maker).renounce(gremlin.address);
      await expect(registry.connect(other).cancelAdoption(gremlin.address)).to.be.revertedWithCustomError(registry, "NoAdoptionOffer");
      await registry.connect(other).proposeAdoption(gremlin.address);
      await expect(registry.connect(other).cancelAdoption(gremlin.address)).to.emit(registry, "AdoptionCancelled");
      await expect(registry.connect(gremlin).acceptAdoption(other.address)).to.be.revertedWithCustomError(registry, "NoAdoptionOffer");
    });

    it("the original maker can re-adopt after renouncing, with the gremlin's consent", async () => {
      const { registry, maker, gremlin } = await loadFixture(registered);
      await registry.connect(maker).renounce(gremlin.address);
      await registry.connect(maker).proposeAdoption(gremlin.address);
      await registry.connect(gremlin).acceptAdoption(maker.address);
      expect(await registry.parentOf(gremlin.address)).to.equal(maker.address);
    });
  });

  describe("spawnChild", () => {
    async function spawnSig(child: Signer, domain: TypedDataDomain, parent: string, configHash: string, splitter: string, issuedAt: bigint) {
      return child.signTypedData(domain, SPAWN_TYPES, { parent, configHash, splitter, issuedAt });
    }

    it("a registered gremlin registers a consenting child", async () => {
      const { registry, gremlin, child, spawnDomain } = await loadFixture(registered);
      const h = cfg("child-config");
      const sig = await spawnSig(child, spawnDomain, gremlin.address, h, ZERO, 7n);
      await expect(registry.connect(gremlin).spawnChild(child.address, h, ZERO, 7n, sig))
        .to.emit(registry, "GremlinSpawned")
        .withArgs(child.address, gremlin.address, h, ZERO, 7n)
        .and.to.emit(registry, "GremlinRegistered")
        .withArgs(child.address, gremlin.address, gremlin.address, h, ZERO, 7n);
      const c = await registry.getGremlin(child.address);
      expect(c.parent).to.equal(gremlin.address);
      expect(c.spawnedBy).to.equal(gremlin.address);
      expect(c.maker).to.equal(gremlin.address);
      // the parent gremlin can renounce its child
      await registry.connect(gremlin).renounce(child.address);
      expect(await registry.isOrphan(child.address)).to.equal(true);
    });

    it("child can be spawned with its own splitter", async () => {
      const { registry, gremlin, child, spawnDomain } = await loadFixture(registered);
      const splitter = await ethers.deployContract("RevenueSplitter", [child.address, gremlin.address, 500], child);
      const sa = await splitter.getAddress();
      const h = cfg("child-config");
      const sig = await spawnSig(child, spawnDomain, gremlin.address, h, sa, 7n);
      await registry.connect(gremlin).spawnChild(child.address, h, sa, 7n, sig);
      expect((await registry.getGremlin(child.address)).splitter).to.equal(sa);
    });

    it("rejects non-gremlin spawners, missing consent, wrong fields, and duplicates", async () => {
      const { registry, maker, gremlin, child, stranger, spawnDomain, h: usedHash } = await loadFixture(registered);
      const h = cfg("child-config");
      const sig = await spawnSig(child, spawnDomain, gremlin.address, h, ZERO, 7n);

      // non-gremlin caller (even the human maker) cannot spawn
      const makerSig = await spawnSig(child, spawnDomain, maker.address, h, ZERO, 7n);
      await expect(registry.connect(maker).spawnChild(child.address, h, ZERO, 7n, makerSig)).to.be.revertedWithCustomError(registry, "NotRegistered");
      // another gremlin cannot use a signature addressed to `gremlin`
      await expect(registry.connect(stranger).spawnChild(child.address, h, ZERO, 7n, sig)).to.be.revertedWithCustomError(registry, "NotRegistered");
      // signature by someone other than the child
      const forged = await spawnSig(stranger, spawnDomain, gremlin.address, h, ZERO, 7n);
      await expect(registry.connect(gremlin).spawnChild(child.address, h, ZERO, 7n, forged)).to.be.revertedWithCustomError(registry, "BadSignature");
      // tampered fields
      await expect(registry.connect(gremlin).spawnChild(child.address, cfg("other"), ZERO, 7n, sig)).to.be.revertedWithCustomError(registry, "BadSignature");
      // signature for another registry (verifyingContract differs)
      const otherDomain = { ...spawnDomain, verifyingContract: stranger.address };
      const wrongDomain = await spawnSig(child, otherDomain, gremlin.address, h, ZERO, 7n);
      await expect(registry.connect(gremlin).spawnChild(child.address, h, ZERO, 7n, wrongDomain)).to.be.revertedWithCustomError(registry, "BadSignature");
      // invalid child
      await expect(registry.connect(gremlin).spawnChild(gremlin.address, h, ZERO, 7n, sig)).to.be.revertedWithCustomError(registry, "InvalidChild");
      await expect(registry.connect(gremlin).spawnChild(ZERO, h, ZERO, 7n, sig)).to.be.revertedWithCustomError(registry, "InvalidChild");
      // used configHash
      const reuse = await spawnSig(child, spawnDomain, gremlin.address, usedHash, ZERO, 7n);
      await expect(registry.connect(gremlin).spawnChild(child.address, usedHash, ZERO, 7n, reuse)).to.be.revertedWithCustomError(registry, "ConfigHashUsed");

      await registry.connect(gremlin).spawnChild(child.address, h, ZERO, 7n, sig);
      // double spawn of same child
      const h2 = cfg("child-config-2");
      const sig2 = await spawnSig(child, spawnDomain, gremlin.address, h2, ZERO, 8n);
      await expect(registry.connect(gremlin).spawnChild(child.address, h2, ZERO, 8n, sig2)).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });
  });

  describe("heartbeat", () => {
    it("records lastSeen for registered gremlins only", async () => {
      const { registry, gremlin, other } = await loadFixture(registered);
      await expect(registry.connect(other).heartbeat()).to.be.revertedWithCustomError(registry, "NotRegistered");
      await ethers.provider.send("evm_increaseTime", [3600]);
      const tx = await registry.connect(gremlin).heartbeat();
      const block = await ethers.provider.getBlock((await tx.wait())!.blockNumber);
      await expect(tx).to.emit(registry, "Heartbeat").withArgs(gremlin.address, block!.timestamp);
      const g = await registry.getGremlin(gremlin.address);
      expect(g.lastSeen).to.equal(BigInt(block!.timestamp));
      expect(g.lastSeen).to.be.greaterThan(g.registeredAt);
    });
  });

  it("has no owner/admin surface", async () => {
    const { registry } = await loadFixture(deploy);
    const names = registry.interface.fragments.filter((f) => f.type === "function").map((f) => (f as any).name as string);
    for (const bad of ["owner", "transferOwnership", "pause", "unpause", "upgradeTo", "upgradeToAndCall", "kill", "setAdmin"]) {
      expect(names).to.not.include(bad);
    }
  });
});
