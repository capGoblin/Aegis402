#!/usr/bin/env node
/**
 * Test Merchant Server
 *
 * HTTP server with x402 payment processing
 * (Same pattern as a2a-x402-typescript/merchant-agent/server.ts)
 */

import { createServer } from "http";
import {
  wrappedTestMerchantAgent,
  lastPaymentException,
  clearLastPaymentException,
  setPaymentVerified,
} from "./wrapped-agent";
import {
  x402PaymentRequiredException,
  x402ServerExecutor,
  AgentExecutor,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  verifyPayment,
  settlePayment,
  FacilitatorClient,
  FacilitatorConfig,
  x402Utils,
} from "a2a-x402";

// ADK imports
const path = require("path");
let Runner: any,
  InMemorySessionService: any,
  InMemoryArtifactService: any,
  InMemoryMemoryService: any;

try {
  // Try local node_modules first
  Runner = require("adk-typescript/runners").Runner;
  InMemorySessionService =
    require("adk-typescript/sessions").InMemorySessionService;
  InMemoryArtifactService =
    require("adk-typescript/artifacts").InMemoryArtifactService;
  InMemoryMemoryService =
    require("adk-typescript/memory").InMemoryMemoryService;
} catch {
  // Fallback to global
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

const PORT = parseInt(process.env.PORT || "10002");
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";

// --- Production Facilitator Client ---

class ProductionFacilitatorClient implements FacilitatorClient {
  private url: string;
  private apiKey?: string;

  constructor(config: FacilitatorConfig) {
    this.url = config.url;
    this.apiKey = config.apiKey;
    console.log(`📡 Facilitator: ${this.url}`);
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    try {
      const response = await fetch(`${this.url}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) {
        return { isValid: false, invalidReason: `HTTP ${response.status}` };
      }

      const result = (await response.json()) as any;
      return {
        isValid: result.is_valid || result.isValid || false,
        payer: result.payer,
        invalidReason: result.invalid_reason || result.invalidReason,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: `Network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResponse> {
    try {
      const response = await fetch(`${this.url}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          network: requirements.network,
          errorReason: `HTTP ${response.status}`,
        };
      }

      const result = (await response.json()) as any;
      return {
        success: result.success || false,
        transaction: result.transaction || result.transactionHash,
        network: result.network || requirements.network,
        payer: result.payer,
        errorReason: result.error_reason || result.errorReason,
      };
    } catch (error) {
      return {
        success: false,
        network: requirements.network,
        errorReason: `Network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}

// --- ADK Services ---

const sessionService = new InMemorySessionService();
const artifactService = new InMemoryArtifactService();
const memoryService = new InMemoryMemoryService();

const runner = new Runner({
  appName: "aegis402_test_merchant",
  agent: wrappedTestMerchantAgent,
  sessionService,
  artifactService,
  memoryService,
});

// --- Agent Executor Adapter ---

class AgentExecutorAdapter implements AgentExecutor {
  async execute(context: any, eventQueue: any): Promise<void> {
    try {
      console.log("\n=== AgentExecutorAdapter ===");
      console.log("Context ID:", context.contextId);

      clearLastPaymentException();

      const isPaymentVerified =
        context.currentTask?.metadata?.["x402_payment_verified"] === true;
      console.log(`   Payment verified: ${isPaymentVerified}`);
      setPaymentVerified(isPaymentVerified);

      for await (const event of runner.runAsync({
        userId: "test-user",
        sessionId: context.contextId,
        newMessage: context.message,
      })) {
        await eventQueue.enqueueEvent({
          id: context.taskId,
          status: { state: "input-required", message: event },
        });
      }

      if (lastPaymentException && !isPaymentVerified) {
        console.log("💳 Re-throwing payment exception...");
        throw lastPaymentException;
      }

      setPaymentVerified(false);
    } catch (error) {
      setPaymentVerified(false);
      if (error instanceof x402PaymentRequiredException) {
        throw error;
      }
      console.error("Agent execution error:", error);
      throw error;
    }
  }
}

// --- Custom Executor with Facilitator ---

class TestMerchantExecutor extends x402ServerExecutor {
  private facilitator: FacilitatorClient;

  constructor(delegate: AgentExecutor, facilitator: FacilitatorClient) {
    super(delegate);
    this.facilitator = facilitator;
  }

  async verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    console.log("\n=== VERIFYING PAYMENT ===");
    const response = await verifyPayment(
      payload,
      requirements,
      this.facilitator
    );
    console.log(`   Valid: ${response.isValid}, Payer: ${response.payer}`);
    return response;
  }

  async settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResponse> {
    console.log("\n=== SETTLING PAYMENT ===");
    const response = await settlePayment(
      payload,
      requirements,
      this.facilitator
    );
    console.log(`   Success: ${response.success}, TX: ${response.transaction}`);
    return response;
  }
}

// --- Setup ---

const facilitator = new ProductionFacilitatorClient({ url: FACILITATOR_URL });
const agentAdapter = new AgentExecutorAdapter();
const paymentExecutor = new TestMerchantExecutor(agentAdapter, facilitator);

console.log("🚀 Starting Aegis402 Test Merchant Server...");

// --- HTTP Server ---

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ status: "ok", service: "aegis402-test-merchant" })
    );
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
        const context: any = {
          taskId: `task-${Date.now()}`,
          contextId: request.sessionId || `ctx-${Date.now()}`,
          message: request.newMessage,
        };

        const events: any[] = [];
        const eventQueue = {
          enqueueEvent: async (event: any) => {
            events.push(event);
          },
        };

        await paymentExecutor.execute(context, eventQueue);

        const adkEvents = events.map((e) => {
          const paymentReqs =
            e.status?.message?.metadata?.["x402.payment.required"];
          if (e.status?.state === "input-required" && paymentReqs) {
            return {
              invocationId: context.taskId,
              errorCode: "x402_payment_required",
              errorData: { paymentRequirements: paymentReqs },
              content: {
                role: "model",
                parts: [{ text: paymentReqs.error || "Payment required" }],
              },
            };
          }
          return e.status?.message || e;
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(adkEvents));
        return;
      }

      // Legacy format
      const taskId = request.taskId || `task-${Date.now()}`;
      const message = request.message || {
        messageId: `msg-${Date.now()}`,
        role: "user",
        parts: [{ text: request.text || request.input || "" }],
      };

      const currentTask: any = {
        id: taskId,
        contextId: taskId,
        status: { state: "submitted" },
        metadata: message.metadata ? { ...message.metadata } : {},
      };

      const context = { taskId, contextId: taskId, message, currentTask };
      const events: any[] = [];
      const eventQueue = {
        enqueueEvent: async (e: any) => {
          events.push(e);
        },
      };

      await paymentExecutor.execute(context, eventQueue);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, events, taskId }));
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
  console.log(`✅ Test Merchant running at http://localhost:${PORT}`);
  console.log(`📡 Ready for x402 payments`);
  console.log(
    `\nTest with: curl -X POST http://localhost:${PORT} -H "Content-Type: application/json" -d '{"text": "subscribe to aegis402"}'`
  );
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  server.close(() => process.exit(0));
});
