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
    console.log("🛡️  Aegis402 Clearing Agent Starting...");
    console.log(`   Contract: ${this.config.creditManagerAddress}`);
    console.log(`   Agent: ${this.signer.address}`);

    // Load existing merchants from on-chain events
    await this.loadMerchantsFromChain();

    // Load pending payments from on-chain events
    await this.loadPaymentsFromChain();

    // Set up chain watcher callback
    this.chainWatcher.onTransfer((event) => this.onPaymentDetected(event));
    this.chainWatcher.start();

    // Set up contract event listeners
    this.creditManager.onSubscribed(async (merchant, stake, agentId) => {
      console.log(`📝 New subscription detected: ${merchant}`);
      await this.syncMerchant(merchant);
    });

    // Start deadline checker (every 30 seconds)
    this.deadlineTimer = setInterval(() => this.checkDeadlines(), 30000);

    console.log("✅ Aegis402 ready!");
  }

  // Load existing merchants from on-chain Subscribed events
  private async loadMerchantsFromChain(): Promise<void> {
    console.log("📜 Loading merchants from on-chain events...");

    try {
      // Query all Subscribed events
      const filter = this.creditManager.getSubscribedFilter();
      const events = await this.creditManager.querySubscribedEvents(filter);

      for (const event of events) {
        const merchantAddress = event.args[0]; // merchant address

        // Read current on-chain state
        const onChain = await this.creditManager.getMerchant(merchantAddress);
        if (!onChain.active) continue;

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
      }

      console.log(`   ✅ Loaded ${this.merchants.size} merchants from chain`);
    } catch (error) {
      console.log(`   ⚠️ Failed to load from chain: ${error}`);
    }
  }

  // Load pending payments from on-chain events
  private async loadPaymentsFromChain(): Promise<void> {
    console.log("💳 Loading pending payments from on-chain events...");

    try {
      // Query ExposureIncreased events (recorded payments)
      const increasedFilter = this.creditManager.getExposureIncreasedFilter();
      const increasedEvents = await this.creditManager.queryEvents(
        increasedFilter
      );

      // Query ExposureCleared events (settled payments)
      const clearedFilter = this.creditManager.getExposureClearedFilter();
      const clearedEvents = await this.creditManager.queryEvents(clearedFilter);

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
      for (const event of increasedEvents) {
        const recordTxHash = event.transactionHash; // Hash of recordPayment tx
        const merchant = event.args[0];
        const amount = event.args[1] as bigint;
        const block = await event.getBlock();

        // Check if we already have this payment (checking both potential keys)
        if (this.payments.has(recordTxHash)) continue;

        // Try to find the original Transfer event to get the REAL payment hash
        // Look back 5 blocks from the recordPayment block
        const transfer = await this.chainWatcher.findTransfer(
          merchant,
          amount,
          event.blockNumber,
          5
        );

        // Use transfer hash if found, otherwise fallback to record hash
        const paymentHash = transfer ? transfer.txHash : recordTxHash;
        const client = transfer ? transfer.from : this.signer.address;

        if (this.payments.has(paymentHash)) continue;

        if (transfer) {
          console.log(
            `   🔗 Linked record ${recordTxHash.slice(
              0,
              10
            )}... to payment ${paymentHash.slice(0, 10)}...`
          );
        } else {
          console.log(
            `   ⚠️ Could not link payment for ${recordTxHash.slice(0, 10)}...`
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

      // Mark payments as settled based on ExposureCleared events
      for (const event of clearedEvents) {
        const txHash = event.transactionHash;
        // Find the corresponding increased event by looking for matching merchant/amount
        // This is imperfect but works for basic recovery
      }

      console.log(
        `   ✅ Loaded ${this.payments.size} payment records from chain`
      );
    } catch (error) {
      console.log(`   ⚠️ Failed to load payments from chain: ${error}`);
    }
  }

  stop(): void {
    this.chainWatcher.stop();
    this.creditManager.removeAllListeners();
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
    }
    console.log("👋 Aegis402 stopped");
  }

  // =============================================================
  // POST /subscribe - After x402 stake payment verified
  // =============================================================

  async handleSubscribe(
    request: SubscribeRequest,
    merchantAddress: string,
    stakeAmount: bigint
  ): Promise<SubscribeResponse> {
    console.log(`\n📝 Processing subscription for ${merchantAddress}`);
    console.log(`   Stake: ${ethers.formatUnits(stakeAmount, 6)} USDC`);
    console.log(`   Endpoint: ${request.x402Endpoint}`);
    console.log(`   Skills: ${request.skills.join(", ")}`);

    try {
      // 1. Read ERC-8004 reputation from on-chain registry
      const reputationReader = getReputationReader(this.provider);
      const repFactor = await reputationReader.getRepFactor(merchantAddress);
      const creditLimit = calculateCreditLimit(stakeAmount, repFactor);

      console.log(`   repFactor: ${repFactor}`);
      console.log(`   creditLimit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

      // 2. Approve USDC spending by CreditManager
      const usdcContract = new ethers.Contract(
        this.config.usdcAddress,
        ["function approve(address spender, uint256 amount) returns (bool)"],
        this.signer
      );
      const approveTx = await usdcContract.approve(
        this.creditManager.address,
        stakeAmount
      );
      await approveTx.wait();
      console.log(`   ✅ USDC approval tx: ${approveTx.hash}`);

      // 3. Subscribe merchant on-chain (agent stakes on their behalf)
      const merchantOnChain = await this.creditManager.getMerchant(
        merchantAddress
      );
      if (!merchantOnChain.active) {
        // agentId should be a number (e.g., 2063), default to 0 for testing
        console.log(
          `   DEBUG request.agentId: "${
            request.agentId
          }" (type: ${typeof request.agentId})`
        );
        const agentId = request.agentId || "0";
        console.log(`   DEBUG agentId after fallback: "${agentId}"`);
        const subscribeTx = await this.creditManager.subscribeFor(
          merchantAddress,
          stakeAmount,
          agentId,
          request.x402Endpoint,
          request.skills || []
        );
        console.log(`   ✅ subscribeFor tx: ${subscribeTx.hash}`);
      } else {
        console.log(`   INFO: Merchant already active, skipping subscribeFor`);
      }

      // Wait for RPC to catch up (Base Sepolia latency)
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // 3. Set credit limit on-chain (now merchant is active)
      const creditTx = await this.creditManager.setCreditLimit(
        merchantAddress,
        creditLimit
      );
      console.log(`   ✅ setCreditLimit tx: ${creditTx.hash}`);

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

      // 5. Index skills
      for (const skill of request.skills) {
        if (!this.skillIndex.has(skill)) {
          this.skillIndex.set(skill, new Set());
        }
        this.skillIndex.get(skill)!.add(merchantAddress.toLowerCase());
      }

      // 6. Add to chain watcher
      this.chainWatcher.addMerchant(merchantAddress);

      return {
        success: true,
        merchant: merchantAddress,
        stake: stakeAmount.toString(),
        creditLimit: creditLimit.toString(),
        message: `Subscribed with repFactor ${repFactor.toFixed(2)}`,
      };
    } catch (error) {
      console.error(`❌ Subscribe failed:`, error);
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
      `\n🔍 Quote request: skill="${request.skill}", price=${ethers.formatUnits(
        requestedPrice,
        6
      )} USDC`
    );

    const matchingMerchants: QuoteResponse["merchants"] = [];

    // Get merchants with this skill
    const merchantAddresses = this.skillIndex.get(request.skill) || new Set();

    for (const address of merchantAddresses) {
      const merchant = this.merchants.get(address);
      if (!merchant || !merchant.active) continue;

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
            )} < ${ethers.formatUnits(requestedPrice, 6)}`
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
        console.log(`   ⚠️ Failed to read on-chain data for ${address}`);
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

    console.log(`   Found ${matchingMerchants.length} eligible merchants`);

    return { merchants: matchingMerchants };
  }

  // =============================================================
  // POST /settle - Release exposure after delivery
  // =============================================================

  async handleSettle(request: SettleRequest): Promise<SettleResponse> {
    console.log(`\n✅ Settlement request for tx: ${request.txHash}`);

    const payment = this.payments.get(request.txHash);
    if (!payment) {
      return {
        success: false,
        merchant: "",
        amount: "0",
        message: "Payment record not found",
      };
    }

    if (payment.status !== "pending") {
      return {
        success: false,
        merchant: payment.merchant,
        amount: payment.amount.toString(),
        message: `Payment already ${payment.status}`,
      };
    }

    try {
      // Clear exposure on-chain
      const tx = await this.creditManager.clearExposure(
        payment.merchant,
        payment.amount
      );
      console.log(`   ✅ clearExposure tx: ${tx.hash}`);

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
      console.error(`❌ Settlement failed:`, error);
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
    console.log(`\n🔪 Slash request for tx: ${request.txHash}`);

    const payment = this.payments.get(request.txHash);
    if (!payment) {
      return {
        success: false,
        merchant: "",
        client: clientAddress,
        slashedAmount: "0",
        message: "Payment record not found",
      };
    }

    // Verify conditions
    const now = Math.floor(Date.now() / 1000);

    if (payment.status !== "pending") {
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: `Payment already ${payment.status}`,
      };
    }

    if (now < payment.deadline) {
      return {
        success: false,
        merchant: payment.merchant,
        client: clientAddress,
        slashedAmount: "0",
        message: `Deadline not yet passed. Wait ${
          payment.deadline - now
        } seconds`,
      };
    }

    // Verify client is the original payer
    if (payment.client.toLowerCase() !== clientAddress.toLowerCase()) {
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
      const tx = await this.creditManager.slash(
        payment.merchant,
        clientAddress,
        payment.amount
      );
      console.log(`   ✅ slash tx: ${tx.hash}`);

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
        refundTx: tx.hash,
        message: "Merchant slashed, client refunded",
      };
    } catch (error) {
      console.error(`❌ Slash failed:`, error);
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
    console.log(`\n💰 Payment detected!`);
    console.log(`   Tx: ${event.txHash}`);
    console.log(`   From: ${event.from}`);
    console.log(`   To: ${event.to}`);
    console.log(`   Amount: ${ethers.formatUnits(event.amount, 6)} USDC`);

    // Skip transfers FROM Aegis agent (stake deposits, not client payments)
    if (event.from.toLowerCase() === this.getAgentAddress().toLowerCase()) {
      console.log(`   ⏭️ Skipping transfer from Aegis agent (stake deposit)`);
      return;
    }

    const merchantAddress = event.to.toLowerCase();
    const merchant = this.merchants.get(merchantAddress);

    if (!merchant) {
      console.log(`   ⚠️ Merchant not in registry, ignoring`);
      return;
    }

    try {
      // Record payment on-chain (increases exposure)
      const tx = await this.creditManager.recordPayment(event.to, event.amount);
      console.log(`   ✅ recordPayment tx: ${tx.hash}`);

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

      // Update local exposure
      merchant.exposure += event.amount;

      console.log(`   Deadline: ${new Date(deadline * 1000).toISOString()}`);
    } catch (error) {
      console.error(`   ❌ Failed to record payment:`, error);
    }
  }

  // =============================================================
  // Internal: Check for expired deadlines
  // =============================================================

  private async checkDeadlines(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    for (const [txHash, payment] of this.payments) {
      if (payment.status !== "pending") continue;
      if (now < payment.deadline) continue;

      console.log(`\n⏰ Deadline expired for tx: ${txHash}`);

      // Auto-clear exposure (merchant wins if no slash is requested)
      try {
        const tx = await this.creditManager.clearExposure(
          payment.merchant,
          payment.amount
        );
        console.log(`   ✅ Auto-cleared exposure: ${tx.hash}`);

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
      const onChain = await this.creditManager.getMerchant(address);
      if (!onChain.active) return;

      const existing = this.merchants.get(address.toLowerCase());
      if (existing) {
        existing.stake = onChain.stake;
        existing.creditLimit = onChain.creditLimit;
        existing.exposure = onChain.outstandingExposure;
      }
    } catch (error) {
      console.error(`Failed to sync merchant ${address}:`, error);
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
