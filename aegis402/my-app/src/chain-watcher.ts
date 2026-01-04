/**
 * Chain Watcher
 *
 * Monitors USDC Transfer events to subscribed merchants
 * Uses polling instead of event filters (compatible with public RPCs)
 */

import { ethers, Contract, Provider } from "ethers";
import { TransferEvent } from "./types";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export class ChainWatcher {
  private provider: Provider;
  private usdcContract: Contract;
  private subscribedMerchants: Set<string>;
  private onTransferCallback?: (event: TransferEvent) => void;
  private lastBlock: number = 0;
  private pollInterval?: ReturnType<typeof setInterval>;
  private pollIntervalMs: number;

  constructor(
    usdcAddress: string,
    provider: Provider,
    pollIntervalMs: number = 15000
  ) {
    this.provider = provider;
    this.usdcContract = new Contract(usdcAddress, ERC20_ABI, provider);
    this.subscribedMerchants = new Set();
    this.pollIntervalMs = pollIntervalMs;
  }

  // Add a merchant to watch list
  addMerchant(address: string): void {
    this.subscribedMerchants.add(address.toLowerCase());
    console.log(`👀 Watching transfers to: ${address}`);
  }

  // Remove a merchant from watch list
  removeMerchant(address: string): void {
    this.subscribedMerchants.delete(address.toLowerCase());
  }

  // Set callback for transfer events
  onTransfer(callback: (event: TransferEvent) => void): void {
    this.onTransferCallback = callback;
  }

  // Start watching for transfers using polling
  async start(): Promise<void> {
    console.log("🔍 Chain watcher started - polling for USDC transfers");

    // Get current block as starting point
    try {
      this.lastBlock = await this.provider.getBlockNumber();
      console.log(`   Starting from block: ${this.lastBlock}`);
    } catch (error) {
      console.error("Failed to get current block:", error);
      this.lastBlock = 0;
    }

    // Poll for new events
    this.pollInterval = setInterval(async () => {
      await this.pollForTransfers();
    }, this.pollIntervalMs);
  }

  // Poll for new transfers
  private async pollForTransfers(): Promise<void> {
    if (this.subscribedMerchants.size === 0) return;

    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (currentBlock <= this.lastBlock) return;

      // Query for all Transfer events in the new blocks
      const filter = this.usdcContract.filters.Transfer();
      const events = await this.usdcContract.queryFilter(
        filter,
        this.lastBlock + 1,
        currentBlock
      );

      for (const event of events) {
        const log = event as any;
        const toAddress = log.args[1].toLowerCase();

        // Only process transfers to subscribed merchants
        if (!this.subscribedMerchants.has(toAddress)) continue;

        console.log(`💸 Detected transfer to merchant: ${log.args[1]}`);
        console.log(`   From: ${log.args[0]}`);
        console.log(`   Amount: ${ethers.formatUnits(log.args[2], 6)} USDC`);

        const block = await log.getBlock();

        const transferEvent: TransferEvent = {
          txHash: log.transactionHash,
          from: log.args[0],
          to: log.args[1],
          amount: log.args[2],
          blockNumber: log.blockNumber,
          timestamp: block?.timestamp || Math.floor(Date.now() / 1000),
        };

        if (this.onTransferCallback) {
          this.onTransferCallback(transferEvent);
        }
      }

      this.lastBlock = currentBlock;
    } catch (error) {
      // Silently handle polling errors - they're expected with public RPCs
      // console.debug("Polling error:", error);
    }
  }

  // Stop watching
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.usdcContract.removeAllListeners();
    console.log("🛑 Chain watcher stopped");
  }

  // Get all subscribed merchants
  getMerchants(): string[] {
    return Array.from(this.subscribedMerchants);
  }

  // Find a specific past transfer (for recovery)
  async findTransfer(
    to: string,
    amount: bigint,
    endBlock: number,
    lookbackBlocks: number = 100
  ): Promise<TransferEvent | null> {
    const fromBlock = Math.max(0, endBlock - lookbackBlocks);
    const filter = this.usdcContract.filters.Transfer(null, to);

    try {
      const logs = await this.usdcContract.queryFilter(
        filter,
        fromBlock,
        endBlock
      );

      // Find match with correct amount (search backwards from end)
      for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i] as any;
        if (log.args[2] === amount) {
          const block = await log.getBlock();
          return {
            txHash: log.transactionHash,
            from: log.args[0],
            to: log.args[1],
            amount: log.args[2],
            blockNumber: log.blockNumber,
            timestamp: block?.timestamp || Math.floor(Date.now() / 1000),
          };
        }
      }
    } catch (error) {
      console.error("Error searching past transfers:", error);
    }
    return null;
  }
}
