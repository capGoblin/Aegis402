import { ethers, Wallet } from "ethers";
import { processPayment } from "a2a-x402";
import { ProductionFacilitatorClient } from "../../../src/facilitator";
import { MerchantConfig, SubscribeResponse, SettleResponse } from "./types";

export class MerchantAgent {
  private config: MerchantConfig;
  private wallet: Wallet;
  private facilitator: ProductionFacilitatorClient;
  private isSubscribed: boolean = false;
  private creditLimit: string = "0";

  constructor(config: MerchantConfig) {
    this.config = config;
    this.wallet = new Wallet(config.walletPrivateKey);
    this.facilitator = new ProductionFacilitatorClient({
      url: config.facilitatorUrl,
    });
    console.log(`💼 Merchant Agent initialized for: ${this.wallet.address}`);
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  getConfig(): MerchantConfig {
    return this.config;
  }

  getStatus() {
    return {
      isSubscribed: this.isSubscribed,
      creditLimit: this.creditLimit,
      address: this.wallet.address,
      skills: this.config.skills,
    };
  }

  async subscribe(): Promise<SubscribeResponse> {
    console.log(`\n🔔 Subscribing to Aegis402 at ${this.config.aegisUrl}...`);

    const subscribeRequest = {
      x402Endpoint: `http://localhost:${this.config.port}`,
      skills: this.config.skills,
      agentId: this.config.agentId,
      stakeAmount: this.config.stakeAmount,
    };

    try {
      // 1. Initial request to get payment requirements
      const response = await fetch(`${this.config.aegisUrl}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscribeRequest),
      });

      if (response.status === 402) {
        const paymentReqs = (await response.json()) as any;
        const option = paymentReqs.accepts[0];

        console.log(
          `💰 Stake payment required: ${ethers.formatUnits(
            option.maxAmountRequired,
            6
          )} USDC`
        );
        console.log("🔐 Signing stake payment...");

        const signedPayload = await processPayment(option, this.wallet as any);

        console.log("📤 Submitting signed subscription...");

        const paidResponse = await fetch(`${this.config.aegisUrl}/subscribe`, {
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
          this.isSubscribed = true;
          this.creditLimit = result.creditLimit;
          return {
            success: true,
            creditLimit: result.creditLimit,
            message: result.message,
          };
        } else {
          return {
            success: false,
            creditLimit: "0",
            message: result.error || "Subscription failed",
          };
        }
      }

      const result = (await response.json()) as any;
      if (result.success) {
        this.isSubscribed = true;
        this.creditLimit = result.creditLimit;
        return {
          success: true,
          creditLimit: result.creditLimit,
          message: "Already subscribed or success",
        };
      }

      return {
        success: false,
        creditLimit: "0",
        message: result.error || "Unknown error",
      };
    } catch (error) {
      console.error("❌ Subscription error:", error);
      return {
        success: false,
        creditLimit: "0",
        message: error instanceof Error ? error.message : "Network error",
      };
    }
  }

  async settleTask(txHash: string): Promise<SettleResponse> {
    console.log(`⚖️ Settling task with tx: ${txHash}`);

    try {
      const response = await fetch(`${this.config.aegisUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      });

      const result = (await response.json()) as any;
      return {
        success: result.success,
        amount: result.amount || "0",
        message: result.message || (result.success ? "Settled" : "Failed"),
      };
    } catch (error) {
      console.error("❌ Settlement error:", error);
      return {
        success: false,
        amount: "0",
        message: error instanceof Error ? error.message : "Network error",
      };
    }
  }

  async verifyAndSettlePayment(paymentPayload: any, requirements: any) {
    console.log("💰 Verifying payment via facilitator...");

    const verifyResult = await this.facilitator.verify(
      paymentPayload,
      requirements
    );
    if (!verifyResult.isValid) {
      throw new Error(
        `Payment verification failed: ${verifyResult.invalidReason}`
      );
    }

    console.log(`✅ Payment verified from: ${verifyResult.payer}. Settling...`);
    const settleResult = await this.facilitator.settle(
      paymentPayload,
      requirements
    );

    if (!settleResult.success) {
      throw new Error(`Payment settlement failed: ${settleResult.errorReason}`);
    }

    return settleResult;
  }
}
