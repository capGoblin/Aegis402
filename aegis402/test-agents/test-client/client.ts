#!/usr/bin/env node
/**
 * Aegis402 Test Client - Simple CLI
 *
 * A simple client for testing Aegis402 flows.
 * Run with: npx ts-node -r dotenv/config client.ts [command]
 *
 * Commands:
 *   quote <skill> <price>   - Find merchants
 *   request <merchantUrl>   - Request service
 *   slash <txHash>          - Slash a merchant
 */

import { Wallet } from "ethers";
import { processPayment } from "a2a-x402";
import * as readline from "readline";

// Load dotenv
import "dotenv/config";

const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
  console.error("❌ WALLET_PRIVATE_KEY required in .env");
  process.exit(1);
}

const wallet = new Wallet(privateKey);
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";

console.log(`\n🤖 Aegis402 Test Client`);
console.log(`   Wallet: ${wallet.address}`);
console.log(`   Aegis402: ${AEGIS402_URL}\n`);

// State
let selectedMerchant: any = null;
let pendingPayment: any = null;

// Readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(): void {
  rl.question("client> ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    const [cmd, ...args] = trimmed.split(" ");

    try {
      switch (cmd.toLowerCase()) {
        case "quote":
        case "find":
          await findMerchants(args[0] || "data-analysis", args[1] || "1000000");
          break;
        case "request":
          await requestService(args[0] || selectedMerchant?.x402Endpoint);
          break;
        case "pay":
        case "confirm":
          await confirmPayment();
          break;
        case "cancel":
          pendingPayment = null;
          console.log("Payment cancelled.");
          break;
        case "slash":
          await slashMerchant(args[0]);
          break;
        case "wallet":
          console.log(`Wallet: ${wallet.address}`);
          break;
        case "help":
          showHelp();
          break;
        case "exit":
        case "quit":
          rl.close();
          process.exit(0);
        default:
          console.log(`Unknown command: ${cmd}. Type 'help' for commands.`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
    }

    prompt();
  });
}

function showHelp(): void {
  console.log(`
Commands:
  find <skill> [price]    - Find merchants (e.g., find data-analysis 1000000)
  request [url]           - Request service from merchant
  pay                     - Confirm pending payment
  cancel                  - Cancel pending payment
  slash <txHash>          - Slash merchant for non-delivery
  wallet                  - Show wallet address
  help                    - Show this help
  exit                    - Exit
  `);
}

async function findMerchants(skill: string, price: string): Promise<void> {
  console.log(
    `\n🔍 Finding merchants for "${skill}" at ${(parseInt(price) / 1e6).toFixed(
      2
    )} USDC...`
  );

  const response = await fetch(`${AEGIS402_URL}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill, price }),
  });

  const result = (await response.json()) as any;

  if (!result.merchants || result.merchants.length === 0) {
    console.log("No merchants found.");
    return;
  }

  console.log(`\nFound ${result.merchants.length} merchant(s):\n`);
  result.merchants.forEach((m: any, i: number) => {
    console.log(`${i + 1}. ${m.address}`);
    console.log(`   Endpoint: ${m.x402Endpoint}`);
    console.log(
      `   Capacity: ${(parseInt(m.availableCapacity) / 1e6).toFixed(2)} USDC`
    );
    console.log(`   repFactor: ${m.repFactor?.toFixed(2) || "N/A"}`);
    console.log();
  });

  selectedMerchant = result.merchants[0];
  console.log(`Selected merchant #1. Use 'request' to request service.`);
}

async function requestService(merchantUrl?: string): Promise<void> {
  if (!merchantUrl) {
    console.log("❌ No merchant URL. Use 'find' first or provide URL.");
    return;
  }

  console.log(`\n📤 Requesting service from ${merchantUrl}...`);

  // POST to /service endpoint
  const serviceUrl = merchantUrl.endsWith("/service")
    ? merchantUrl
    : `${merchantUrl}/service`;

  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "I need data-analysis",
    }),
  });

  const result = (await response.json()) as any;

  // Check for 402 payment required (simple format from simple-server)
  if (response.status === 402 || result.error === "Payment Required") {
    if (result.accepts && result.accepts[0]) {
      const option = result.accepts[0];
      pendingPayment = { merchantUrl: serviceUrl, requirements: option };
      console.log(`\n💰 Payment required:`);
      console.log(
        `   Amount: ${(parseInt(option.maxAmountRequired) / 1e6).toFixed(
          2
        )} USDC`
      );
      console.log(`   To: ${option.payTo}`);
      console.log(`\nUse 'pay' to confirm or 'cancel' to abort.`);
      return;
    }
  }

  // Check for ADK-style payment requirements (events format)
  if (result.events) {
    for (const event of result.events) {
      const paymentReq =
        event.status?.message?.metadata?.["x402.payment.required"];
      if (paymentReq) {
        pendingPayment = {
          merchantUrl: serviceUrl,
          requirements: paymentReq.accepts[0],
        };
        const option = paymentReq.accepts[0];
        console.log(`\n💰 Payment required:`);
        console.log(
          `   Amount: ${(parseInt(option.maxAmountRequired) / 1e6).toFixed(
            2
          )} USDC`
        );
        console.log(`   To: ${option.payTo}`);
        console.log(`\nUse 'pay' to confirm or 'cancel' to abort.`);
        return;
      }
    }
  }

  console.log("Response:", JSON.stringify(result, null, 2));
}

async function confirmPayment(): Promise<void> {
  if (!pendingPayment) {
    console.log("No pending payment. Use 'request' first.");
    return;
  }

  console.log("🔐 Signing payment...");

  // pendingPayment.requirements is already the option object
  const option = pendingPayment.requirements;
  const signedPayload = await processPayment(option, wallet as any);

  console.log("📤 Submitting to merchant with payment...");

  const response = await fetch(pendingPayment.merchantUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-402-Payment": JSON.stringify(signedPayload),
    },
    body: JSON.stringify({
      task: "I need data-analysis",
    }),
  });

  const result = (await response.json()) as any;
  console.log("✅ Payment submitted!");
  console.log("Response:", JSON.stringify(result, null, 2));

  pendingPayment = null;
}

async function slashMerchant(txHash?: string): Promise<void> {
  if (!txHash) {
    console.log("Usage: slash <txHash>");
    return;
  }

  console.log(`🔪 Slashing for tx: ${txHash}`);

  // First request to get bond requirements
  const response = await fetch(`${AEGIS402_URL}/slash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });

  if (response.status === 402) {
    const bondReqs = (await response.json()) as any;
    const option = bondReqs.accepts[0];

    console.log(
      `💰 Bond required: ${(parseInt(option.maxAmountRequired) / 1e6).toFixed(
        2
      )} USDC`
    );
    console.log("🔐 Signing bond...");

    const signedPayload = await processPayment(option, wallet as any);

    console.log("📤 Submitting slash...");

    const slashResponse = await fetch(`${AEGIS402_URL}/slash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash,
        paymentPayload: signedPayload,
        requirements: option,
      }),
    });

    const result = (await slashResponse.json()) as any;
    console.log("Result:", JSON.stringify(result, null, 2));
    return;
  }

  const result = (await response.json()) as any;
  console.log("Result:", JSON.stringify(result, null, 2));
}

// Start REPL
showHelp();
prompt();
