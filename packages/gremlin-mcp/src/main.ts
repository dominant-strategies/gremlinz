#!/usr/bin/env node
/** stdio entry point; Hermes launches it from config.yaml (mcp_servers.gremlin). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

await createServer().connect(new StdioServerTransport())
