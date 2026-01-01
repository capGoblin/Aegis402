#!/usr/bin/env node
/**
 * Aegis402 Test Merchant - Simple CLI
 *
 * A simple merchant for testing Aegis402 flows.
 * Run with: npx ts-node -r dotenv/config merchant.ts
 *
 * Commands:
 *   subscribe    - Subscribe to Aegis402 with stake
 *   settle <tx>  - Settle a job
 *   status       - Show status
 */

import { Wallet } from "ethers";
import { processPayment } from "a2a-x402";
import * as readline from "readline";

import "dotenv/config";

if (!process.env.MERCHANT_WALLET_ADDRESS) {
  console.error("❌ MERCHANT_WALLET_ADDRESS required in .env");
  process.exit(1);
}

const WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";
const SKILLS = (
  process.env.MERCHANT_SKILLS || "data-analysis,test-service"
).split(",");
const STAKE_AMOUNT = process.env.STAKE_AMOUNT || "100000";

let wallet: Wallet | null = null;
if (PRIVATE_KEY) {
  wallet = new Wallet(PRIVATE_KEY);
}

console.log(`\n💼 Aegis402 Test Merchant`);
console.log(`   Address: ${WALLET_ADDRESS}`);
console.log(`   Aegis402: ${AEGIS402_URL}`);
console.log(`   Skills: ${SKILLS.join(", ")}\n`);

// State
let isSubscribed = false;
let creditLimit = "0";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(): void {
  rl.question("merchant> ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    const [cmd, ...args] = trimmed.split(" ");

    try {
      switch (cmd.toLowerCase()) {
        case "subscribe":
          await subscribe();
          break;
        case "settle":
          await settle(args[0]);
          break;
        case "status":
          showStatus();
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
  subscribe          - Subscribe to Aegis402 (stake ${(
    parseInt(STAKE_AMOUNT) / 1e6
  ).toFixed(2)} USDC)
  settle <txHash>    - Settle a completed job
  status             - Show subscription status
  help               - Show this help
  exit               - Exit
  `);
}

function showStatus(): void {
  console.log(`\nStatus:`);
  console.log(`  Subscribed: ${isSubscribed ? "✅ Yes" : "❌ No"}`);
  console.log(
    `  Credit Limit: ${(parseInt(creditLimit) / 1e6).toFixed(2)} USDC`
  );
  console.log(`  Skills: ${SKILLS.join(", ")}`);
}

async function subscribe(): Promise<void> {
  if (!wallet) {
    console.log("❌ MERCHANT_PRIVATE_KEY required for subscription");
    return;
  }

  console.log(`\n🔔 Subscribing to Aegis402...`);
  console.log(`   Stake: ${(parseInt(STAKE_AMOUNT) / 1e6).toFixed(2)} USDC`);

  const subscribeRequest = {
    x402Endpoint: `http://localhost:${process.env.PORT || "10002"}`,
    skills: SKILLS,
    agentId: process.env.AGENT_ID || "0", // Numeric agent ID, not address!
    stakeAmount: STAKE_AMOUNT,
  };

  // First request to get payment requirements
  const response = await fetch(`${AEGIS402_URL}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscribeRequest),
  });

  if (response.status === 402) {
    const paymentReqs = (await response.json()) as any;
    const option = paymentReqs.accepts[0];

    console.log(
      `💰 Stake payment required: ${(
        parseInt(option.maxAmountRequired) / 1e6
      ).toFixed(2)} USDC`
    );
    console.log("🔐 Signing stake payment...");

    const signedPayload = await processPayment(option, wallet as any);

    console.log("📤 Submitting subscription...");

    const paidResponse = await fetch(`${AEGIS402_URL}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...subscribeRequest,
        paymentPayload: signedPayload,
        requirements: option,
      }),
    });

    const result = (await paidResponse.json()) as any;

    if (result.success) {
      isSubscribed = true;
      creditLimit = result.creditLimit;
      console.log(`\n✅ Subscribed!`);
      console.log(
        `   Credit Limit: ${(parseInt(result.creditLimit) / 1e6).toFixed(
          2
        )} USDC`
      );
      console.log(`   Message: ${result.message}`);
    } else {
      console.log(`❌ Failed: ${result.message || result.error || "unknown"}`);
      console.log(`   Full response:`, JSON.stringify(result, null, 2));
    }
    return;
  }

  if (response.ok) {
    const result = (await response.json()) as any;
    if (result.success) {
      isSubscribed = true;
      creditLimit = result.creditLimit;
      console.log(`✅ Subscribed! Credit limit: ${result.creditLimit}`);
    } else {
      console.log(`❌ Failed: ${result.message}`);
    }
  }
}

async function settle(txHash?: string): Promise<void> {
  if (!txHash) {
    console.log("Usage: settle <txHash>");
    return;
  }

  console.log(`\n✅ Settling tx: ${txHash}`);

  const response = await fetch(`${AEGIS402_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });

  const result = (await response.json()) as any;

  if (result.success) {
    console.log(`✅ Settled!`);
    console.log(
      `   Amount: ${(parseInt(result.amount) / 1e6).toFixed(2)} USDC`
    );
    console.log(`   Message: ${result.message}`);
  } else {
    console.log(`❌ Failed: ${result.message}`);
  }
}

showHelp();
prompt();
