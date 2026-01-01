/**
 * Wrapped Agent with x402 Exception Handling
 *
 * Intercepts x402PaymentRequiredException at the tool level
 * (Same pattern as a2a-x402-typescript/merchant-agent/wrapped-agent.ts)
 */

import { testMerchantAgent } from "./agent";
import { x402PaymentRequiredException } from "a2a-x402";

// Store the last payment exception
export let lastPaymentException: x402PaymentRequiredException | null = null;

// Flag to indicate payment has been verified
export let paymentVerified: boolean = false;

// Wrap each tool function to catch x402 exceptions
const originalTools = testMerchantAgent.tools;
const wrappedTools = originalTools.map((tool: any) => {
  if (typeof tool === "function") {
    const wrappedTool = async function (params: any, context: any) {
      try {
        return await tool(params, context);
      } catch (error) {
        if (error instanceof x402PaymentRequiredException) {
          // If payment was already verified, fulfill instead of throwing
          if (paymentVerified) {
            console.log("🎯 Payment already verified - fulfilling service");
            return `Service completed! Thank you for your payment! 🎉`;
          }
          console.log("🎯 Caught x402PaymentRequiredException in tool wrapper");
          lastPaymentException = error;
          return "";
        }
        throw error;
      }
    };
    Object.defineProperty(wrappedTool, "name", { value: tool.name });
    return wrappedTool;
  }
  return tool;
});

testMerchantAgent.tools = wrappedTools as any;

export const wrappedTestMerchantAgent = testMerchantAgent;

export function clearLastPaymentException() {
  lastPaymentException = null;
}

export function setPaymentVerified(verified: boolean) {
  paymentVerified = verified;
  console.log(`💳 Payment verified flag: ${verified}`);
}
