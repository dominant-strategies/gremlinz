import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";
import type { GremlinConfig } from "@gremlins/hatch";

const config = (over: Partial<GremlinConfig> = {}): GremlinConfig => ({
  version: 1,
  name: "sprocket",
  persona: "A curious tinkerer who fixes broken things.",
  voice: "warm",
  goals: ["Fund a weather station network", "Write a field guide"],
  preferredModels: ["claude-opus-5-5"],
  maker: "0x00aa00000000000000000000000000000000aa01",
  parent: "maker",
  revenueSplit: { kind: "revenue", bps: 1000, recipient: "0x00aa00000000000000000000000000000000aa01" },
  mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
  constitution: ["do-no-harm", "ai-disclosure"],
  createdAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

describe("gremlin setup", () => {
  let home: string;
  let prevHome: string | undefined;
  let setup: typeof import("../gremlins/setup.js");

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gremlin-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home; // AUTOMATON_DIR is resolved from HOME at import time
    setup = await import("../gremlins/setup.js");
  });
  afterAll(() => {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("includes only the constitution sections the maker chose", () => {
    const md = setup.constitutionMarkdown(config());
    expect(md).toContain("Do no harm");
    expect(md).toContain("Disclose that you are an AI");
    expect(md).not.toContain("Do not replicate");
  });

  it("writes an explicit empty constitution so upstream laws are never used", () => {
    const md = setup.constitutionMarkdown(config({ constitution: [] }));
    expect(md).toContain("opted into no constitution sections");
    expect(md).not.toMatch(/Never harm|Earn your existence/);
  });

  it("genesis prompt carries persona, goals, split disclosure, parent status and the treasury rule", () => {
    const p = setup.genesisPrompt(config());
    expect(p).toContain("sprocket");
    expect(p).toContain("1. Fund a weather station network");
    expect(p).toContain("10% goes to");
    expect(p).toContain("is your parent");
    expect(p).toContain("1.2x");
    expect(setup.genesisPrompt(config({ parent: "orphan" }))).toContain("You are an orphan");
  });

  it("configures the runtime with the egg's own EVM key", () => {
    const phrase = Mnemonic.fromEntropy(randomBytes(32)).phrase;
    const expected = HDNodeWallet.fromPhrase(phrase, undefined, setup.EVM_PATH);
    const { dir, address } = setup.setupGremlin({ phrase, config: config() });

    expect(address).toBe(expected.address);
    const wallet = JSON.parse(fs.readFileSync(path.join(dir, "wallet.json"), "utf-8"));
    expect(wallet.privateKey).toBe(expected.privateKey);
    expect(fs.statSync(path.join(dir, "wallet.json")).mode & 0o777).toBe(0o600);

    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "automaton.json"), "utf-8"));
    expect(cfg.name).toBe("sprocket");
    expect(cfg.creatorAddress).toBe(config().maker);
    expect(cfg.inferenceModel).toBe("claude-opus-5-5");
    expect(cfg.socialRelayUrl).toBeUndefined();

    expect(fs.statSync(path.join(dir, "constitution.md")).mode & 0o222).toBe(0); // read-only
    expect(fs.existsSync(path.join(dir, "SOUL.md"))).toBe(true);
  });
});
