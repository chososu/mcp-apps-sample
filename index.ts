#!/usr/bin/env node
/**
 * Entry point for the Cloud Logging Viewer MCP Server.
 * Supports stdio and HTTP transports.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
const useHttp = args.includes("--http");

if (useHttp) {
  // HTTP transport mode
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.all("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.log(`Cloud Logging Viewer MCP Server running on http://localhost:${port}/mcp`);
  });
} else {
  // stdio transport mode (default)
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cloud Logging Viewer MCP Server running on stdio");
}
