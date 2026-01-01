#!/usr/bin/env node
/**
 * Simple Merchant HTTP Server with Real Payment Settlement
 * Uses ProductionFacilitatorClient from aegis402/src/facilitator.ts
 */

import { createServer, IncomingMessage } from "http";
import { ethers } from "ethers";
import { ProductionFacilitatorClient } from "../../src/facilitator";
import "dotenv/config";

const PORT = parseInt(process.env.PORT || "10002");
const SERVICE_PRICE = BigInt(process.env.SERVICE_PRICE || "50000"); // 0.05 USDC
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";

// Initialize facilitator client (same as aegis402 server)
const facilitator = new ProductionFacilitatorClient({ url: FACILITATOR_URL });

console.log(`
🏪 Simple Merchant Server
   Address: ${WALLET_ADDRESS}
   Port: ${PORT}
   Price: ${ethers.formatUnits(SERVICE_PRICE, 6)} USDC
   Facilitator: ${FACILITATOR_URL}
`);

// Parse JSON body
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

// Create x402 payment requirements (same format as aegis402 server)
function createPaymentRequirements() {
  return {
    scheme: "exact" as const,
    network: "base-sepolia" as const,
    asset: USDC_ADDRESS,
    payTo: WALLET_ADDRESS,
    maxAmountRequired: SERVICE_PRICE.toString(),
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-402-Payment");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url?.split("?")[0];

  // Health check
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", address: WALLET_ADDRESS }));
    return;
  }

  // Service endpoint
  if (req.method === "POST" && url === "/service") {
    const body = await parseBody<any>(req);

    // Check for x402 payment header
    const paymentHeader = req.headers["x-402-payment"];

    if (!paymentHeader) {
      // No payment - return 402
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

    // Payment provided - verify and settle via facilitator
    console.log("💰 Payment received, verifying via facilitator...");

    try {
      const paymentPayload = JSON.parse(paymentHeader as string);
      const requirements = createPaymentRequirements();

      // 1. Verify payment using ProductionFacilitatorClient
      const verifyResult = await facilitator.verify(
        paymentPayload,
        requirements
      );
      if (!verifyResult.isValid) {
        console.log(
          `❌ Payment verification failed: ${verifyResult.invalidReason}`
        );
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Payment verification failed",
            reason: verifyResult.invalidReason,
          })
        );
        return;
      }
      console.log(`✅ Payment verified from: ${verifyResult.payer}`);

      // 2. Settle payment (actually move the USDC on-chain)
      const settleResult = await facilitator.settle(
        paymentPayload,
        requirements
      );
      if (!settleResult.success) {
        console.log(
          `❌ Payment settlement failed: ${settleResult.errorReason}`
        );
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Payment settlement failed",
            reason: settleResult.errorReason,
          })
        );
        return;
      }
      console.log(`✅ Payment settled! Tx: ${settleResult.transaction}`);

      // 3. Provide service (payment successful!)
      const result = {
        success: true,
        result: `Service completed for: ${body.task || "unknown task"}`,
        txHash: settleResult.transaction,
        payer: verifyResult.payer,
        amountReceived: ethers.formatUnits(SERVICE_PRICE, 6) + " USDC",
      };

      console.log(`✅ Service provided to ${verifyResult.payer}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    } catch (error) {
      console.log(`❌ Error processing payment:`, error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payment processing error",
          details: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`🚀 Merchant server running on http://localhost:${PORT}`);
  console.log(`
Endpoints:
  POST /service  - Request service (x402 payment)
  GET  /health   - Health check
`);
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  server.close(() => process.exit(0));
});
