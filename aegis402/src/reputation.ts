/**
 * Reputation Calculator - ERC-8004 Integration
 *
 * Reads reputation scores from the ERC-8004 Reputation Registry on Base Sepolia
 * and computes repFactor for credit limit calculations.
 *
 * repFactor = averageScore / 100
 * creditLimit = stake × repFactor
 */

import { ethers, Contract, Provider } from "ethers";
import { ReputationInputs, ReputationResult } from "./types";

// ERC-8004 Registry Addresses (Base Sepolia)
export const ERC8004_ADDRESSES = {
  identityRegistry: "0x8004AA63c570c570eBF15376c0dB199918BFe9Fb",
  reputationRegistry: "0x8004bd8daB57f14Ed299135749a5CB5c42d341BF",
  validationRegistry: "0x8004C269D0A5647E51E121FeB226200ECE932d55",
};

// Reputation Registry ABI (NewFeedback event)
const REPUTATION_REGISTRY_ABI = [
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint8 score, bytes32 indexed tag1, bytes32 tag2, string fileuri, bytes32 filehash)",
];

// Identity Registry ABI (to get agentId from address)
const IDENTITY_REGISTRY_ABI = [
  "function getAgentId(address agent) view returns (uint256)",
  "function getAgentAddress(uint256 agentId) view returns (address)",
];

export interface FeedbackEntry {
  agentId: bigint;
  clientAddress: string;
  score: number;
  tag1: string;
  tag2: string;
  fileuri: string;
  filehash: string;
  blockNumber: number;
}

/**
 * ERC-8004 Reputation Reader
 *
 * Fetches reputation scores from the on-chain Reputation Registry
 */
export class ERC8004ReputationReader {
  private provider: Provider;
  private reputationRegistry: Contract;
  private identityRegistry: Contract;

  constructor(provider: Provider) {
    this.provider = provider;
    this.reputationRegistry = new Contract(
      ERC8004_ADDRESSES.reputationRegistry,
      REPUTATION_REGISTRY_ABI,
      provider,
    );
    this.identityRegistry = new Contract(
      ERC8004_ADDRESSES.identityRegistry,
      IDENTITY_REGISTRY_ABI,
      provider,
    );
  }

  /**
   * Get agentId from an address via Identity Registry
   */
  async getAgentId(address: string): Promise<bigint | null> {
    try {
      const agentId = await this.identityRegistry.getAgentId(address);
      return agentId > 0n ? agentId : null;
    } catch (error) {
      console.log(`⚠️ No ERC-8004 identity found for ${address}`);
      return null;
    }
  }

  /**
   * Fetch all NewFeedback events for a given agentId
   */
  async getFeedbackEntries(
    agentId: bigint,
    fromBlock?: number,
  ): Promise<FeedbackEntry[]> {
    try {
      // Get current block to calculate range (RPC limits to 100k blocks)
      const currentBlock = await this.provider.getBlockNumber();
      const startBlock = fromBlock ?? Math.max(0, currentBlock - 2000); // RPC limits (e.g. 2000 blocks)

      console.log(
        `   Querying feedback events from block ${startBlock} to ${currentBlock}`,
      );

      const filter = this.reputationRegistry.filters.NewFeedback(agentId);
      const events = await this.reputationRegistry.queryFilter(
        filter,
        startBlock,
        currentBlock,
      );

      const entries: FeedbackEntry[] = events.map((event: any) => ({
        agentId: event.args[0],
        clientAddress: event.args[1],
        score: Number(event.args[2]),
        tag1: event.args[3],
        tag2: event.args[4],
        fileuri: event.args[5],
        filehash: event.args[6],
        blockNumber: event.blockNumber,
      }));

      console.log(
        `📊 Found ${entries.length} feedback entries for agentId ${agentId}`,
      );
      return entries;
    } catch (error) {
      // Suppress noisy RPC errors about block range or connection
      console.log(
        `   ⚠️ Could not fetch historic feedback (RPC limit or network). Using defaults.`,
      );
      return [];
    }
  }

  /**
   * Calculate reputation score from feedback entries
   *
   * Returns average score (0-100) or null if no feedback
   */
  async calculateReputationScore(agentId: bigint): Promise<number | null> {
    const entries = await this.getFeedbackEntries(agentId);

    if (entries.length === 0) {
      return null; // No feedback yet
    }

    const scores = entries.map((e) => e.score);
    const sum = scores.reduce((a, b) => a + b, 0);
    const average = sum / scores.length;

    console.log(`   Scores: [${scores.join(", ")}]`);
    console.log(`   Average: ${average.toFixed(2)}`);

    return average;
  }

  /**
   * Get repFactor for an address
   *
   * repFactor = averageScore / 100
   * Range: 0.0 to 1.0 (or higher if scores can exceed 100)
   *
   * Returns 1.0 for new agents with no feedback (neutral)
   */
  async getRepFactor(address: string): Promise<number> {
    console.log(`\n📜 Reading ERC-8004 reputation for ${address}`);

    // Get agentId from address
    const agentId = await this.getAgentId(address);

    if (!agentId) {
      console.log(`   No ERC-8004 identity - using default repFactor 1.0`);
      return 1.0; // New agent, neutral reputation
    }

    console.log(`   AgentId: ${agentId}`);

    // Calculate reputation score
    const score = await this.calculateReputationScore(agentId);

    if (score === null) {
      console.log(`   No feedback yet - using default repFactor 1.0`);
      return 1.0; // No feedback yet, neutral reputation
    }

    // repFactor = score / 100
    // Clamp between 0.1 (minimum) and 3.0 (maximum)
    const repFactor = Math.max(0.1, Math.min(3.0, score / 100));
    console.log(`   repFactor: ${repFactor.toFixed(3)}`);

    return repFactor;
  }

  /**
   * Get repFactor directly by agentId (when agentId is known from subscription request)
   */
  async getRepFactorByAgentId(agentId: string | number): Promise<number> {
    const agentIdBigInt = BigInt(agentId);
    console.log(
      `\n📜 Reading ERC-8004 reputation for agentId ${agentIdBigInt}`,
    );

    if (agentIdBigInt === 0n) {
      console.log(`   AgentId is 0 - using default repFactor 1.0`);
      return 1.0;
    }

    // Calculate reputation score from feedback
    const score = await this.calculateReputationScore(agentIdBigInt);

    if (score === null) {
      console.log(`   No feedback yet - using default repFactor 1.0`);
      return 1.0;
    }

    // repFactor = score / 100, clamped between 0.1 and 3.0
    const repFactor = Math.max(0.1, Math.min(3.0, score / 100));
    console.log(`   repFactor: ${repFactor.toFixed(3)}`);

    return repFactor;
  }
}

// Global instance (lazy initialized)
let reputationReader: ERC8004ReputationReader | null = null;

/**
 * Get or create the global reputation reader
 */
export function getReputationReader(
  provider: Provider,
): ERC8004ReputationReader {
  if (!reputationReader) {
    reputationReader = new ERC8004ReputationReader(provider);
  }
  return reputationReader;
}

/**
 * Calculate reputation factor from ERC-8004 registry
 *
 * This is the main function called by the clearing agent
 */
export async function readERC8004(
  address: string,
  provider: Provider,
): Promise<ReputationInputs | null> {
  const reader = getReputationReader(provider);

  // Get agentId
  const agentId = await reader.getAgentId(address);

  if (!agentId) {
    // No ERC-8004 identity - return default inputs
    return {
      agentId: address,
      totalCompleted: 0,
      totalFailed: 0,
      accountAgeDays: 0,
      slashCount: 0,
    };
  }

  // Get feedback entries
  const entries = await reader.getFeedbackEntries(agentId);

  // Calculate stats from feedback
  const totalCompleted = entries.filter((e) => e.score >= 50).length;
  const totalFailed = entries.filter((e) => e.score < 50).length;

  return {
    agentId: agentId.toString(),
    totalCompleted,
    totalFailed,
    accountAgeDays: 0, // TODO: Get from identity registry
    slashCount: 0, // TODO: Track from our own slashing events
  };
}

/**
 * Calculate repFactor from reputation inputs
 *
 * This provides a fallback calculation if ERC-8004 data is incomplete
 */
export function calculateRepFactor(inputs: ReputationInputs): ReputationResult {
  let factor = 1.0;

  const breakdown = {
    base: 1.0,
    completionBonus: 0,
    ageBonus: 0,
    slashPenalty: 0,
  };

  // Completion rate bonus
  const totalJobs = inputs.totalCompleted + inputs.totalFailed;
  if (totalJobs > 0) {
    const completionRate = inputs.totalCompleted / totalJobs;

    if (completionRate >= 0.99) {
      breakdown.completionBonus = 1.0;
    } else if (completionRate >= 0.95) {
      breakdown.completionBonus = 0.5;
    } else if (completionRate >= 0.9) {
      breakdown.completionBonus = 0.25;
    }
  }

  // Account age bonus
  if (inputs.accountAgeDays >= 180) {
    breakdown.ageBonus = 0.5;
  } else if (inputs.accountAgeDays >= 90) {
    breakdown.ageBonus = 0.25;
  }

  // Slash penalty
  breakdown.slashPenalty = Math.min(inputs.slashCount * 0.25, 1.0);

  // Calculate final factor
  factor =
    breakdown.base +
    breakdown.completionBonus +
    breakdown.ageBonus -
    breakdown.slashPenalty;

  // Clamp between 0.1 and 3.0
  factor = Math.max(0.1, Math.min(3.0, factor));

  return { factor, breakdown };
}

/**
 * Calculate credit limit from stake and reputation
 */
export function calculateCreditLimit(stake: bigint, repFactor: number): bigint {
  // creditLimit = stake × repFactor
  // Multiply by 1000, then divide by 1000 to handle decimals
  const factorScaled = BigInt(Math.floor(repFactor * 1000));
  return (stake * factorScaled) / 1000n;
}
