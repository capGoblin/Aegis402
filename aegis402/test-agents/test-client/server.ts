#!/usr/bin/env node
/**
 * Test Client Server
 *
 * HTTP server for the test client agent
 * (Simple version - no x402 executor needed since client pays, not receives)
 */

import { createServer } from "http";
import { testClientAgent } from "./agent";

// ADK imports
let Runner: any,
  InMemorySessionService: any,
  InMemoryArtifactService: any,
  InMemoryMemoryService: any;

try {
  Runner = require("adk-typescript/runners").Runner;
  InMemorySessionService =
    require("adk-typescript/sessions").InMemorySessionService;
  InMemoryArtifactService =
    require("adk-typescript/artifacts").InMemoryArtifactService;
  InMemoryMemoryService =
    require("adk-typescript/memory").InMemoryMemoryService;
} catch {
  const path = require("path");
  Runner = require(path.resolve(
    "/node_modules/adk-typescript/dist/runners"
  )).Runner;
  InMemorySessionService = require(path.resolve(
    "/node_modules/adk-typescript/dist/sessions"
  )).InMemorySessionService;
  InMemoryArtifactService = require(path.resolve(
    "/node_modules/adk-typescript/dist/artifacts"
  )).InMemoryArtifactService;
  InMemoryMemoryService = require(path.resolve(
    "/node_modules/adk-typescript/dist/memory"
  )).InMemoryMemoryService;
}

import "dotenv/config";

const PORT = parseInt(process.env.PORT || "10003");

// --- ADK Services ---

const sessionService = new InMemorySessionService();
const artifactService = new InMemoryArtifactService();
const memoryService = new InMemoryMemoryService();

const runner = new Runner({
  appName: "aegis402_test_client",
  agent: testClientAgent,
  sessionService,
  artifactService,
  memoryService,
});

console.log("🚀 Starting Aegis402 Test Client Server...");

// --- HTTP Server ---

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "aegis402-test-client" }));
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));

  req.on("end", async () => {
    try {
      const request = JSON.parse(body);
      console.log("\n=== Request ===");
      console.log("URL:", req.url);

      // Support ADK /run endpoint
      if (req.url === "/run" && request.newMessage) {
        const events: any[] = [];

        for await (const event of runner.runAsync({
          userId: request.userId || "user",
          sessionId: request.sessionId || `session-${Date.now()}`,
          newMessage: request.newMessage,
        })) {
          events.push(event);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(events));
        return;
      }

      // Legacy format
      const message = request.message || {
        role: "user",
        parts: [{ text: request.text || request.input || "" }],
      };

      const events: any[] = [];

      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: request.sessionId || `session-${Date.now()}`,
        newMessage: message,
      })) {
        events.push(event);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, events }));
    } catch (error) {
      console.error("Request error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Internal error",
        })
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Test Client running at http://localhost:${PORT}`);
  console.log(
    `\nTest with: curl -X POST http://localhost:${PORT} -H "Content-Type: application/json" -d '{"text": "find merchants for data-analysis"}'`
  );
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  server.close(() => process.exit(0));
});
