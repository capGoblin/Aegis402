/**
 * CreditManager Contract Client
 *
 * Interacts with the deployed CreditManager.sol on Base Sepolia
 * Contract: 0x9fA96fE9374F351538A051194b54D93350A48FBE
 */

import { ethers, Contract, Signer, Provider, TransactionReceipt } from "ethers";

// CreditManager ABI (only the functions we need)
const CREDIT_MANAGER_ABI = [
  // Read functions
  "function merchants(address) view returns (uint256 stake, uint256 creditLimit, uint256 outstandingExposure, uint256 agentId, string x402Endpoint, bool active)",
  "function availableCapacity(address merchant) view returns (uint256)",
  "function getMerchantSkills(address merchant) view returns (string[])",

  // Write functions (onlyAegis402)
  "function setCreditLimit(address merchant, uint256 creditLimit) external",
  "function subscribeFor(address merchant, uint256 stakeAmount, uint256 agentId, string x402Endpoint, string[] skills) external",
  "function increaseStakeFor(address merchant, uint256 amount) external",
  "function recordPayment(address merchant, uint256 amount) external",
  "function clearExposure(address merchant, uint256 amount) external",
  "function slash(address merchant, address client, uint256 amount) external",

  // Events
  "event Subscribed(address indexed merchant, uint256 stake, uint256 agentId)",
  "event CreditUpdated(address indexed merchant, uint256 creditLimit)",
  "event ExposureIncreased(address indexed merchant, uint256 amount)",
  "event ExposureCleared(address indexed merchant, uint256 amount)",
  "event Slashed(address indexed merchant, address indexed client, uint256 amount)",
];

export interface MerchantOnChain {
  stake: bigint;
  creditLimit: bigint;
  outstandingExposure: bigint;
  agentId: string;
  x402Endpoint: string;
  active: boolean;
}

export class CreditManagerClient {
  private contract: Contract;
  private signer: Signer;
  public readonly address: string;

  constructor(contractAddress: string, signer: Signer) {
    this.address = contractAddress;
    this.signer = signer;
    this.contract = new Contract(contractAddress, CREDIT_MANAGER_ABI, signer);
  }

  // Read a merchant's data
  async getMerchant(merchantAddress: string): Promise<MerchantOnChain> {
    const result = await this.contract.merchants(merchantAddress);
    return {
      stake: result[0],
      creditLimit: result[1],
      outstandingExposure: result[2],
      agentId: result[3],
      x402Endpoint: result[4],
      active: result[5],
    };
  }

  // Get available capacity (creditLimit - exposure)
  async getAvailableCapacity(merchantAddress: string): Promise<bigint> {
    return await this.contract.availableCapacity(merchantAddress);
  }

  // Set credit limit for a merchant (called after stake is verified)
  async setCreditLimit(
    merchantAddress: string,
    creditLimit: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.setCreditLimit(merchantAddress, creditLimit);
    return await tx.wait();
  }

  // Subscribe a merchant on their behalf (agent received stake via x402)
  async subscribeFor(
    merchantAddress: string,
    stakeAmount: bigint,
    agentId: number | string,
    x402Endpoint: string,
    skills: string[]
  ): Promise<TransactionReceipt> {
    // Convert agentId to uint256
    const agentIdNum = BigInt(agentId);
    const tx = await this.contract.subscribeFor(
      merchantAddress,
      stakeAmount,
      agentIdNum,
      x402Endpoint,
      skills
    );
    return await tx.wait();
  }

  // Get merchant's skills
  async getMerchantSkills(merchantAddress: string): Promise<string[]> {
    return await this.contract.getMerchantSkills(merchantAddress);
  }

  // Increase stake for a merchant (agent received via x402)
  async increaseStakeFor(
    merchantAddress: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.increaseStakeFor(merchantAddress, amount);
    return await tx.wait();
  }

  // Record a payment (increases exposure)
  async recordPayment(
    merchantAddress: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.recordPayment(merchantAddress, amount);
    return await tx.wait();
  }

  // Clear exposure after settlement or deadline expiry
  async clearExposure(
    merchantAddress: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.clearExposure(merchantAddress, amount);
    return await tx.wait();
  }

  // Slash merchant and refund client
  async slash(
    merchantAddress: string,
    clientAddress: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.slash(
      merchantAddress,
      clientAddress,
      amount
    );
    return await tx.wait();
  }

  // Event listeners disabled - public RPCs don't support persistent filters
  // These would only work with WebSocket or private RPC endpoints
  onSubscribed(
    callback: (merchant: string, stake: bigint, agentId: string) => void
  ): void {
    console.log(
      "⚠️  Event listeners disabled (public RPC). Use polling instead."
    );
    // No-op: public RPCs don't support filters
  }

  // Listen for CreditUpdated events (disabled)
  onCreditUpdated(
    callback: (merchant: string, creditLimit: bigint) => void
  ): void {
    // No-op
  }

  // Listen for Slashed events (disabled)
  onSlashed(
    callback: (merchant: string, client: string, amount: bigint) => void
  ): void {
    // No-op
  }

  // Stop all listeners (no-op now)
  removeAllListeners(): void {
    // No-op
  }

  // Get filter for Subscribed events (for querying past events)
  getSubscribedFilter(): any {
    return this.contract.filters.Subscribed();
  }

  // Query past Subscribed events (limited range for public RPCs)
  async querySubscribedEvents(filter: any, fromBlock?: number): Promise<any[]> {
    // Public RPCs limit to 100k blocks, use 90k to be safe
    const provider = this.contract.runner?.provider;
    if (!fromBlock && provider) {
      const currentBlock = await provider.getBlockNumber();
      fromBlock = Math.max(0, currentBlock - 90000);
    }
    return await this.contract.queryFilter(filter, fromBlock);
  }

  // Get filter for ExposureIncreased events (pending payments)
  getExposureIncreasedFilter(): any {
    return this.contract.filters.ExposureIncreased();
  }

  // Get filter for ExposureCleared events (settled payments)
  getExposureClearedFilter(): any {
    return this.contract.filters.ExposureCleared();
  }

  // Query past events with block range limit
  async queryEvents(filter: any, fromBlock?: number): Promise<any[]> {
    const provider = this.contract.runner?.provider;
    if (!fromBlock && provider) {
      const currentBlock = await provider.getBlockNumber();
      fromBlock = Math.max(0, currentBlock - 90000);
    }
    return await this.contract.queryFilter(filter, fromBlock);
  }
}
