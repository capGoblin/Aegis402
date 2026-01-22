//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Production Facilitator Client for real payment processing
 */

import {
  FacilitatorClient,
  FacilitatorConfig,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "a2a-x402";

export class ProductionFacilitatorClient implements FacilitatorClient {
  private config: FacilitatorConfig;

  constructor(config: FacilitatorConfig) {
    this.config = config;
    console.log(`📡 Production Facilitator Client initialized: ${config.url}`);
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    console.log("--- PRODUCTION FACILITATOR: VERIFY ---");
    console.log(`Calling facilitator at: ${this.config.url}/verify`);

    try {
      const paymentHeader = Buffer.from(JSON.stringify(payload)).toString(
        "base64",
      );

      const requestBody = {
        x402Version: payload.x402Version,
        paymentHeader: paymentHeader,
        paymentRequirements: requirements,
      };

      const bodyStr = JSON.stringify(requestBody);
      console.log("Request body:", bodyStr);

      const response = await fetch(`${this.config.url}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
          "X402-Version": "1",
          ...(this.config.apiKey && {
            Authorization: `Bearer ${this.config.apiKey}`,
          }),
        },
        body: bodyStr,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Facilitator verify failed: ${response.status}`);
        console.error(`   Body: ${errorText}`);
        return {
          isValid: false,
          invalidReason: `HTTP ${response.status}: ${response.statusText} - ${errorText}`,
        };
      }

      const result = (await response.json()) as any;
      console.log(`✅ Verification result:`, result);

      const payer =
        result.payer ||
        (payload.payload as any).from ||
        (payload.payload as any).authorization?.from;

      return {
        isValid: result.is_valid || result.isValid || false,
        payer: payer,
        invalidReason: result.invalid_reason || result.invalidReason,
      };
    } catch (error) {
      console.error("❌ Facilitator verify error:", error);
      return {
        isValid: false,
        invalidReason: `Network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    console.log("--- PRODUCTION FACILITATOR: SETTLE ---");
    console.log(`Calling facilitator at: ${this.config.url}/settle`);

    try {
      const paymentHeader = Buffer.from(JSON.stringify(payload)).toString(
        "base64",
      );

      const requestBody = {
        x402Version: payload.x402Version,
        paymentHeader: paymentHeader,
        paymentRequirements: requirements,
      };

      const bodyStr = JSON.stringify(requestBody);
      console.log("Request body:", bodyStr);

      const response = await fetch(`${this.config.url}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
          "X402-Version": "1",
          ...(this.config.apiKey && {
            Authorization: `Bearer ${this.config.apiKey}`,
          }),
        },
        body: bodyStr,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Facilitator settle failed: ${response.status}`);
        console.error(`   Body: ${errorText}`);
        return {
          success: false,
          network: requirements.network,
          errorReason: `HTTP ${response.status}: ${response.statusText} - ${errorText}`,
        };
      }

      const result = (await response.json()) as any;
      console.log(`✅ Settlement result:`, result);

      const isSuccess = result.event === "payment.settled";

      return {
        success: isSuccess,
        transaction:
          result.txHash || result.transaction || result.transactionHash,
        network: result.network || requirements.network,
        payer: result.from || result.payer,
        errorReason: isSuccess
          ? undefined
          : result.error || result.errorReason || "Unknown error",
      };
    } catch (error) {
      console.error("❌ Facilitator settle error:", error);
      return {
        success: false,
        network: requirements.network,
        errorReason: `Network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
