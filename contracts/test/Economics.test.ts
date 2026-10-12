import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const Q = (n: number | string) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;

type Params = {
  gremlin: string; maker: string; makerBps: number; incomeKeepBps: number; mgmtFeeBps: number; drawBps: number;
  dissolveBps: number; inactivityPeriod: number; goalHash: string; fundingTarget: bigint; fundingDeadline: number; questDeadline: number;
};

async function base(over: Partial<Params> = {}): Promise<Params> {
  const [gremlin, maker] = await ethers.getSigners();
  return {
    gremlin: gremlin.address, maker: maker.address, makerBps: 1000, incomeKeepBps: 3000, mgmtFeeBps: 0, drawBps: 2000,
    dissolveBps: 6667, inactivityPeriod: 90 * DAY, goalHash: ethers.ZeroHash, fundingTarget: 0n, fundingDeadline: 0, questDeadline: 0,
    ...over,
  };
}

describe("SyndicateVault (open-ended)", () => {
  async function deploy() {
    const [gremlin, maker, alice, bob, carol, customer] = await ethers.getSigners();
    const vault = await ethers.deployContract("SyndicateVault", [await base()]);
    return { vault, gremlin, maker, alice, bob, carol, customer };
  }

  it("validates params", async () => {
    const F = await ethers.getContractFactory("SyndicateVault");
    await expect(F.deploy(await base({ makerBps: 6000, incomeKeepBps: 5000 }))).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(await base({ mgmtFeeBps: 1001 }))).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(await base({ drawBps: 0 }))).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(await base({ dissolveBps: 4000 }))).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(await base({ inactivityPeriod: DAY }))).to.be.revertedWithCustomError(F, "InvalidParams");
    await expect(F.deploy(await base({ goalHash: ethers.id("x") }))).to.be.revertedWithCustomError(F, "InvalidParams");
  });

  it("splits income: maker cut, gremlin's share, rest to backers pro rata", async () => {
    const { vault, maker, alice, bob, customer } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(3) });
    await vault.connect(bob).contribute({ value: Q(1) });
    await customer.sendTransaction({ to: await vault.getAddress(), value: Q(10) });
    expect(await vault.owedMaker()).to.equal(Q(1));
    expect(await vault.owedGremlin()).to.equal(Q(3));
    expect(await vault.dividendsOf(alice.address)).to.equal(Q("4.5"));
    expect(await vault.dividendsOf(bob.address)).to.equal(Q("1.5"));
    await expect(vault.connect(alice).withdraw()).to.changeEtherBalance(alice, Q("4.5"));
    await expect(vault.connect(maker).withdrawMaker()).to.changeEtherBalance(maker, Q(1));
    await expect(vault.connect(alice).withdraw()).to.be.revertedWithCustomError(vault, "NothingOwed");
  });

  it("prices later contributions at current value per share, so earlier backers are not diluted", async () => {
    const { vault, gremlin, alice, bob } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(10) }); // 10 shares at 1
    await vault.connect(gremlin).reportValue(Q(10)); // the business is worth 10 more outside the vault
    await vault.connect(bob).contribute({ value: Q(10) }); // nav 20 for 10 shares → bob gets 5
    expect(await vault.shares(bob.address)).to.equal(Q(5));
    // the report goes stale after 30 days and stops counting
    await time.increase(31 * DAY);
    expect(await vault.nav()).to.equal(Q(20));
  });

  it("refuses to price shares when nothing is known about value", async () => {
    const [gremlin, , alice, bob] = await ethers.getSigners();
    const vault = await ethers.deployContract("SyndicateVault", [await base({ drawBps: 10_000 })]);
    await vault.connect(alice).contribute({ value: Q(1) });
    await vault.connect(gremlin).draw(Q(1)); // all capital is now out in the world
    await expect(vault.connect(bob).contribute({ value: Q(1) })).to.be.revertedWithCustomError(vault, "PriceUnknown");
    await vault.connect(gremlin).reportValue(Q(2)); // the gremlin says what it's worth
    await vault.connect(bob).contribute({ value: Q(1) });
    expect(await vault.shares(bob.address)).to.equal(Q("0.5"));
  });

  it("raises this epoch's allowance when new capital arrives mid-epoch", async () => {
    const { vault, gremlin, alice, bob } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(50) });
    await vault.connect(gremlin).draw(Q(10));
    await vault.connect(bob).contribute({ value: Q(50) });
    expect(await vault.drawable()).to.equal(Q(10)); // 20% of 100 minus the 10 already drawn
  });

  it("limits draws to drawBps of capital per 30-day epoch", async () => {
    const { vault, gremlin, alice } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(100) });
    expect(await vault.drawable()).to.equal(Q(20));
    await expect(vault.connect(gremlin).draw(Q(15))).to.changeEtherBalance(gremlin, Q(15));
    expect(await vault.drawable()).to.equal(Q(5));
    await expect(vault.connect(gremlin).draw(Q(6))).to.be.revertedWithCustomError(vault, "OverAllowance");
    await expect(vault.connect(alice).draw(Q(1))).to.be.revertedWithCustomError(vault, "NotGremlin");
    await time.increase(30 * DAY);
    expect(await vault.drawable()).to.equal(Q(17)); // 20% of the 85 left
  });

  it("streams a yearly management fee from capital to the gremlin", async () => {
    const [gremlin, , alice] = await ethers.getSigners();
    const vault = await ethers.deployContract("SyndicateVault", [await base({ mgmtFeeBps: 200 })]);
    await vault.connect(alice).contribute({ value: Q(100) });
    await time.increase(365 * DAY);
    await vault.connect(gremlin).checkIn();
    await expect(vault.connect(gremlin).withdrawGremlin()).to.changeEtherBalance(gremlin, (v: bigint) => v > Q("1.99") && v <= Q("2.01"));
    expect(await vault.capital()).to.be.closeTo(Q(98), Q("0.01"));
  });

  it("dissolves on a backer supermajority and returns remaining capital pro rata", async () => {
    const { vault, gremlin, alice, bob, carol } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(60) });
    await vault.connect(bob).contribute({ value: Q(10) });
    await vault.connect(carol).contribute({ value: Q(30) });
    await vault.connect(gremlin).draw(Q(20)); // 80 left
    await vault.connect(alice).voteDissolve(true); // 60%
    expect(await vault.dissolvable()).to.equal("");
    await expect(vault.connect(carol).dissolve()).to.be.revertedWithCustomError(vault, "NotDissolvable");
    await vault.connect(bob).voteDissolve(true); // 70%
    expect(await vault.dissolvable()).to.equal("backers voted");
    await expect(vault.connect(carol).dissolve()).to.emit(vault, "Dissolved").withArgs("backers voted", Q(80));
    expect(await vault.dividendsOf(alice.address)).to.be.closeTo(Q(48), 2n); // rounding dust carries forward
    expect(await vault.dividendsOf(carol.address)).to.be.closeTo(Q(24), 2n);
    await expect(vault.connect(gremlin).draw(1)).to.be.revertedWithCustomError(vault, "Closed");
    await expect(vault.connect(carol).contribute({ value: Q(1) })).to.be.revertedWithCustomError(vault, "Closed");
  });

  it("counts new shares of someone who already voted", async () => {
    const { vault, alice, bob } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(50) });
    await vault.connect(bob).contribute({ value: Q(50) });
    await vault.connect(alice).voteDissolve(true);
    await vault.connect(alice).contribute({ value: Q(100) }); // alice now 150/200 = 75%
    expect(await vault.dissolvable()).to.equal("backers voted");
    await vault.connect(alice).voteDissolve(false);
    expect(await vault.dissolveVotes()).to.equal(0n);
  });

  it("lets anyone dissolve when the gremlin goes quiet", async () => {
    const { vault, alice, carol } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(10) });
    await time.increase(91 * DAY);
    expect(await vault.dissolvable()).to.equal("gremlin went quiet");
    await vault.connect(carol).dissolve();
    expect(await vault.dividendsOf(alice.address)).to.equal(Q(10));
  });

  it("pays direct dividends to backers with no cuts, and treats forced sends as income", async () => {
    const { vault, gremlin, alice } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(1) });
    await vault.connect(gremlin).payDividend({ value: Q(2) });
    expect(await vault.dividendsOf(alice.address)).to.equal(Q(2));
    expect(await vault.owedGremlin()).to.equal(0n);
    await vault.sync(); // nothing unaccounted
    expect(await vault.dividendsOf(alice.address)).to.equal(Q(2));
  });

  it("does not give new backers a cut of dividends paid before they joined", async () => {
    const { vault, alice, bob, customer } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(1) });
    await customer.sendTransaction({ to: await vault.getAddress(), value: Q(10) }); // 6 to backers
    await vault.connect(bob).contribute({ value: Q(1) });
    expect(await vault.dividendsOf(bob.address)).to.equal(0n);
    expect(await vault.dividendsOf(alice.address)).to.equal(Q(6));
  });
});

describe("SyndicateVault (quest)", () => {
  async function deploy() {
    const [gremlin, maker, alice, bob, customer] = await ethers.getSigners();
    const now = await time.latest();
    const p = await base({ goalHash: ethers.id("Build 10 weather stations"), fundingTarget: Q(100), fundingDeadline: now + 14 * DAY, questDeadline: now + 180 * DAY, mgmtFeeBps: 100 });
    const vault = await ethers.deployContract("SyndicateVault", [p]);
    return { vault, gremlin, maker, alice, bob, customer };
  }

  it("takes contributions 1:1 up to the target, then opens draws", async () => {
    const { vault, gremlin, alice, bob } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(60) });
    await expect(vault.connect(gremlin).draw(Q(1))).to.be.revertedWithCustomError(vault, "NotFunded");
    await expect(vault.connect(bob).contribute({ value: Q(41) })).to.be.revertedWithCustomError(vault, "OverTarget");
    await expect(vault.connect(bob).contribute({ value: Q(40) })).to.emit(vault, "Funded").withArgs(Q(100));
    expect(await vault.shares(bob.address)).to.equal(Q(40));
    await expect(vault.connect(bob).contribute({ value: Q(1) })).to.be.revertedWithCustomError(vault, "FundingClosed");
    await vault.connect(gremlin).draw(Q(19)); // 20% of capital, less a few seconds of management fee
  });

  it("refunds everyone in full if the target is missed", async () => {
    const { vault, alice, bob } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(30) });
    await vault.connect(bob).contribute({ value: Q(20) });
    await time.increase(15 * DAY);
    expect(await vault.dissolvable()).to.equal("funding target missed");
    await vault.dissolve();
    await expect(vault.connect(alice).withdraw()).to.changeEtherBalance(alice, Q(30));
    await expect(vault.connect(bob).withdraw()).to.changeEtherBalance(bob, Q(20));
  });

  it("dissolves and returns what's left when the gremlin completes the quest", async () => {
    const { vault, gremlin, alice, bob, customer } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(75) });
    await vault.connect(bob).contribute({ value: Q(25) });
    await vault.connect(gremlin).draw(Q(19));
    await customer.sendTransaction({ to: await vault.getAddress(), value: Q(10) }); // 6 to backers
    await expect(vault.connect(alice).completeQuest("ipfs://evidence")).to.be.revertedWithCustomError(vault, "NotGremlin");
    await expect(vault.connect(gremlin).completeQuest("https://gremlinz.ai/p/42")).to.emit(vault, "QuestCompleted");
    expect(await vault.questCompleted()).to.equal(true);
    const left = (await vault.dividendsOf(alice.address)) + (await vault.dividendsOf(bob.address));
    // 81 capital minus a few seconds of fee, plus 6 of income
    expect(left).to.be.closeTo(Q(87), Q("0.001"));
    expect(await vault.dividendsOf(alice.address)).to.be.closeTo((left * 3n) / 4n, 10n);
  });

  it("dissolves when the quest deadline passes", async () => {
    const { vault, alice } = await loadFixture(deploy);
    await vault.connect(alice).contribute({ value: Q(100) });
    await time.increase(181 * DAY);
    expect(await vault.dissolvable()).to.equal("quest deadline passed");
  });
});

describe("PatronBox", () => {
  it("records gifts and forwards everything to the gremlin", async () => {
    const [gremlin, alice, bob] = await ethers.getSigners();
    const box = await ethers.deployContract("PatronBox", [gremlin.address]);
    await expect(box.connect(alice).give("keep going", { value: Q(2) })).to.emit(box, "Gift").withArgs(alice.address, Q(2), "keep going");
    await bob.sendTransaction({ to: await box.getAddress(), value: Q(1) });
    await box.connect(alice).give("", { value: Q(1) });
    expect(await box.given(alice.address)).to.equal(Q(3));
    expect(await box.patronCount()).to.equal(2n);
    await expect(box.connect(bob).withdraw()).to.changeEtherBalance(gremlin, Q(4));
  });
});

describe("GremlinEconomics factory", () => {
  it("creates contracts owned by the caller at the predicted address", async () => {
    const [gremlin, maker, stranger] = await ethers.getSigners();
    const f = await ethers.deployContract("GremlinEconomics");
    const salt = ethers.id("salt-1");
    const p = await base({ gremlin: stranger.address }); // ignored: the caller becomes the gremlin
    const predicted = await f.predictSyndicate({ ...p, gremlin: gremlin.address }, salt);
    await expect(f.connect(gremlin).createSyndicate(p, salt)).to.emit(f, "Created").withArgs(gremlin.address, 2, predicted);
    const vault = await ethers.getContractAt("SyndicateVault", predicted);
    expect(await vault.gremlin()).to.equal(gremlin.address);

    const boxAt = await f.predictPatronBox(gremlin.address, salt);
    await expect(f.connect(gremlin).createPatronBox(salt)).to.emit(f, "Created").withArgs(gremlin.address, 1, boxAt);
    const splitAt = await f.predictSplitter(gremlin.address, maker.address, 1000, salt);
    await expect(f.connect(gremlin).createSplitter(maker.address, 1000, salt)).to.emit(f, "Created").withArgs(gremlin.address, 0, splitAt);
  });
});
