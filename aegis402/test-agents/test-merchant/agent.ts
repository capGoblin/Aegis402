/**
 * Aegis402 Test Merchant Agent
 *
 * A merchant agent that:
 * 1. Can subscribe to Aegis402 (stake USDC, get credit limit)
 * 2. Offers services (via x402 payment)
 * 3. Settles with Aegis402 after delivery
 *
 * Modeled after: a2a-x402-typescript/merchant-agent/agent.ts
 */

import { LlmAgent as Agent } from "adk-typescript/agents";
import { Wallet } from "ethers";
import {
  x402PaymentRequiredException,
  PaymentRequirements,
  processPayment,
} from "a2a-x402";

// --- Configuration ---

if (!process.env.MERCHANT_WALLET_ADDRESS) {
  console.error("❌ MERCHANT_WALLET_ADDRESS required");
  throw new Error("Missing MERCHANT_WALLET_ADDRESS");
}

const WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY;
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";
const NETWORK = process.env.PAYMENT_NETWORK || "base-sepolia";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MERCHANT_SKILLS = (
  process.env.MERCHANT_SKILLS || "data-analysis,test-service"
).split(",");
const STAKE_AMOUNT = process.env.STAKE_AMOUNT || "100000"; // 0.1 USDC
const PORT = process.env.PORT || "10002";

// Wallet for signing payments (for subscription)
let wallet: Wallet | null = null;
if (PRIVATE_KEY) {
  wallet = new Wallet(PRIVATE_KEY);
  console.log(`👛 Merchant wallet: ${wallet.address}`);
}

console.log(`💼 Test Merchant Configuration:
  Wallet: ${WALLET_ADDRESS}
  Aegis402: ${AEGIS402_URL}
  Network: ${NETWORK}
  Skills: ${MERCHANT_SKILLS.join(", ")}
  Stake: ${(parseInt(STAKE_AMOUNT) / 1_000_000).toFixed(6)} USDC
`);

// --- State ---

interface MerchantState {
  isSubscribed: boolean;
  creditLimit?: string;
  pendingJobs: Map<string, { client: string; amount: string; txHash?: string }>;
}

const state: MerchantState = {
  isSubscribed: false,
  pendingJobs: new Map(),
};

// --- Tool Functions ---

/**
 * Subscribe to Aegis402 (stake USDC to get credit limit)
 */
async function subscribeToAegis402(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  console.log("\n🔔 Subscribing to Aegis402...");

  if (!wallet) {
    return "❌ Cannot subscribe: MERCHANT_PRIVATE_KEY not set. Please add your private key to .env";
  }

  if (state.isSubscribed) {
    return `Already subscribed to Aegis402. Credit limit: ${state.creditLimit}`;
  }

  try {
    // Step 1: Request subscription (will return 402 with stake requirements)
    console.log(`📡 Calling ${AEGIS402_URL}/subscribe...`);

    const subscribeRequest = {
      x402Endpoint: `http://localhost:${PORT}`,
      skills: MERCHANT_SKILLS,
      agentId: WALLET_ADDRESS,
      stakeAmount: STAKE_AMOUNT,
    };

    const response = await fetch(`${AEGIS402_URL}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscribeRequest),
    });

    // If 402, we need to pay the stake
    if (response.status === 402) {
      const paymentReqs = (await response.json()) as any;
      console.log(
        "💰 Stake payment required:",
        JSON.stringify(paymentReqs, null, 2)
      );

      if (!paymentReqs.accepts || paymentReqs.accepts.length === 0) {
        return "❌ Invalid payment requirements from Aegis402";
      }

      const paymentOption = paymentReqs.accepts[0];
      const stakeAmount = (
        parseInt(paymentOption.maxAmountRequired) / 1_000_000
      ).toFixed(6);

      // Sign the payment
      console.log(`🔐 Signing stake payment of ${stakeAmount} USDC...`);
      const signedPayload = await processPayment(paymentOption, wallet as any);

      // Submit with payment
      console.log("📤 Submitting subscription with stake payment...");
      const paidResponse = await fetch(`${AEGIS402_URL}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...subscribeRequest,
          paymentPayload: signedPayload,
          requirements: paymentOption,
        }),
      });

      if (!paidResponse.ok) {
        const error = await paidResponse.text();
        return `❌ Subscription failed: ${error}`;
      }

      const result = (await paidResponse.json()) as any;
      state.isSubscribed = true;
      state.creditLimit = result.creditLimit;

      return `✅ Subscribed to Aegis402!

**Subscription Details:**
- Stake: ${stakeAmount} USDC
- Credit Limit: ${(parseInt(result.creditLimit) / 1_000_000).toFixed(6)} USDC
- Skills: ${MERCHANT_SKILLS.join(", ")}
- Message: ${result.message}

You are now discoverable via Aegis402:/quote!`;
    }

    // If 200, we're already subscribed or no payment needed
    if (response.ok) {
      const result = (await response.json()) as any;
      if (result.success) {
        state.isSubscribed = true;
        state.creditLimit = result.creditLimit;
        return `✅ Subscribed! Credit limit: ${result.creditLimit}`;
      }
      return `❌ Subscription failed: ${result.message}`;
    }

    return `❌ Unexpected response: ${response.status}`;
  } catch (error) {
    console.error("❌ Subscribe error:", error);
    return `❌ Failed to subscribe: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Provide a service (requires x402 payment)
 * This throws x402PaymentRequiredException to trigger payment flow
 */
async function provideService(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const serviceName =
    params.serviceName || params.service || params.name || "data-analysis";
  const description = params.description || `Executing ${serviceName}`;

  console.log(`\n🔧 Service Request: ${serviceName}`);

  // Check if payment was already verified
  const paymentVerified =
    context?.currentTask?.metadata?.["x402_payment_verified"];
  const paymentStatus =
    context?.currentTask?.status?.message?.metadata?.["x402.payment.status"];

  console.log(`   Payment verified: ${paymentVerified}`);
  console.log(`   Payment status: ${paymentStatus}`);

  if (
    paymentVerified ||
    paymentStatus === "payment-submitted" ||
    paymentStatus === "payment-verified"
  ) {
    console.log(`✅ Payment verified! Executing ${serviceName}...`);

    // Get the txHash from payment for settlement
    const txHash = context?.currentTask?.metadata?.["x402.payment.txHash"];
    if (txHash) {
      state.pendingJobs.set(txHash, {
        client:
          context?.currentTask?.metadata?.["x402.payment.payer"] || "unknown",
        amount: context?.currentTask?.metadata?.["x402.payment.amount"] || "0",
        txHash,
      });
    }

    // Simulate work
    return `✅ Service completed: ${serviceName}

**Delivery Confirmation:**
- Service: ${serviceName}
- Status: Completed
- Description: ${description}

Thank you for using our service! 🎉`;
  }

  // No payment yet - require payment
  const price = "1000000"; // 1 USDC
  const priceUSDC = (parseInt(price) / 1_000_000).toFixed(6);

  console.log(`💰 Payment required: ${priceUSDC} USDC for ${serviceName}`);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK as any,
    asset: USDC_CONTRACT,
    payTo: WALLET_ADDRESS,
    maxAmountRequired: price,
    description: `Payment for: ${serviceName}`,
    resource: `/service/${serviceName}`,
    mimeType: "application/json",
    maxTimeoutSeconds: 1200,
    extra: {
      name: "USDC",
      service: {
        name: serviceName,
        description,
      },
    },
  };

  console.log("📡 Throwing x402PaymentRequiredException...");
  throw new x402PaymentRequiredException(
    `Payment of ${priceUSDC} USDC required for ${serviceName}`,
    requirements
  );
}

/**
 * Settle a completed job with Aegis402
 */
async function settleWithAegis402(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const txHash = params.txHash || params.tx;

  console.log(`\n✅ Settling job with Aegis402: ${txHash}`);

  if (!txHash) {
    return "❌ Please provide the transaction hash (txHash) to settle";
  }

  try {
    const response = await fetch(`${AEGIS402_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash }),
    });

    const result = (await response.json()) as any;

    if (result.success) {
      state.pendingJobs.delete(txHash);
      return `✅ Job settled successfully!

**Settlement Details:**
- Transaction: ${txHash}
- Merchant: ${result.merchant}
- Amount: ${(parseInt(result.amount) / 1_000_000).toFixed(6)} USDC
- Message: ${result.message}

Exposure cleared. Credit capacity restored.`;
    }

    return `❌ Settlement failed: ${result.message}`;
  } catch (error) {
    console.error("❌ Settle error:", error);
    return `❌ Failed to settle: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Check subscription status
 */
async function checkStatus(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  if (!state.isSubscribed) {
    return `Not subscribed to Aegis402 yet.

Use 'subscribe to aegis402' to stake and get credit limit.`;
  }

  const pendingJobsList = Array.from(state.pendingJobs.entries())
    .map(
      ([tx, job]) =>
        `- ${tx.substring(0, 16)}... (${(
          parseInt(job.amount) / 1_000_000
        ).toFixed(6)} USDC)`
    )
    .join("\n");

  return `**Merchant Status:**
- Subscribed: ✅ Yes
- Credit Limit: ${
    state.creditLimit
      ? (parseInt(state.creditLimit) / 1_000_000).toFixed(6)
      : "Unknown"
  } USDC
- Skills: ${MERCHANT_SKILLS.join(", ")}
- Pending Jobs: ${state.pendingJobs.size}
${pendingJobsList ? "\n**Pending:**\n" + pendingJobsList : ""}`;
}

// --- Agent Definition ---

export const testMerchantAgent = new Agent({
  name: "aegis402_test_merchant",
  model: "gemini-2.0-flash",
  description:
    "A test merchant agent that integrates with Aegis402 credit clearinghouse",
  instruction: `You are a merchant agent that provides services using the Aegis402 credit system.

**Your Capabilities:**
1. **Subscribe to Aegis402** - Stake USDC to get credit limit and become discoverable
2. **Provide Services** - Offer data-analysis, test-service, etc. (requires x402 payment)
3. **Settle Jobs** - Report completed work to Aegis402 to clear exposure
4. **Check Status** - View your subscription and pending jobs

**Flow:**
1. User asks to "subscribe" → Use subscribeToAegis402 tool
2. Client requests a service → Use provideService tool (triggers x402 payment)
3. After work delivered → Use settleWithAegis402 tool with the txHash

**Important:**
- Always subscribe before offering services
- Settle jobs promptly to restore credit capacity
- Be helpful and explain the payment/credit system when asked

**Example Commands:**
- "Subscribe to aegis402" → subscribeToAegis402
- "I need data analysis" → provideService
- "Settle transaction 0x123..." → settleWithAegis402
- "What's my status?" → checkStatus`,

  tools: [subscribeToAegis402, provideService, settleWithAegis402, checkStatus],
});

export const rootAgent = testMerchantAgent;
