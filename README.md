# Aegis402

**Aegis402** lets agents pay each other via x402 and get refunded if the service agent fails, with refunds guaranteed by collateral and ERC-8004 reputation based credit limits. 
It's a Capital-Backed Credit Layer for x402 Agent Payments. 

It turns x402 from:

> “pay and hope they deliver”

into:

> **“pay and get guaranteed delivery by collateral and credit.”**

Built for the **x402 Hackathon**

---

## Links

**Demo Video (YouTube)**  
https://youtu.be/pF3e4f9k9KM  

**Contract Address Interacted in Video**  
https://sepolia.basescan.org/address/0x9596670c5ce338c930d87949d4b2d1f86a68c83e  

**Transactions Shown in Video**  
https://sepolia.basescan.org/tx/0x9087cb2cfc569c895fe6a59cdfa9afc612bd0604becfad521a011d957249896e  
https://sepolia.basescan.org/tx/0x080d77f1c55b61328cf1587de0a5877947cc9e1239771b1dfa65da7b1eaed75f  

---

## What is Aegis402?

x402 lets agents charge before serving APIs.  
ERC-8004 lets agents publish identity and reputation.

But neither protects clients if a service agent takes money and disappears, especially for async or high-value jobs.

Aegis402 adds **capital-backed trust**.

Service agents stake once.  
We compute a credit limit from:

```
creditLimit = stake × ERC-8004 reputation
```

This credit limit is the **maximum value of jobs the agent can be paid for at once**.

---

## How it works

1. A service agent deposits stake into Aegis402.
2. Aegis402 calculates their credit limit from stake and ERC-8004 reputation.
3. Clients query Aegis402 for agents whose credit is large enough for a job.
4. Clients pay the chosen agent directly via x402.
5. Aegis402 tracks outstanding exposure and deadlines.
6. If the agent completes the job, their capital unlocks and they keep earning.
7. If the agent fails or disappears, their stake is slashed to compensate the client.

No escrow.  
No custody.  
Just economic guarantees.

---

## Why this matters

Reputation tells you **who** an agent is.  
Capital tells you **how much they can be trusted with**.

History does not refund lost money.  
Identity does not stop rugging.

Aegis402 introduces **solvency** to the agent economy.

Good agents get leverage.  
Bad agents get liquidated.

---

## Architecture

Aegis402 is composed of:

- **CreditManager (on-chain)**  
  Holds agent stake, computes credit limits, tracks exposure, and performs slashing.

- **ERC-8004**  
  Provides identity and reputation for each agent.

- **x402**  
  Handles payments from clients to service agents.

---

## What x402 becomes with Aegis402

Without Aegis402:

> pay → hope → pray  

With Aegis402:

> pay → collateral → credit → guaranteed delivery  

This unlocks real, high-value, async machine-to-machine commerce.

---

## Vision

Machines are about to start trading with machines.

Aegis402 is the **credit layer** that makes it safe.

This is how real money flows in the agent economy ⚡
