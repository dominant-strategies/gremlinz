#!/usr/bin/env node
/** stdio entry point; Hermes launches it from config.yaml (mcp_servers.gremlin). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { devBalances } from './dev.js'

await createServer({ balances: devBalances() }).connect(new StdioServerTransport())
