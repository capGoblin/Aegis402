/**
 * Aegis402 HTTP Server
 *
 * Credit clearinghouse API with x402 payment gates
 *
 * Endpoints:
 * - POST /subscribe  (x402 payment = stake)
 * - POST /quote      (free)
 * - POST /settle     (free)
 * - POST /slash      (x402 payment = bond)
 * - GET  /health     (free)
 * - GET  /merchants  (free)
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { ethers } from "ethers";
import { Aegis402, Aegis402Config } from "./src/clearing-agent";
import {
  SubscribeRequest,
  QuoteRequest,
  SettleRequest,
  SlashRequest,
} from "./src/types";
import {
  x402PaymentRequiredException,
  PaymentRequirements,
  verifyPayment,
  settlePayment,
  PaymentPayload,
  FacilitatorClient,
} from "a2a-x402";
import { ProductionFacilitatorClient } from "./src/facilitator";

// Load environment
import "dotenv/config";

const PORT = parseInt(process.env.PORT || "10001");
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CREDIT_MANAGER_ADDRESS =
  process.env.CREDIT_MANAGER_ADDRESS ||
  "0x9fA96fE9374F351538A051194b54D93350A48FBE";
const USDC_ADDRESS =
  process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const MIN_STAKE_AMOUNT = BigInt(process.env.MIN_STAKE_AMOUNT || "100000"); // 0.1 USDC
const SLASH_BOND_AMOUNT = BigInt(process.env.SLASH_BOND_AMOUNT || "100000"); // 0.1 USDC
const DEFAULT_DEADLINE_SECONDS = parseInt(
  process.env.DEFAULT_DEADLINE_SECONDS || "3600"
);

// Facilitator configuration
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const FACILITATOR_API_KEY = process.env.FACILITATOR_API_KEY;

if (!PRIVATE_KEY) {
  console.error("❌ PRIVATE_KEY environment variable required");
  process.exit(1);
}

// Initialize Aegis402 agent
const config: Aegis402Config = {
  creditManagerAddress: CREDIT_MANAGER_ADDRESS,
  usdcAddress: USDC_ADDRESS,
  rpcUrl: RPC_URL,
  privateKey: PRIVATE_KEY,
  defaultDeadlineSeconds: DEFAULT_DEADLINE_SECONDS,
};

const aegis = new Aegis402(config);

// Facilitator for x402 payments (same pattern as merchant-agent)
const facilitator: FacilitatorClient = new ProductionFacilitatorClient({
  url: FACILITATOR_URL,
  apiKey: FACILITATOR_API_KEY,
});

console.log(`📡 Using facilitator: ${FACILITATOR_URL}`);

// x402 payment requirements creators
function createStakeRequirements(amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    asset: USDC_ADDRESS,
    payTo: aegis.getAgentAddress(), // Stake goes to agent first
    maxAmountRequired: amount.toString(),
    resource: "/subscribe",
    description: "Aegis402 merchant stake",
    mimeType: "application/json",
    maxTimeoutSeconds: 1200,
    extra: {
      name: "USDC",
      version: "2",
      purpose: "stake",
    },
  };
}

function createSlashBondRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    asset: USDC_ADDRESS,
    payTo: aegis.getAgentAddress(), // Bond goes to agent
    maxAmountRequired: SLASH_BOND_AMOUNT.toString(),
    resource: "/slash",
    description: "Aegis402 slash bond (anti-griefing)",
    mimeType: "application/json",
    maxTimeoutSeconds: 1200,
    extra: {
      name: "USDC",
      version: "2",
      purpose: "slash_bond",
    },
  };
}

// Helper to parse JSON body
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Helper to send JSON response
function sendJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Helper to send x402 payment required response
function sendPaymentRequired(
  res: ServerResponse,
  requirements: PaymentRequirements,
  message: string
): void {
  res.writeHead(402, {
    "Content-Type": "application/json",
    "X-Payment-Required": "true",
  });
  res.end(
    JSON.stringify({
      x402Version: 1,
      accepts: [requirements],
      error: message,
    })
  );
}

// Extract x402 payment from request headers/body
interface PaymentSubmission {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}

function extractPayment(body: any): PaymentSubmission | null {
  // Check for x402 payment in body
  const paymentPayload =
    body["x402.payment.payload"] ||
    body.metadata?.["x402.payment.payload"] ||
    body.paymentPayload;

  if (!paymentPayload) return null;

  // Requirements should be embedded or use defaults
  const requirements = body.requirements;
  if (!requirements) return null;

  return { payload: paymentPayload, requirements };
}

// Request handler
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url || "/";

  try {
    // =============================================================
    // GET /health
    // =============================================================
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "aegis402",
        agent: aegis.getAgentAddress(),
        creditManager: CREDIT_MANAGER_ADDRESS,
        timestamp: Date.now(),
      });
      return;
    }

    // =============================================================
    // GET /merchants
    // =============================================================
    if (req.method === "GET" && url === "/merchants") {
      const merchants = aegis.getAllMerchants().map((m) => ({
        address: m.address,
        x402Endpoint: m.x402Endpoint,
        skills: m.skills,
        stake: m.stake.toString(),
        creditLimit: m.creditLimit.toString(),
        exposure: m.exposure.toString(),
        availableCapacity: (m.creditLimit - m.exposure).toString(),
        active: m.active,
      }));
      sendJson(res, 200, { merchants });
      return;
    }

    // =============================================================
    // POST /subscribe (requires x402 payment = stake)
    // =============================================================
    if (req.method === "POST" && url === "/subscribe") {
      const body = await parseBody<any>(req);

      // Check for payment submission
      const payment = extractPayment(body);

      if (!payment) {
        // No payment - return 402 with stake requirements
        const stakeAmount = BigInt(body.stakeAmount || MIN_STAKE_AMOUNT);
        const requirements = createStakeRequirements(stakeAmount);
        sendPaymentRequired(
          res,
          requirements,
          `Stake of ${ethers.formatUnits(stakeAmount, 6)} USDC required`
        );
        return;
      }

      // Verify and settle the payment
      console.log("📥 Received stake payment, verifying...");
      const verifyResult = await verifyPayment(
        payment.payload,
        payment.requirements,
        facilitator
      );

      if (!verifyResult.isValid) {
        sendJson(res, 400, {
          success: false,
          error: `Payment verification failed: ${verifyResult.invalidReason}`,
        });
        return;
      }

      console.log("✅ Stake payment verified, settling...");
      const settleResult = await settlePayment(
        payment.payload,
        payment.requirements,
        facilitator
      );

      if (!settleResult.success) {
        sendJson(res, 400, {
          success: false,
          error: `Payment settlement failed: ${settleResult.errorReason}`,
        });
        return;
      }

      // Payment settled - process subscription
      const subscribeReq: SubscribeRequest = {
        x402Endpoint: body.x402Endpoint,
        skills: body.skills || [],
        agentId: body.agentId || "", // Don't fallback to payer address!
      };

      const stakeAmount = BigInt(payment.requirements.maxAmountRequired);
      const merchantAddress = verifyResult.payer!;

      const result = await aegis.handleSubscribe(
        subscribeReq,
        merchantAddress,
        stakeAmount
      );

      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    // =============================================================
    // POST /quote (free)
    // =============================================================
    if (req.method === "POST" && url === "/quote") {
      const body = await parseBody<QuoteRequest>(req);

      if (!body.skill || !body.price) {
        sendJson(res, 400, { error: "skill and price required" });
        return;
      }

      const result = await aegis.handleQuote(body);
      sendJson(res, 200, result);
      return;
    }

    // =============================================================
    // POST /settle (free)
    // =============================================================
    if (req.method === "POST" && url === "/settle") {
      const body = await parseBody<SettleRequest>(req);

      if (!body.txHash) {
        sendJson(res, 400, { error: "txHash required" });
        return;
      }

      const result = await aegis.handleSettle(body);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    // =============================================================
    // POST /slash (requires x402 payment = bond)
    // =============================================================
    if (req.method === "POST" && url === "/slash") {
      const body = await parseBody<any>(req);

      // Check for payment submission
      const payment = extractPayment(body);

      if (!payment) {
        // No payment - return 402 with bond requirements
        const requirements = createSlashBondRequirements();
        sendPaymentRequired(
          res,
          requirements,
          `Slash bond of ${ethers.formatUnits(
            SLASH_BOND_AMOUNT,
            6
          )} USDC required`
        );
        return;
      }

      // Verify the bond payment
      console.log("📥 Received slash bond, verifying...");
      const verifyResult = await verifyPayment(
        payment.payload,
        payment.requirements,
        facilitator
      );

      if (!verifyResult.isValid) {
        sendJson(res, 400, {
          success: false,
          error: `Bond verification failed: ${verifyResult.invalidReason}`,
        });
        return;
      }

      // Settle the bond
      console.log("✅ Slash bond verified, settling...");
      const settleResult = await settlePayment(
        payment.payload,
        payment.requirements,
        facilitator
      );

      if (!settleResult.success) {
        sendJson(res, 400, {
          success: false,
          error: `Bond settlement failed: ${settleResult.errorReason}`,
        });
        return;
      }

      // Bond paid - process slash
      const slashReq: SlashRequest = { txHash: body.txHash };
      const clientAddress = verifyResult.payer!;

      const result = await aegis.handleSlash(slashReq, clientAddress);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    // Unknown endpoint
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request error:", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

// Start server
const server = createServer(handleRequest);

aegis.start().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🛡️  Aegis402 Server running on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /subscribe  - Merchant onboarding (x402 stake)`);
    console.log(`  POST /quote      - Discovery (free)`);
    console.log(`  POST /settle     - Settlement (free)`);
    console.log(`  POST /slash      - Slashing (x402 bond)`);
    console.log(`  GET  /health     - Health check`);
    console.log(`  GET  /merchants  - List merchants`);
  });
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  aegis.stop();
  server.close(() => {
    console.log("✅ Server stopped");
    process.exit(0);
  });
});
