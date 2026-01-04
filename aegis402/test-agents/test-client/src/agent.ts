import { LlmAgent as Agent } from "adk-typescript/agents";
import { ToolContext } from "adk-typescript/tools";
import { Wallet } from "ethers";
import { processPayment } from "a2a-x402";
import "dotenv/config";

// --- Configuration ---
const AEGIS402_URL = process.env.AEGIS402_URL || "http://localhost:10001";
const privateKey = process.env.WALLET_PRIVATE_KEY;

if (!privateKey) {
  throw new Error("❌ WALLET_PRIVATE_KEY required in .env");
}

const wallet = new Wallet(privateKey);
console.log(`🤖 Client Agent Wallet: ${wallet.address}`);

// --- State ---
interface AgentState {
  pendingPayment?: {
    merchantUrl: string;
    requirements: any;
  };
  selectedMerchant?: {
    address: string;
    x402Endpoint: string;
    availableCapacity: string;
  };
  requestedPrice?: string; // Price from search
}

const state: AgentState = {};

// --- Tools ---

/**
 * Find merchants for a given skill. Call this with the skill name.
 */
async function findMerchants(
  params: Record<string, any> | string,
  context?: ToolContext
): Promise<string> {
  console.log(
    `🔍 findMerchants raw params:`,
    JSON.stringify(params),
    `type: ${typeof params}`
  );

  let skill = "";
  let price = "10000";

  // ROOT CAUSE FIX: ADK passes params as a JSON string, not an object!
  let parsed: any = params;
  if (typeof params === "string") {
    try {
      parsed = JSON.parse(params);
    } catch {
      // If it's just a plain string like "data-analysis", use as skill
      skill = params;
    }
  }

  // Now extract from parsed object
  if (typeof parsed === "object" && parsed !== null) {
    // Handle nested params.params case (ADK quirk)
    if (parsed.params) {
      if (typeof parsed.params === "string") {
        try {
          parsed = JSON.parse(parsed.params);
        } catch {
          skill = parsed.params;
        }
      } else {
        parsed = parsed.params;
      }
    }

    // Extract skill - prioritize 'query' for full text, then 'skill'
    skill = skill || parsed.query || parsed.skill || parsed.Skill || "";
    if (parsed.price) price = String(parsed.price);
    if (parsed.amount) price = String(parsed.amount);
  }

  // FALLBACK: If skill contains a number, extract it as price
  // e.g., skill="data-analysis 50000" -> skill="data-analysis", price="50000"
  if (skill && !parsed?.price && !parsed?.amount) {
    const match = skill.match(/^(.+?)\s+(\d+)$/);
    if (match) {
      skill = match[1].trim();
      price = match[2];
    }
  }

  console.log(`🔍 Extracted: skill="${skill}", price="${price}"`);

  if (!skill) {
    return "I need a skill. Try: findMerchants({skill: 'data-analysis'})";
  }

  console.log(`🔍 Finding merchants for "${skill}" at ${price}...`);

  try {
    const response = await fetch(`${AEGIS402_URL}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, price }),
    });

    const result = (await response.json()) as any;
    console.log(`📊 Quote response:`, JSON.stringify(result));

    if (!result.merchants || result.merchants.length === 0) {
      const priceUSDC = (parseInt(price) / 1e6).toFixed(6);
      return `No merchants found for skill "${skill}" at price ${priceUSDC} USDC.

⚠️ This could mean:
- No merchants offer this skill
- Your price (${priceUSDC} USDC) exceeds merchant capacity

Try a lower price: "find ${skill} 10000" (0.01 USDC)`;
    }

    const m = result.merchants[0];
    state.selectedMerchant = m;
    state.requestedPrice = price; // Store for later use

    const capacityUSDC = (parseInt(m.availableCapacity) / 1e6).toFixed(6);
    const priceUSDC = (parseInt(price) / 1e6).toFixed(6);

    return `✅ Found ${result.merchants.length} merchant(s) for "${skill}"!

**Selected Merchant:**
- AgentId: ${m.agentId || "N/A"}
- Address: ${m.address}
- Endpoint: ${m.x402Endpoint}
- Skill: ${skill}
- Capacity: ${capacityUSDC} USDC
- Your Price: ${priceUSDC} USDC

Say 'request service' to proceed.`;
  } catch (error) {
    console.error("Error in findMerchants:", error);
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Request service from the selected merchant
 */
async function requestService(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  if (!state.selectedMerchant) {
    return "No merchant selected. Use 'findMerchants' first.";
  }

  const serviceUrl = `${state.selectedMerchant.x402Endpoint}/service`;
  console.log(`📤 Requesting service from ${serviceUrl}...`);

  try {
    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "Service request",
        price: state.requestedPrice,
      }),
    });

    const result = (await response.json()) as any;

    if (response.status === 402 || result.error === "Payment Required") {
      const option = result.accepts?.[0];
      if (option) {
        state.pendingPayment = {
          merchantUrl: serviceUrl,
          requirements: option,
        };
        const amountUSDC = (parseInt(option.maxAmountRequired) / 1e6).toFixed(
          6
        );
        return `💰 Payment Required: ${amountUSDC} USDC
To: ${option.payTo}

Say 'pay' or 'confirm' to proceed with payment.`;
      }
    }

    return `Response: ${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Confirm and pay the pending payment
 */
async function confirmPayment(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  if (!state.pendingPayment) {
    return "No pending payment. Use 'requestService' first.";
  }

  console.log("🔐 Signing payment...");

  try {
    const option = state.pendingPayment.requirements;
    const signedPayload = await processPayment(option, wallet as any);

    console.log("📤 Submitting payment...");

    const response = await fetch(state.pendingPayment.merchantUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-402-Payment": JSON.stringify(signedPayload),
      },
      body: JSON.stringify({ task: "Paid request" }),
    });

    const result = (await response.json()) as any;
    state.pendingPayment = undefined;

    return `✅ Payment submitted!
${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    return `Payment failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Get wallet info
 */
async function getWalletInfo(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  return `Wallet: ${wallet.address}`;
}

/**
 * Settle a transaction
 */
async function settleTx(
  params: Record<string, any> | string,
  context?: ToolContext
): Promise<string> {
  console.log(`🔐 settleTx raw params:`, JSON.stringify(params));

  let txHash = "";
  if (typeof params === "string") {
    txHash = params.trim();
  } else if (params.txHash) {
    txHash = params.txHash;
  } else if (params.txn) {
    txHash = params.txn;
  }

  if (!txHash) {
    return "Please provide a transaction hash to settle.";
  }

  try {
    const response = await fetch(`${AEGIS402_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: txHash }),
    });

    const result = await response.json();
    return `✅ Settlement Result: ${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    return `Error settling: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Slash a merchant for non-delivery (requires bond payment)
 */
async function slashTx(
  params: Record<string, any> | string,
  context?: ToolContext
): Promise<string> {
  console.log(`🔪 slashTx raw params:`, JSON.stringify(params));

  let txHash = "";
  if (typeof params === "string") {
    // Handle "slash 0xabc..." format
    const match = params.match(/0x[a-fA-F0-9]{64}/);
    txHash = match ? match[0] : params.trim();
  } else if (params.txHash) {
    txHash = params.txHash;
  } else if (params.tx) {
    txHash = params.tx;
  } else if (params.query) {
    // Handle LLM passing the full text
    const match = String(params.query).match(/0x[a-fA-F0-9]{64}/);
    txHash = match ? match[0] : "";
  }

  if (!txHash || !txHash.startsWith("0x")) {
    return "Please provide a valid transaction hash to slash. Example: 'slash 0x123...'";
  }

  console.log(`🔪 Slashing tx: ${txHash}`);

  try {
    // Step 1: Get slash bond requirements
    console.log("📤 Step 1: Getting bond requirements...");
    const initialResponse = await fetch(`${AEGIS402_URL}/slash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash }),
    });

    if (initialResponse.status !== 402) {
      const result = (await initialResponse.json()) as any;
      if (result.success) {
        return `✅ Slash completed (no bond needed): ${JSON.stringify(
          result,
          null,
          2
        )}`;
      }
      return `❌ Slash failed: ${
        result.error || result.message || JSON.stringify(result)
      }`;
    }

    // Parse 402 response to get payment requirements
    const paymentReqs = (await initialResponse.json()) as any;
    const bondRequirements = paymentReqs.accepts?.[0];

    if (!bondRequirements) {
      return "❌ Failed to get bond requirements from server";
    }

    const bondAmount = (
      parseInt(bondRequirements.maxAmountRequired) / 1e6
    ).toFixed(6);
    console.log(`💰 Bond required: ${bondAmount} USDC`);

    // Step 2: Sign the bond payment
    console.log("🔐 Step 2: Signing bond payment...");
    const signedPayload = await processPayment(bondRequirements, wallet as any);

    // Step 3: Submit slash with signed bond
    console.log("📤 Step 3: Submitting slash with bond...");
    const slashResponse = await fetch(`${AEGIS402_URL}/slash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash,
        paymentPayload: signedPayload,
        requirements: bondRequirements,
      }),
    });

    const result = (await slashResponse.json()) as any;
    console.log(`📊 Slash result:`, JSON.stringify(result));

    if (result.success) {
      return `✅ Slash Successful!
- Merchant: ${result.merchant}
- Slashed Amount: ${(parseInt(result.slashedAmount) / 1e6).toFixed(6)} USDC
- Refund Tx: ${result.refundTx || "N/A"}
- Bond Paid: ${bondAmount} USDC

The merchant's stake has been slashed and you've been refunded.`;
    } else {
      return `❌ Slash failed: ${
        result.message || result.error || JSON.stringify(result)
      }`;
    }
  } catch (error) {
    console.error("❌ Slash error:", error);
    return `Error slashing: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

// --- Agent ---

export const clientAgent = new Agent({
  name: "aegis_test_client",
  model: "gemini-2.0-flash-exp",
  description: "Test client for Aegis402 payment flows",
  instruction: `You are a test client for Aegis402.

CRITICAL: When calling findMerchants, pass the user's EXACT text as the query parameter.
Example: User says "find data-analysis 50000" -> call findMerchants({query: "data-analysis 50000"})
DO NOT extract or parse - just pass the full text.

VERY IMPORTANT: When tools return results, show ALL the information EXACTLY as returned.
- After findMerchants: ALWAYS show Capacity, Address, Endpoint, and Price. Never omit capacity.
- Use the exact formatting from the tool response.

Flow:
1. findMerchants - pass the FULL user text as query
2. requestService - no params needed  
3. confirmPayment - no params needed
4. settleTx - pass the transaction hash if user asks to settle
5. slashTx - slash a merchant if they didn't deliver (pass tx hash)

Current wallet: ${wallet.address}`,
  tools: [
    findMerchants,
    requestService,
    confirmPayment,
    getWalletInfo,
    settleTx,
    slashTx,
  ],
});

export const rootAgent = clientAgent;
