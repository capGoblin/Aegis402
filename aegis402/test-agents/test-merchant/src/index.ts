import { createServer, IncomingMessage, ServerResponse } from "http";
import { ethers } from "ethers";
import { MerchantAgent } from "./merchant-agent";
import { MerchantConfig } from "./types";
import "dotenv/config";

const PORT = parseInt(process.env.PORT || "10002");
const SERVICE_PRICE = process.env.SERVICE_PRICE || "10000";
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const WALLET_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY || "";
const MERCHANT_WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS || "";
const SKILLS = (
  process.env.MERCHANT_SKILLS || "data-analysis,test-service"
).split(",");
const AGENT_ID = process.env.AGENT_ID || "0";
const STAKE_AMOUNT = process.env.STAKE_AMOUNT || "10000";
const USDC_ADDRESS =
  process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

if (!WALLET_PRIVATE_KEY) {
  console.error("❌ MERCHANT_PRIVATE_KEY required in .env");
  process.exit(1);
}

const config: MerchantConfig = {
  walletPrivateKey: WALLET_PRIVATE_KEY,
  aegisUrl: AEGIS402_URL,
  facilitatorUrl: FACILITATOR_URL,
  skills: SKILLS,
  stakeAmount: STAKE_AMOUNT,
  port: PORT,
  agentId: AGENT_ID,
};

const agent = new MerchantAgent(config);

// Helper to parse JSON body
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({} as T);
      }
    });
    req.on("error", reject);
  });
}

// Helper to send JSON response
function sendJson(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function createPaymentRequirements() {
  return {
    scheme: "exact" as const,
    network: "base-sepolia" as const,
    asset: USDC_ADDRESS,
    payTo: agent.getWalletAddress(),
    maxAmountRequired: SERVICE_PRICE,
    resource: "/service",
    description: "Service payment",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: {
      name: "USDC",
      version: "2",
    },
  };
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-402-Payment");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || "/";

  try {
    // GET /health
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok", address: agent.getWalletAddress() });
      return;
    }

    // GET /status
    if (req.method === "GET" && url === "/status") {
      sendJson(res, 200, agent.getStatus());
      return;
    }

    // POST /subscribe (Manual trigger)
    if (req.method === "POST" && url === "/subscribe") {
      const result = await agent.subscribe();
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    // POST /admin/settle (Manual trigger)
    if (req.method === "POST" && url === "/admin/settle") {
      const body = await parseBody<any>(req);
      if (!body.txHash) {
        sendJson(res, 400, { error: "txHash required" });
        return;
      }
      const result = await agent.settleTask(body.txHash);
      sendJson(res, result.success ? 200 : 400, result);
      return;
    }

    // POST /service (The actual service)
    if (req.method === "POST" && url === "/service") {
      const body = await parseBody<any>(req);
      const paymentHeader = req.headers["x-402-payment"];

      if (!paymentHeader) {
        console.log("📥 Service request received - returning 402");
        const requirements = createPaymentRequirements();
        res.writeHead(402, {
          "Content-Type": "application/json",
          "X-402-Version": "1",
        });
        res.end(
          JSON.stringify({
            error: "Payment Required",
            accepts: [requirements],
            x402Version: 1,
          })
        );
        return;
      }

      console.log("💰 Payment received, verifying...");
      const paymentPayload = JSON.parse(paymentHeader as string);
      const requirements = createPaymentRequirements();

      try {
        const settleResult = await agent.verifyAndSettlePayment(
          paymentPayload,
          requirements
        );

        // Provide service
        console.log(`✅ Service provided to ${settleResult.payer}`);
        sendJson(res, 200, {
          success: true,
          result: `Service completed for: ${body.task || "unknown task"}`,
          txHash: settleResult.transaction,
          payer: settleResult.payer,
          amountReceived: ethers.formatUnits(SERVICE_PRICE, 6) + " USDC",
        });
      } catch (error) {
        console.error("❌ Payment processing error:", error);
        sendJson(res, 400, {
          error: "Payment processing failed",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("❌ Server error:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Unified Merchant Server running on http://localhost:${PORT}`);
  console.log(`   Address: ${agent.getWalletAddress()}`);
  console.log(`\nEndpoints:`);
  console.log(`   POST /service      - Main service (Requires 402 payment)`);
  console.log(`   POST /subscribe    - Manual Aegis subscription`);
  console.log(`   POST /admin/settle - Manual job settlement`);
  console.log(`   GET  /status       - Detailed agent status`);
});
