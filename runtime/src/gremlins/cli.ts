/** `automaton --gremlin-setup`: configure from the egg's files, provision a Conway key, then run. */
import fs from "fs";
import path from "path";
import { setupGremlin } from "./setup.js";
import { provision } from "../identity/provision.js";
import { loadConfig, saveConfig } from "../config.js";

export async function gremlinSetupFromEnv(): Promise<void> {
  const home = process.env.GREMLIN_HOME ?? "/var/lib/gremlin";
  const configPath = process.env.GREMLIN_CONFIG ?? path.join(home, "config.json");
  const phrase = fs.readFileSync(path.join(home, "seed"), "utf-8").trim();
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  if (!loadConfig()) {
    const { address } = setupGremlin({ phrase, config });
    console.log(`gremlin ${config.name} configured as ${address}`);
  }

  // Sign in to Conway with the gremlin's own wallet (SIWE) for an API key. Failure is not fatal:
  // the runtime can retry, and other providers may be used.
  const current = loadConfig()!;
  if (!current.conwayApiKey) {
    try {
      const { apiKey } = await provision();
      saveConfig({ ...current, conwayApiKey: apiKey, registeredWithConway: true });
      console.log("Conway API key provisioned");
    } catch (err: any) {
      console.warn(`Conway provisioning failed: ${err.message}`);
    }
  }
}
