import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const ONE = ethers.parseEther("1");

describe("RevenueSplitter", () => {
  async function deploy() {
    const [gremlin, maker, payer, stranger] = await ethers.getSigners();
    const splitter = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 2500], gremlin);
    return { splitter, gremlin, maker, payer, stranger };
  }

  async function withRejectingRecipient() {
    const [gremlin, , payer, stranger] = await ethers.getSigners();
    const payee = await ethers.deployContract("TogglePayee");
    const splitter = await ethers.deployContract("RevenueSplitter", [gremlin.address, await payee.getAddress(), 3000], gremlin);
    return { splitter, payee, gremlin, payer, stranger };
  }

  describe("constructor", () => {
    it("stores immutable args", async () => {
      const { splitter, gremlin, maker } = await loadFixture(deploy);
      expect(await splitter.gremlin()).to.equal(gremlin.address);
      expect(await splitter.recipient()).to.equal(maker.address);
      expect(await splitter.bps()).to.equal(2500n);
    });

    it("rejects bps outside 1..10000 and bad addresses", async () => {
      const [a, b] = await ethers.getSigners();
      const F = await ethers.getContractFactory("RevenueSplitter");
      await expect(F.deploy(a.address, b.address, 0)).to.be.revertedWithCustomError(F, "InvalidBps");
      await expect(F.deploy(a.address, b.address, 10001)).to.be.revertedWithCustomError(F, "InvalidBps");
      await expect(F.deploy(ethers.ZeroAddress, b.address, 1)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(a.address, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(a.address, a.address, 1)).to.be.revertedWithCustomError(F, "SameAddress");
      await F.deploy(a.address, b.address, 1);
      await F.deploy(a.address, b.address, 10000);
    });
  });

  describe("native QUAI", () => {
    it("splits on receive and pays out via release", async () => {
      const { splitter, gremlin, maker, payer } = await loadFixture(deploy);
      const addr = await splitter.getAddress();
      await expect(payer.sendTransaction({ to: addr, value: ONE }))
        .to.emit(splitter, "Split")
        .withArgs(ONE, ONE / 4n, (ONE * 3n) / 4n, 2500);
      expect(await splitter.owedRecipient()).to.equal(ONE / 4n);
      expect(await splitter.owedGremlin()).to.equal((ONE * 3n) / 4n);
      await expect(splitter.connect(payer).release()).to.changeEtherBalances([gremlin, maker, splitter], [(ONE * 3n) / 4n, ONE / 4n, -ONE]);
      expect(await splitter.owedGremlin()).to.equal(0n);
      expect(await splitter.owedRecipient()).to.equal(0n);
    });

    it("rounds the recipient's share down (dust goes to the gremlin)", async () => {
      const [gremlin, maker, payer] = await ethers.getSigners();
      const splitter = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 3333]);
      const addr = await splitter.getAddress();
      await payer.sendTransaction({ to: addr, value: 1n }); // 1*3333/10000 = 0
      expect(await splitter.owedRecipient()).to.equal(0n);
      expect(await splitter.owedGremlin()).to.equal(1n);
      await payer.sendTransaction({ to: addr, value: 10_001n }); // 3333.33 -> 3333
      expect(await splitter.owedRecipient()).to.equal(3333n);
      expect(await splitter.owedGremlin()).to.equal(1n + 6668n);
      // every wei accounted for
      expect((await splitter.owedRecipient()) + (await splitter.owedGremlin())).to.equal(await ethers.provider.getBalance(addr));
    });

    it("bps = 10000 sends everything to the recipient", async () => {
      const [gremlin, maker, payer] = await ethers.getSigners();
      const splitter = await ethers.deployContract("RevenueSplitter", [gremlin.address, maker.address, 10000]);
      await payer.sendTransaction({ to: await splitter.getAddress(), value: 12345n });
      expect(await splitter.owedRecipient()).to.equal(12345n);
      expect(await splitter.owedGremlin()).to.equal(0n);
    });

    it("a reverting recipient does not block the gremlin's share", async () => {
      const { splitter, payee, gremlin, payer } = await loadFixture(withRejectingRecipient);
      const addr = await splitter.getAddress();
      await payer.sendTransaction({ to: addr, value: ONE });
      const toG = (ONE * 7n) / 10n;
      const toR = (ONE * 3n) / 10n;
      // release: gremlin paid, recipient failure accrued, no revert
      const tx = splitter.release();
      await expect(tx).to.changeEtherBalance(gremlin, toG);
      await expect(tx).to.emit(splitter, "PaymentFailed").withArgs(await payee.getAddress(), toR);
      expect(await splitter.owedRecipient()).to.equal(toR);
      // withdraw(gremlin) also works independently; withdraw(recipient) reverts
      await payer.sendTransaction({ to: addr, value: ONE });
      await expect(splitter.withdraw(gremlin.address)).to.changeEtherBalance(gremlin, toG);
      await expect(splitter.withdraw(await payee.getAddress())).to.be.revertedWithCustomError(splitter, "TransferFailed");
      expect(await splitter.owedRecipient()).to.equal(toR * 2n);
      // once the recipient accepts payments again, it can collect everything accrued
      await payee.setRejecting(false);
      await expect(splitter.withdraw(await payee.getAddress())).to.changeEtherBalance(payee, toR * 2n);
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });

    it("withdraw rejects non-payees and empty balances", async () => {
      const { splitter, gremlin, stranger } = await loadFixture(deploy);
      await expect(splitter.withdraw(stranger.address)).to.be.revertedWithCustomError(splitter, "NotPayee");
      await expect(splitter.withdraw(gremlin.address)).to.be.revertedWithCustomError(splitter, "NothingOwed");
    });

    it("re-entering release during a payout fails only that payout", async () => {
      const [gremlin, payer] = await ethers.getSigners();
      const payee = await ethers.deployContract("ReentrantPayee");
      const splitter = await ethers.deployContract("RevenueSplitter", [gremlin.address, await payee.getAddress(), 5000]);
      await payee.setSplitter(await splitter.getAddress());
      await payer.sendTransaction({ to: await splitter.getAddress(), value: 1000n });
      const tx = splitter.release();
      await expect(tx).to.changeEtherBalance(gremlin, 500n);
      await expect(tx).to.emit(splitter, "PaymentFailed");
      expect(await payee.reentered()).to.equal(false); // the re-entrant call reverted, rolling back its flag
      expect(await splitter.owedRecipient()).to.equal(500n);
      expect(await ethers.provider.getBalance(await splitter.getAddress())).to.equal(500n);
    });

    it("picks up balance that arrived without running receive() (forced send)", async () => {
      const { splitter, gremlin, maker, payer } = await loadFixture(deploy);
      const addr = await splitter.getAddress();
      await ethers.deployContract("ForceSend", [addr], { value: 4000n, signer: payer } as any);
      expect(await ethers.provider.getBalance(addr)).to.equal(4000n);
      expect(await splitter.unaccounted()).to.equal(4000n);
      await expect(splitter.sync()).to.emit(splitter, "Split").withArgs(4000n, 1000n, 3000n, 2500);
      await expect(splitter.release()).to.changeEtherBalances([gremlin, maker], [3000n, 1000n]);
    });
  });

  describe("lowerBps", () => {
    it("only the recipient can lower; one-way; can waive to 0", async () => {
      const { splitter, gremlin, maker, stranger, payer } = await loadFixture(deploy);
      await expect(splitter.connect(gremlin).lowerBps(100)).to.be.revertedWithCustomError(splitter, "NotRecipient");
      await expect(splitter.connect(stranger).lowerBps(100)).to.be.revertedWithCustomError(splitter, "NotRecipient");
      await expect(splitter.connect(maker).lowerBps(2500)).to.be.revertedWithCustomError(splitter, "InvalidBps");
      await expect(splitter.connect(maker).lowerBps(3000)).to.be.revertedWithCustomError(splitter, "InvalidBps");
      await expect(splitter.connect(maker).lowerBps(1000)).to.emit(splitter, "BpsLowered").withArgs(2500, 1000);
      await expect(splitter.connect(maker).lowerBps(2000)).to.be.revertedWithCustomError(splitter, "InvalidBps");
      await splitter.connect(maker).lowerBps(0);
      expect(await splitter.bps()).to.equal(0n);
      await expect(splitter.connect(maker).lowerBps(0)).to.be.revertedWithCustomError(splitter, "InvalidBps");
      await payer.sendTransaction({ to: await splitter.getAddress(), value: 999n });
      expect(await splitter.owedGremlin()).to.equal(999n);
      expect(await splitter.owedRecipient()).to.equal(0n);
    });

    it("funds already received are split at the old rate", async () => {
      const { splitter, maker, payer } = await loadFixture(deploy);
      const addr = await splitter.getAddress();
      await ethers.deployContract("ForceSend", [addr], { value: 10000n, signer: payer } as any); // unsynced
      await splitter.connect(maker).lowerBps(0);
      expect(await splitter.owedRecipient()).to.equal(2500n);
      expect(await splitter.owedGremlin()).to.equal(7500n);
    });

    it("a contract recipient can lower via a call", async () => {
      const { splitter, payee } = await loadFixture(withRejectingRecipient);
      await payee.lowerBps(await splitter.getAddress(), 5);
      expect(await splitter.bps()).to.equal(5n);
    });
  });

  describe("ERC20 distribute", () => {
    async function withToken() {
      const f = await deploy();
      const token = await ethers.deployContract("MockERC20");
      return { ...f, token };
    }

    it("splits the token balance by bps with rounding toward the gremlin", async () => {
      const { splitter, token, gremlin, maker } = await loadFixture(withToken);
      const addr = await splitter.getAddress();
      await token.mint(addr, 10_003n);
      await expect(splitter.distribute(await token.getAddress()))
        .to.emit(splitter, "TokenSplit")
        .withArgs(await token.getAddress(), 10_003n, 2500n, 7503n, 2500);
      expect(await token.balanceOf(gremlin.address)).to.equal(7503n);
      expect(await token.balanceOf(maker.address)).to.equal(2500n);
      expect(await token.balanceOf(addr)).to.equal(0n);
      // nothing to do: no-op
      await expect(splitter.distribute(await token.getAddress())).to.not.emit(splitter, "TokenSplit");
    });

    it("uses the current (lowered) bps", async () => {
      const { splitter, token, gremlin, maker } = await loadFixture(withToken);
      await splitter.connect(maker).lowerBps(100);
      await token.mint(await splitter.getAddress(), 1000n);
      await splitter.distribute(await token.getAddress());
      expect(await token.balanceOf(maker.address)).to.equal(10n);
      expect(await token.balanceOf(gremlin.address)).to.equal(990n);
    });

    it("a blocked recipient does not block the gremlin's token share", async () => {
      const { splitter, token, gremlin, maker } = await loadFixture(withToken);
      const t = await token.getAddress();
      const addr = await splitter.getAddress();
      await token.setBlocked(maker.address, true);
      await token.mint(addr, 1000n);
      await expect(splitter.distribute(t)).to.emit(splitter, "TokenPaymentFailed").withArgs(t, maker.address, 250n);
      expect(await token.balanceOf(gremlin.address)).to.equal(750n);
      expect(await splitter.owedToken(t, maker.address)).to.equal(250n);
      expect(await splitter.accountedToken(t)).to.equal(250n);
      // new income is split without touching the accrued amount
      await token.mint(addr, 400n);
      await splitter.distribute(t);
      expect(await token.balanceOf(gremlin.address)).to.equal(1050n);
      expect(await splitter.owedToken(t, maker.address)).to.equal(350n);
      // retry fails while blocked, succeeds after
      await expect(splitter.withdrawToken(t, maker.address)).to.be.revertedWithCustomError(splitter, "TransferFailed");
      await token.setBlocked(maker.address, false);
      await splitter.withdrawToken(t, maker.address);
      expect(await token.balanceOf(maker.address)).to.equal(350n);
      expect(await splitter.accountedToken(t)).to.equal(0n);
      expect(await token.balanceOf(addr)).to.equal(0n);
    });

    it("withdrawToken rejects non-payees and nothing owed", async () => {
      const { splitter, token, gremlin, stranger } = await loadFixture(withToken);
      await expect(splitter.withdrawToken(await token.getAddress(), stranger.address)).to.be.revertedWithCustomError(splitter, "NotPayee");
      await expect(splitter.withdrawToken(await token.getAddress(), gremlin.address)).to.be.revertedWithCustomError(splitter, "NothingOwed");
    });
  });

  it("has no admin surface and no way to raise bps", async () => {
    const { splitter } = await loadFixture(deploy);
    const names = splitter.interface.fragments.filter((f) => f.type === "function").map((f) => (f as any).name as string);
    for (const bad of ["owner", "transferOwnership", "pause", "setBps", "raiseBps", "setRecipient", "setGremlin", "upgradeTo"]) {
      expect(names).to.not.include(bad);
    }
  });
});
