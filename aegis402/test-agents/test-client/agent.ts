/**
 * Aegis402 Test Client Agent
 *
 * A client agent that:
 * 1. Queries Aegis402 for merchants (by skill + price)
 * 2. Requests services from merchants (via x402)
 * 3. Can slash merchants who don't deliver
 *
 * Modeled after: a2a-x402-typescript/client-agent/agent.ts
 */

import { LlmAgent as Agent } from "adk-typescript/agents";
import { Wallet } from "ethers";
import { processPayment } from "a2a-x402";

// --- Configuration ---

const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
  console.error("❌ WALLET_PRIVATE_KEY required");
  throw new Error("Missing WALLET_PRIVATE_KEY");
}

const wallet = new Wallet(privateKey);
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";
const isDebug = process.env.CLIENT_DEBUG === "true";

function log(...args: any[]) {
  if (isDebug) console.log("[client]", ...args);
}

console.log(`🤖 Test Client Configuration:
  Wallet: ${wallet.address}
  Aegis402: ${AEGIS402_URL}
`);

// --- State ---

interface ClientState {
  selectedMerchant?: {
    address: string;
    x402Endpoint: string;
    skills: string[];
  };
  pendingPayment?: {
    merchantUrl: string;
    requirements: any;
    taskId?: string;
  };
  completedPayments: Map<
    string,
    { merchant: string; amount: string; txHash: string }
  >;
}

const state: ClientState = {
  completedPayments: new Map(),
};

// --- Tool Functions ---

/**
 * Query Aegis402 for merchants that can handle a skill at a price
 */
async function findMerchants(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const skill = params.skill || params.service || "data-analysis";
  const price = params.price || "1000000"; // 1 USDC default

  log(`\n🔍 Querying Aegis402 for skill: ${skill}, price: ${price}`);

  try {
    const response = await fetch(`${AEGIS402_URL}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, price }),
    });

    if (!response.ok) {
      return `❌ Quote request failed: ${response.status}`;
    }

    const result = (await response.json()) as any;

    if (!result.merchants || result.merchants.length === 0) {
      return `No merchants found for skill "${skill}" at ${(
        parseInt(price) / 1_000_000
      ).toFixed(6)} USDC.

Try a different skill or wait for merchants to subscribe to Aegis402.`;
    }

    // Store first merchant for easy selection
    state.selectedMerchant = result.merchants[0];

    const merchantList = result.merchants
      .map(
        (m: any, i: number) =>
          `${i + 1}. **${m.address.substring(0, 10)}...**
   - Endpoint: ${m.x402Endpoint}
   - Capacity: ${(parseInt(m.availableCapacity) / 1_000_000).toFixed(6)} USDC
   - Reputation: ${m.repFactor.toFixed(2)}
   - Skills: ${m.skills.join(", ")}`
      )
      .join("\n\n");

    return `**Found ${result.merchants.length} merchant(s) for "${skill}":**

${merchantList}

To request a service, say: "request data-analysis from merchant 1"`;
  } catch (error) {
    log("❌ Quote error:", error);
    return `❌ Failed to query Aegis402: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Request a service from a merchant (triggers x402 payment flow)
 */
async function requestService(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const serviceName = params.service || params.serviceName || "data-analysis";
  const merchantUrl =
    params.merchantUrl || state.selectedMerchant?.x402Endpoint;

  if (!merchantUrl) {
    return `❌ No merchant selected. Use "find merchants for ${serviceName}" first.`;
  }

  log(`\n📤 Requesting ${serviceName} from ${merchantUrl}...`);

  try {
    // Create session
    const sessionRes = await fetch(
      `${merchantUrl}/apps/aegis402_test_merchant/users/test-client/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    ).catch(() => null);

    const sessionId = sessionRes?.ok
      ? ((await sessionRes.json()) as any).id
      : `session-${Date.now()}`;

    // Request service via ADK /run endpoint
    const response = await fetch(`${merchantUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: "aegis402_test_merchant",
        userId: "test-client",
        sessionId,
        newMessage: {
          role: "user",
          parts: [{ text: `I need ${serviceName}` }],
        },
      }),
    });

    if (!response.ok) {
      return `❌ Merchant error: ${response.status}`;
    }

    const events = (await response.json()) as any[];
    log("📊 Events:", JSON.stringify(events, null, 2));

    // Check for payment requirement
    for (const event of events) {
      if (event.errorCode === "x402_payment_required") {
        const paymentReqs = event.errorData?.paymentRequirements;

        if (paymentReqs?.accepts?.length > 0) {
          const option = paymentReqs.accepts[0];
          const priceUSDC = (
            parseInt(option.maxAmountRequired) / 1_000_000
          ).toFixed(6);
          const product = option.extra?.service?.name || serviceName;

          state.pendingPayment = {
            merchantUrl,
            requirements: paymentReqs,
            taskId: event.invocationId,
          };

          return `**Payment Required:**
- Service: ${product}
- Price: ${priceUSDC} USDC
- Merchant: ${option.payTo.substring(0, 10)}...
- Network: ${option.network}

Would you like to pay? Say "confirm payment" or "cancel".`;
        }
      }
    }

    // Check for regular text response
    for (const event of events) {
      if (event.content?.parts) {
        const text = event.content.parts.map((p: any) => p.text).join("\n");
        if (text) return `Merchant: ${text}`;
      }
    }

    return `Received response from merchant but couldn't parse it.`;
  } catch (error) {
    log("❌ Request error:", error);
    return `❌ Failed to contact merchant: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Confirm and sign a pending payment
 */
async function confirmPayment(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  if (!state.pendingPayment) {
    return "No pending payment. Request a service first.";
  }

  log("💰 Confirming payment...");

  try {
    const paymentOption = state.pendingPayment.requirements.accepts[0];
    const amount = BigInt(paymentOption.maxAmountRequired);

    // Sign EIP-3009 authorization
    log("🔐 Signing payment...");
    const signedPayload = await processPayment(paymentOption, wallet as any);

    log(`✅ Signed! From: ${wallet.address}, Amount: ${amount}`);

    // Send to merchant
    log("📤 Sending payment to merchant...");
    const response = await fetch(state.pendingPayment.merchantUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: state.pendingPayment.taskId,
        message: {
          role: "user",
          parts: [{ text: "Confirming payment" }],
          metadata: {
            "x402.payment.status": "payment-submitted",
            "x402.payment.payload": signedPayload,
          },
        },
      }),
    });

    if (!response.ok) {
      return `❌ Merchant returned error: ${response.status}`;
    }

    const result = (await response.json()) as any;
    log("✅ Merchant response:", JSON.stringify(result, null, 2));

    // Look for txHash in response
    let txHash = "";
    if (result.events) {
      for (const e of result.events) {
        if (e.transaction || e.txHash) {
          txHash = e.transaction || e.txHash;
        }
      }
    }

    // Store completed payment
    if (txHash) {
      state.completedPayments.set(txHash, {
        merchant: paymentOption.payTo,
        amount: amount.toString(),
        txHash,
      });
    }

    const amountUSDC = (Number(amount) / 1_000_000).toFixed(6);
    const pendingPayment = state.pendingPayment;
    state.pendingPayment = undefined;

    let response_text = `✅ Payment submitted!

**Details:**
- Amount: ${amountUSDC} USDC
- From: ${wallet.address}
- To: ${paymentOption.payTo}`;

    if (txHash) {
      response_text += `
- TX: ${txHash}
- BaseScan: https://sepolia.basescan.org/tx/${txHash}`;
    }

    return response_text;
  } catch (error) {
    log("❌ Payment error:", error);
    return `❌ Payment failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Cancel pending payment
 */
async function cancelPayment(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  if (!state.pendingPayment) {
    return "No pending payment to cancel.";
  }

  state.pendingPayment = undefined;
  return "Payment cancelled.";
}

/**
 * Slash a merchant who didn't deliver
 */
async function slashMerchant(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const txHash = params.txHash || params.tx;

  if (!txHash) {
    // Show recent payments
    if (state.completedPayments.size === 0) {
      return "No payments to slash. Make a payment first.";
    }

    const paymentList = Array.from(state.completedPayments.entries())
      .map(
        ([tx, p]) =>
          `- ${tx.substring(0, 20)}... (${(
            parseInt(p.amount) / 1_000_000
          ).toFixed(6)} USDC)`
      )
      .join("\n");

    return `Provide a transaction hash to slash.

**Recent Payments:**
${paymentList}

Usage: "slash 0x123..."`;
  }

  log(`\n🔪 Slashing merchant for tx: ${txHash}`);

  try {
    // First request - get bond requirements
    const response = await fetch(`${AEGIS402_URL}/slash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash }),
    });

    if (response.status === 402) {
      const bondReqs = (await response.json()) as any;
      log("💰 Bond required:", JSON.stringify(bondReqs, null, 2));

      if (!bondReqs.accepts || bondReqs.accepts.length === 0) {
        return "❌ Invalid bond requirements";
      }

      const bondOption = bondReqs.accepts[0];
      const bondAmount = (
        parseInt(bondOption.maxAmountRequired) / 1_000_000
      ).toFixed(6);

      // Sign bond payment
      log("🔐 Signing slash bond...");
      const signedPayload = await processPayment(bondOption, wallet as any);

      // Submit with bond
      log("📤 Submitting slash with bond...");
      const slashResponse = await fetch(`${AEGIS402_URL}/slash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash,
          paymentPayload: signedPayload,
          requirements: bondOption,
        }),
      });

      const slashResult = (await slashResponse.json()) as any;

      if (slashResult.success) {
        state.completedPayments.delete(txHash);

        return `✅ Merchant slashed!

**Slash Details:**
- Transaction: ${txHash}
- Slashed Amount: ${(parseInt(slashResult.slashedAmount) / 1_000_000).toFixed(
          6
        )} USDC
- Bond Paid: ${bondAmount} USDC
- Refund TX: ${slashResult.refundTx || "pending"}

Your funds have been refunded from the merchant's stake.`;
      }

      return `❌ Slash failed: ${slashResult.message}`;
    }

    if (response.ok) {
      const result = (await response.json()) as any;
      return result.success
        ? `✅ Slashed: ${result.message}`
        : `❌ Failed: ${result.message}`;
    }

    return `❌ Slash request failed: ${response.status}`;
  } catch (error) {
    log("❌ Slash error:", error);
    return `❌ Failed to slash: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Get wallet info
 */
async function getWalletInfo(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  return `**Your Wallet:**
- Address: ${wallet.address}

**Completed Payments:** ${state.completedPayments.size}`;
}

// --- Agent Definition ---

export const testClientAgent = new Agent({
  name: "aegis402_test_client",
  model: "gemini-2.0-flash",
  description:
    "A test client agent that discovers merchants via Aegis402 and pays for services",
  instruction: `You are a client agent that uses Aegis402 to find and pay for services.

**Your Capabilities:**
1. **Find Merchants** - Query Aegis402 for merchants offering specific skills
2. **Request Services** - Request work from a merchant (triggers x402 payment)
3. **Confirm Payment** - Sign and submit x402 payment
4. **Slash Merchants** - If a merchant doesn't deliver, slash them for a refund
5. **Check Wallet** - View your wallet address

**Flow:**
1. "Find merchants for data-analysis" → findMerchants
2. "Request data-analysis" → requestService (you'll get a payment prompt)
3. "Confirm payment" → confirmPayment (signs and submits)
4. If merchant doesn't deliver: "Slash 0x123..." → slashMerchant

**Example Commands:**
- "Find merchants for data-analysis at 1 USDC"
- "Request data-analysis from the first merchant"
- "Confirm payment"
- "Cancel payment"
- "Slash transaction 0x123..."
- "What's my wallet address?"

**Important:**
- Always check merchant capacity before requesting
- Confirm payments only after reviewing the price
- Slash only if the merchant failed to deliver after the deadline`,

  tools: [
    findMerchants,
    requestService,
    confirmPayment,
    cancelPayment,
    slashMerchant,
    getWalletInfo,
  ],
});

export const rootAgent = testClientAgent;
