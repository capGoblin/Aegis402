/**
 * Aegis402 Type Definitions
 */

// Merchant record - stored in-memory, mirrors on-chain data
export interface MerchantRecord {
  address: string;
  agentId: string; // bytes32 from ERC-8004
  x402Endpoint: string;
  skills: string[];
  stake: bigint;
  creditLimit: bigint;
  exposure: bigint;
  registeredAt: number;
  active: boolean;
}

// Payment record - tracks pending deliveries
export interface PaymentRecord {
  txHash: string;
  merchant: string;
  client: string;
  amount: bigint;
  deadline: number; // Unix timestamp
  status: "pending" | "settled" | "slashed" | "expired";
  createdAt: number;
}

// API Request/Response types

export interface SubscribeRequest {
  x402Endpoint: string;
  skills: string[];
  agentId: string; // ERC-8004 identity
}

export interface SubscribeResponse {
  success: boolean;
  merchant: string;
  stake: string;
  creditLimit: string;
  message?: string;
}

export interface QuoteRequest {
  skill: string;
  price: string; // Atomic units
}

export interface QuoteResponse {
  merchants: Array<{
    address: string;
    x402Endpoint: string;
    availableCapacity: string;
    repFactor: number;
    skills: string[];
  }>;
}

export interface SettleRequest {
  txHash: string;
}

export interface SettleResponse {
  success: boolean;
  merchant: string;
  amount: string;
  message?: string;
}

export interface SlashRequest {
  txHash: string;
}

export interface SlashResponse {
  success: boolean;
  merchant: string;
  client: string;
  slashedAmount: string;
  refundTx?: string;
  message?: string;
}

// Chain watcher event
export interface TransferEvent {
  txHash: string;
  from: string;
  to: string;
  amount: bigint;
  blockNumber: number;
  timestamp: number;
}

// Reputation calculation
export interface ReputationInputs {
  agentId: string;
  totalCompleted: number;
  totalFailed: number;
  accountAgeDays: number;
  slashCount: number;
}

export interface ReputationResult {
  factor: number; // 0.5 to 3.0
  breakdown: {
    base: number;
    completionBonus: number;
    ageBonus: number;
    slashPenalty: number;
  };
}
