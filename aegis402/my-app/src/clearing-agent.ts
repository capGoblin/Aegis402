/**
 * Aegis402 Clearing Agent
 *
 * The main credit clearinghouse logic
 * - Manages merchant registry
 * - Tracks payment deadlines
 * - Handles settlement and slashing
 */

import { ethers, Wallet, Provider } from "ethers";
import { CreditManagerClient } from "./credit-manager";
import { ChainWatcher } from "./chain-watcher";
import {
  calculateRepFactor,
  calculateCreditLimit,
  readERC8004,
  getReputationReader,
} from "./reputation";
import {
  MerchantRecord,
  PaymentRecord,
  SubscribeRequest,
  SubscribeResponse,
  QuoteRequest,
  QuoteResponse,
  SettleRequest,
  SettleResponse,
  SlashRequest,
  SlashResponse,
  TransferEvent,
} from "./types";

export interface Aegis402Config {
  creditManagerAddress: string;
  usdcAddress: string;
  rpcUrl: string;
  privateKey: string;
  defaultDeadlineSeconds: number;
  startBlock?: number;
}

export class Aegis402 {
  private config: Aegis402Config;
  private provider: Provider;
  private signer: Wallet;
  private creditManager: CreditManagerClient;
  private chainWatcher: ChainWatcher;

  // In-memory stores
  private merchants: Map<string, MerchantRecord> = new Map();
  private payments: Map<string, PaymentRecord> = new Map();
  private skillIndex: Map<string, Set<string>> = new Map(); // skill -> merchant addresses

  // Deadline timer
  private deadlineTimer?: ReturnType<typeof setInterval>;

  constructor(config: Aegis402Config) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new Wallet(config.privateKey, this.provider);
    this.creditManager = new CreditManagerClient(
      config.creditManagerAddress,
      this.signer
    );
    this.chainWatcher = new ChainWatcher(config.usdcAddress, this.provider);
  }

  async start(): Promise<void> {
    console.log("🛡️  [Aegis402] Clearing Agent Starting...");
    console.log(`   Contract: ${this.config.creditManagerAddress}`);
    console.log(`   Agent: ${this.signer.address}`);
    console.log(`   RPC URL: ${this.config.rpcUrl}`);
    console.log(`   USDC Contract: ${this.config.usdcAddress}`);

    try {
      // Load existing merchants from on-chain events
      await this.loadMerchantsFromChain();

      // Load pending payments from on-chain events
      await this.loadPaymentsFromChain();

      // Set up chain watcher callback
      console.log("   Initializing ChainWatcher...");
      this.chainWatcher.onTransfer((event) => this.onPaymentDetected(event));
      this.chainWatcher.start();

      // Set up contract event listeners
      console.log("   Initializing CreditManager listeners...");
      this.creditManager.onSubscribed(async (merchant, stake, agentId) => {
        console.log(
          `📝 [Event] New subscription detected: ${merchant}, stake=${stake.toString()}, agentId=${agentId}`
        );
        await this.syncMerchant(merchant);
      });

      // Start deadline checker (every 30 seconds)
      console.log("   Starting deadline timer (30s interval)...");
      this.deadlineTimer = setInterval(() => this.checkDeadlines(), 30000);

      console.log("✅ [Aegis402] Agent ready and listening!");
    } catch (error) {
      console.error("❌ [Aegis402] Fatal error during startup:", error);
      throw error;
    }
  }

  // Load existing merchants from on-chain Subscribed events
  private async loadMerchantsFromChain(): Promise<void> {
    console.log("📜 [Recovery] Loading merchants from on-chain events...");

    try {
      // Query all Subscribed events
      const filter = this.creditManager.getSubscribedFilter();
      // NOTE: querySubscribedEvents has logged query range internally
      console.log("   Querying past 'Subscribed' events...");
      const events = await this.creditManager.querySubscribedEvents(
        filter,
        this.config.startBlock
      );

      console.log(`   Found ${events.length} past subscription events.`);

      for (const event of events) {
        const merchantAddress = event.args[0]; // merchant address

        // Read current on-chain state
        try {
          const onChain = await this.creditManager.getMerchant(merchantAddress);
          if (!onChain.active) {
            console.log(
              `   Merchant ${merchantAddress} is no longer active, skipping.`
            );
            continue;
          }

          // Get skills from on-chain
          const skills = await this.creditManager.getMerchantSkills(
            merchantAddress
          );

          // Add to local registry
          const merchant: MerchantRecord = {
            address: merchantAddress,
            agentId: onChain.agentId.toString(),
            x402Endpoint: onChain.x402Endpoint,
            skills: skills,
            stake: onChain.stake,
            creditLimit: onChain.creditLimit,
            exposure: onChain.outstandingExposure,
            registeredAt: Math.floor(Date.now() / 1000), // Use current time as fallback
            active: true,
          };
          this.merchants.set(merchantAddress.toLowerCase(), merchant);

          // Index skills for discovery
          for (const skill of skills) {
            if (!this.skillIndex.has(skill)) {
              this.skillIndex.set(skill, new Set());
            }
            this.skillIndex.get(skill)!.add(merchantAddress.toLowerCase());
          }

          // Add to chain watcher
          this.chainWatcher.addMerchant(merchantAddress);
          console.log(
            `   RESTORED: ${merchantAddress} (Skills: ${skills.length})`
          );
        } catch (err) {
          console.error(
            `   ❌ Failed to restore merchant ${merchantAddress}:`,
            err
          );
        }
      }

      console.log(
        `   ✅ [Recovery] Merchant registry restored: ${this.merchants.size} active merchants`
      );
    } catch (error) {
      console.error(
        `   ⚠️ [Recovery] Failed to load merchants from chain:`,
        error
      );
    }
  }

  // Load pending payments from on-chain events
  private async loadPaymentsFromChain(): Promise<void> {
    console.log(
      "💳 [Recovery] Loading pending payments from on-chain events..."
    );

    try {
      // Query ExposureIncreased events (recorded payments)
      const increasedFilter = this.creditManager.getExposureIncreasedFilter();
      console.log("   Querying 'ExposureIncreased' events...");
      const increasedEvents = await this.creditManager.queryEvents(
        increasedFilter,
        this.config.startBlock
      );

      // Query ExposureCleared events (settled payments)
      const clearedFilter = this.creditManager.getExposureClearedFilter();
      console.log("   Querying 'ExposureCleared' events...");
      const clearedEvents = await this.creditManager.queryEvents(
        clearedFilter,
        this.config.startBlock
      );

      console.log(
        `   Found ${increasedEvents.length} increased events, ${clearedEvents.length} cleared events.`
      );

      // Track settled amounts per merchant (cumulative)
      const settledAmounts = new Map<string, bigint>();
      for (const event of clearedEvents) {
        const merchant = event.args[0].toLowerCase();
        const amount = event.args[1];
        settledAmounts.set(
          merchant,
          (settledAmounts.get(merchant) || 0n) + amount
        );
      }

      // Track increased amounts per merchant to find pending
      const pendingAmounts = new Map<string, bigint>();
      for (const event of increasedEvents) {
        const merchant = event.args[0].toLowerCase();
        const amount = event.args[1];
        pendingAmounts.set(
          merchant,
          (pendingAmounts.get(merchant) || 0n) + amount
        );
      }

      // For each ExposureIncreased event, create a payment record if not fully cleared
      // NOTE: This logic simplifies "cleared vs pending".
      // Ideally we match specific payments, but exposure is fungible on-chain.
      for (const event of increasedEvents) {
        const recordTxHash = event.transactionHash; // Hash of recordPayment tx
        const merchant = event.args[0];
        const amount = event.args[1] as bigint;
        const block = await event.getBlock();

        console.log(
          `   Processing recorded payment: ${recordTxHash} for ${merchant}, amount: ${amount}`
        );

        // Check if we already have this payment (checking both potential keys)
        if (this.payments.has(recordTxHash)) {
          console.log("   Duplicate record, skipping.");
          continue;
        }

        // Try to find the original Transfer event to get the REAL payment hash
        // Look back 5 blocks from the recordPayment block
        console.log("   Searching for original Transfer event...");
        const transfer = await this.chainWatcher.findTransfer(
          merchant,
          amount,
          event.blockNumber,
          5
        );

        // Use transfer hash if found, otherwise fallback to record hash
        const paymentHash = transfer ? transfer.txHash : recordTxHash;
        const client = transfer ? transfer.from : this.signer.address;

        if (this.payments.has(paymentHash)) {
          console.log(
            "   Payment already indexed under different hash, skipping."
          );
          continue;
        }

        if (transfer) {
          console.log(
            `   🔗 Linked record ${recordTxHash.slice(
              0,
              10
            )}... to payment ${paymentHash.slice(0, 10)}... (Client: ${client})`
          );
        } else {
          console.log(
            `   ⚠️ Could not link payment for ${recordTxHash.slice(
              0,
              10
            )}... Using record hash.`
          );
        }

        // Create payment record with pending status
        const payment: PaymentRecord = {
          txHash: paymentHash,
          merchant,
          client: client,
          amount,
          deadline:
            (block?.timestamp || Math.floor(Date.now() / 1000)) +
            this.config.defaultDeadlineSeconds,
          status: "pending",
          createdAt: block?.timestamp || Math.floor(Date.now() / 1000),
        };

        this.payments.set(paymentHash, payment);
      }

      console.log(
        `   ✅ [Recovery] Restored ${this.payments.size} payment records from state history.`
      );
    } catch (error) {
      console.error(
        `   ⚠️ [Recovery] Failed to load payments from chain:`,
        error
      );
    }
  }

  stop(): void {
    console.log("🛑 [Aegis402] Stopping agent...");
    this.chainWatcher.stop();
    this.creditManager.removeAllListeners();
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
    }
    console.log("👋 [Aegis402] Stopped.");
  }

  // =============================================================
  // POST /subscribe - After x402 stake payment verified
  // =============================================================

  async handleSubscribe(
    request: SubscribeRequest,
    merchantAddress: string,
    stakeAmount: bigint
  ): Promise<SubscribeResponse> {
    console.log(
      `\n📝 [Subscribe] Processing subscription for ${merchantAddress}`
    );
    console.log(`   Stake: ${ethers.formatUnits(stakeAmount, 6)} USDC`);
    console.log(`   Endpoint: ${request.x402Endpoint}`);
    console.log(`   Skills: ${request.skills.join(", ")}`);
    console.log(`   AgentId: ${request.agentId}`);

    try {
      // 1. Read ERC-8004 reputation from on-chain registry
      const reputationReader = getReputationReader(this.provider);
      console.log(`   Fetching reputation for ${merchantAddress}...`);

      // Use agentId if provided, otherwise fall back to address lookup
      let repFactor: number;
      if (request.agentId && request.agentId !== "0") {
        console.log(`   Using agentId ${request.agentId} for ERC-8004 lookup`);
        repFactor = await reputationReader.getRepFactorByAgentId(
          request.agentId
        );
      } else {
        console.log(`   Using address ${merchantAddress} for ERC-8004 lookup`);
        repFactor = await reputationReader.getRepFactor(merchantAddress);
      }

      const creditLimit = calculateCreditLimit(stakeAmount, repFactor);

      console.log(`   repFactor: ${repFactor}`);
      console.log(
        `   creditLimit (calculated): ${ethers.formatUnits(
          creditLimit,
          6
        )} USDC`
      );

      // 2. Approve USDC spending by CreditManager
      const usdcContract = new ethers.Contract(
        this.config.usdcAddress,
        [
          "function approve(address spender, uint256 amount) returns (bool)",
          "function allowance(address owner, address spender) view returns (uint256)",
        ],
        this.signer
      );
      console.log("   Approving USDC transfer to CreditManager...");
      const approveTx = await usdcContract.approve(
        this.creditManager.address,
        stakeAmount
      );
      console.log(`   ⏳ Waiting for approval tx: ${approveTx.hash}`);
      await approveTx.wait();
      console.log(`   ✅ USDC approved. Hash: ${approveTx.hash}`);

      // Wait for allowance to be reflected
      console.log("   Waiting 2s for allowance propagation...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const allowance = await usdcContract.allowance(
        this.signer.address,
        this.creditManager.address
      );
      console.log(
        `   Current Allowance: ${allowance.toString()} (Required: ${stakeAmount})`
      );

      if (allowance < BigInt(stakeAmount)) {
        throw new Error(
          `Allowance too low! approved=${allowance}, required=${stakeAmount}`
        );
      }

      // 3. Subscribe merchant on-chain (agent stakes on their behalf)
      const merchantOnChain = await this.creditManager.getMerchant(
        merchantAddress
      );
      console.log(`   On-chain status active: ${merchantOnChain.active}`);

      if (!merchantOnChain.active) {
        // agentId should be a number (e.g., 2063), default to 0 for testing
        const agentId = request.agentId || "0";
        console.log(`   Calling subscribeFor (agentId: ${agentId})...`);
        const subscribeTxReceipt = await this.creditManager.subscribeFor(
          merchantAddress,
          stakeAmount,
          agentId,
          request.x402Endpoint,
          request.skills || []
        );
        console.log(
          `   ✅ subscribeFor confirmed: ${subscribeTxReceipt?.hash}`
        );
      } else {
        console.log(
          `   INFO: Merchant already active on-chain, skipping subscribeFor call.`
        );
      }

      // Wait for RPC to catch up (Base Sepolia latency)
      console.log("   Giving RPC 2s to index events...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 3. Set credit limit on-chain (now merchant is active)
      console.log(`   Setting credit limit to ${creditLimit}...`);
      const creditTxReceipt = await this.creditManager.setCreditLimit(
        merchantAddress,
        creditLimit
      );
      console.log(`   ✅ Credit limit set: ${creditTxReceipt?.hash}`);

      // 4. Store in local registry
      const merchant: MerchantRecord = {
        address: merchantAddress,
        agentId: request.agentId,
        x402Endpoint: request.x402Endpoint,
        skills: request.skills,
        stake: stakeAmount,
        creditLimit: creditLimit,
        exposure: 0n,
        registeredAt: Math.floor(Date.now() / 1000),
        active: true,
      };

      this.merchants.set(merchantAddress.toLowerCase(), merchant);
      console.log(`   Stored merchant in local registry.`);

      // 5. Index skills
      for (const skill of request.skills) {
        if (!this.skillIndex.has(skill)) {
          this.skillIndex.set(skill, new Set());
        }
        this.skillIndex.get(skill)!.add(merchantAddress.toLowerCase());
      }
      console.log(`   Indexed ${request.skills.length} skills.`);

      // 6. Add to chain watcher
      this.chainWatcher.addMerchant(merchantAddress);
      console.log(`   Added to ChainWatcher monitoring.`);

      return {
        success: true,
        merchant: merchantAddress,
        stake: stakeAmount.toString(),
        creditLimit: creditLimit.toString(),
        message: `Subscribed with repFactor ${repFactor.toFixed(2)}`,
      };
    } catch (error) {
      console.error(`❌ [Subscribe] Operation failed:`, error);
      if (error instanceof Error) console.error(error.stack);
      return {
        success: false,
        merchant: merchantAddress,
        stake: stakeAmount.toString(),
        creditLimit: "0",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // =============================================================
  // POST /quote - Free discovery endpoint
  // =============================================================

  async handleQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const requestedPrice = BigInt(request.price);
    console.log(
      `\n🔍 [Quote] Request: skill="${
        request.skill
      }", price=${ethers.formatUnits(requestedPrice, 6)} USDC`
    );

    const matchingMerchants: QuoteResponse["merchants"] = [];

    // Get merchants with this skill
    const merchantAddresses = this.skillIndex.get(request.skill) || new Set();
    console.log(
      `   Candidates with skill "${request.skill}": ${merchantAddresses.size}`
    );

    for (const address of merchantAddresses) {
      const merchant = this.merchants.get(address);
      if (!merchant || !merchant.active) {
        // console.log(`   Skipping inactive/unknown merchant: ${address}`);
        continue;
      }

      // Read FRESH exposure from on-chain (not stale local state)
      try {
        const onChainData = await this.creditManager.getMerchant(address);
        const capacity =
          onChainData.creditLimit - onChainData.outstandingExposure;

        // Filter: capacity >= price
        if (capacity < requestedPrice) {
          console.log(
            `   ❌ ${address}: capacity ${ethers.formatUnits(
              capacity,
              6
            )} < required ${ethers.formatUnits(requestedPrice, 6)}`
          );
          continue;
        }

        // Calculate repFactor for ranking from ERC-8004 registry
        const reputationReader = getReputationReader(this.provider);
        const repFactor = await reputationReader.getRepFactor(address);

        matchingMerchants.push({
          address: merchant.address,
          x402Endpoint: merchant.x402Endpoint,
          availableCapacity: capacity.toString(),
          repFactor: repFactor,
          skills: merchant.skills,
        });
      } catch (error) {
        console.error(
          `   ⚠️ Failed to read on-chain data for ${address}:`,
          error
        );
        continue;
      }
    }

    // Rank by capacity / price (higher is better)
    matchingMerchants.sort((a, b) => {
      const ratioA =
        Number(BigInt(a.availableCapacity)) / Number(requestedPrice);
      const ratioB =
        Number(BigInt(b.availableCapacity)) / Number(requestedPrice);
      return ratioB - ratioA;
    });

    console.log(
      `   Found ${matchingMerchants.length} eligible merchants after filtering.`
    );

    return { merchants: matchingMerchants };
  }

  // =============================================================
  // POST /settle - Release exposure after delivery
  // =============================================================

  async handleSettle(request: SettleRequest): Promise<SettleResponse> {
    console.log(`\n✅ [Settle] Request for tx: ${request.txHash}`);

    const payment = this.payments.get(request.txHash);
    if (!payment) {
      console.warn("   ⚠️ Payment record not found in local state.");
      return {
        success: false,
        merchant: "",
        amount: "0",
        message: "Payment record not found",
      };
    }

    if (payment.status !== "pending") {
      console.warn(`   ⚠️ Payment is already ${payment.status}.`);
      return {
        success: false,
        merchant: payment.merchant,
        amount: payment.amount.toString(),
        message: `Payment already ${payment.status}`,
      };
    }

    try {
      // Clear exposure on-chain
      console.log(
        `   Calling clearExposure for ${payment.merchant} amount ${payment.amount}...`
      );
      const txReceipt = await this.creditManager.clearExposure(
        payment.merchant,
        payment.amount
      );
      console.log(`   ✅ Exposure cleared on-chain: ${txReceipt?.hash}`);

      // Update local records
      payment.status = "settled";
      const merchant = this.merchants.get(payment.merchant.toLowerCase());
      if (merchant) {
        merchant.exposure -= payment.amount;
      }

      return {
        success: true,
        merchant: payment.merchant,
        amount: payment.amount.toString(),
        message: "Exposure cleared successfully",
      };
    } catch (error) {
      console.error(`❌ [Settle] Operation failed:`, error);
      if (error instanceof Error) console.error(error.stack);
      return {
        success: false,
        merchant: payment.merchant,
        amount: payment.amount.toString(),
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // =============================================================
  // POST /slash - Slash merchant after deadline (requires bond)
  // =============================================================

  async handleSlash(
    request: SlashRequest,
    clientAddress: string
  ): Promise<SlashResponse> {
    console.log(`\n🔪 [Slash] Request for tx: ${request.txHash}`);
    console.log(`   Requester (Client): ${clientAddress}`);

    const payment = this.payments.get(request.txHash);
    if (!payment) {
      console.warn("   ⚠️ Payment record not found.");
      return {
        success: false,
        merchant: "",
        client: clientAddress,
        slashedAmount: "0",
        message: "Payment record not found",
      };
    }

    console.log(`   Payment Status: ${payment.status}`);
    console.log(`   Payment Deadline: ${payment.deadline}`);
    console.log(`   Current Time: ${Math.floor(Date.now() / 1000)}`);

    // Verify conditions
    const now = Math.floor(Date.now() / 1000);

    if (payment.status !== "pending") {
      console.warn(`   ⚠️ Cannot slash: Status is ${payment.status}`);
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: `Payment already ${payment.status}`,
      };
    }

    if (now < payment.deadline) {
      const waitTime = payment.deadline - now;
      console.warn(
        `   ⚠️ Cannot slash: Deadline not passed. Wait ${waitTime}s`
      );
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: `Deadline not yet passed. Wait ${waitTime} seconds`,
      };
    }

    // Verify client is the original payer
    if (payment.client.toLowerCase() !== clientAddress.toLowerCase()) {
      console.warn(`   ⚠️ Authorization mismatch: Payer was ${payment.client}`);
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: "Only the original client can slash",
      };
    }

    try {
      // Slash on-chain
      console.log(`   Calling slash() on contract...`);
      const txReceipt = await this.creditManager.slash(
        payment.merchant,
        clientAddress,
        payment.amount
      );
      console.log(`   ✅ Slash transaction confirmed: ${txReceipt?.hash}`);

      // Update local records
      payment.status = "slashed";
      const merchant = this.merchants.get(payment.merchant.toLowerCase());
      if (merchant) {
        merchant.exposure -= payment.amount;
        merchant.stake -= payment.amount;
      }

      return {
        success: true,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: payment.amount.toString(),
        refundTx: txReceipt?.hash,
        message: "Merchant slashed, client refunded",
      };
    } catch (error) {
      console.error(`❌ [Slash] Operation failed:`, error);
      if (error instanceof Error) console.error(error.stack);
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // =============================================================
  // Internal: Called by chain watcher when USDC transfer detected
  // =============================================================

  private async onPaymentDetected(event: TransferEvent): Promise<void> {
    console.log(`\n💰 [ChainWatcher] Payment detected!`);
    console.log(`   Tx: ${event.txHash}`);
    console.log(`   From: ${event.from}`);
    console.log(`   To: ${event.to}`);
    console.log(`   Amount: ${ethers.formatUnits(event.amount, 6)} USDC`);

    // Skip transfers FROM Aegis agent (stake deposits, not client payments)
    if (event.from.toLowerCase() === this.getAgentAddress().toLowerCase()) {
      console.log(
        `   ⏭️ Skipping transfer from Aegis agent (internal stake deposit)`
      );
      return;
    }

    const merchantAddress = event.to.toLowerCase();
    const merchant = this.merchants.get(merchantAddress);

    if (!merchant) {
      console.log(
        `   ⚠️ Recipient ${merchantAddress} is not a registered merchant, ignoring`
      );
      return;
    }

    try {
      // Record payment on-chain (increases exposure)
      console.log("   Recording payment on-chain...");
      const txReceipt = await this.creditManager.recordPayment(
        event.to,
        event.amount
      );
      console.log(`   ✅ recordPayment tx: ${txReceipt?.hash}`);

      // Store payment record with deadline
      const deadline = event.timestamp + this.config.defaultDeadlineSeconds;
      const payment: PaymentRecord = {
        txHash: event.txHash,
        merchant: event.to,
        client: event.from,
        amount: event.amount,
        deadline: deadline,
        status: "pending",
        createdAt: event.timestamp,
      };

      this.payments.set(event.txHash, payment);
      console.log(
        `   Payment tracked with deadline: ${new Date(
          deadline * 1000
        ).toISOString()}`
      );

      // Update local exposure
      merchant.exposure += event.amount;
    } catch (error) {
      console.error(`   ❌ Failed to record payment on-chain:`, error);
    }
  }

  // =============================================================
  // Internal: Check for expired deadlines
  // =============================================================

  private async checkDeadlines(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // console.log(`   (Deadline Check at ${new Date().toISOString()})`);

    for (const [txHash, payment] of this.payments) {
      if (payment.status !== "pending") continue;
      if (now < payment.deadline) continue;

      console.log(`\n⏰ [Deadline] Expired for payment: ${txHash}`);
      console.log(`   Merchant: ${payment.merchant}`);
      console.log(`   Amount: ${ethers.formatUnits(payment.amount, 6)} USDC`);

      // Auto-clear exposure (merchant wins if no slash is requested)
      try {
        console.log("   Auto-clearing exposure...");
        const txReceipt = await this.creditManager.clearExposure(
          payment.merchant,
          payment.amount
        );
        console.log(`   ✅ Auto-clear tx: ${txReceipt?.hash}`);

        payment.status = "expired";
        const merchant = this.merchants.get(payment.merchant.toLowerCase());
        if (merchant) {
          merchant.exposure -= payment.amount;
        }
      } catch (error) {
        console.error(`   ❌ Failed to auto-clear:`, error);
      }
    }
  }

  // =============================================================
  // Utility: Sync merchant from on-chain data
  // =============================================================

  private async syncMerchant(address: string): Promise<void> {
    try {
      console.log(`   Syncing merchant ${address} from chain...`);
      const onChain = await this.creditManager.getMerchant(address);
      if (!onChain.active) {
        console.log(`   Merchant inactive, ignoring.`);
        return;
      }

      const existing = this.merchants.get(address.toLowerCase());
      if (existing) {
        existing.stake = onChain.stake;
        existing.creditLimit = onChain.creditLimit;
        existing.exposure = onChain.outstandingExposure;
        console.log(
          `   Updated local state: Stake=${onChain.stake}, Exposure=${onChain.outstandingExposure}`
        );
      }
    } catch (error) {
      console.error(`   ❌ Failed to sync merchant ${address}:`, error);
    }
  }

  // =============================================================
  // Getters for API
  // =============================================================

  getMerchant(address: string): MerchantRecord | undefined {
    return this.merchants.get(address.toLowerCase());
  }

  getAllMerchants(): MerchantRecord[] {
    return Array.from(this.merchants.values());
  }

  getPayment(txHash: string): PaymentRecord | undefined {
    return this.payments.get(txHash);
  }

  getAgentAddress(): string {
    return this.signer.address;
  }
}
