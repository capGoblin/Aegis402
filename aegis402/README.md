# Aegis402

**Credit Clearinghouse Agent for x402 Agent Payments**

> Financial infrastructure for AI agents ⚡  
> Identity → Credit → Payment → Exposure → Settlement → Slashing

## Overview

Aegis402 is an autonomous protocol agent that acts as a credit and risk clearinghouse for agent-to-agent payments on x402. It converts ERC-8004 identity into financial trust using collateral.

**Core Formula:**

```
creditLimit = stake × repFactor(ERC-8004)
```

## API Endpoints

| Endpoint          | x402 Payment | Purpose                       |
| ----------------- | ------------ | ----------------------------- |
| `POST /subscribe` | ✅ Stake     | Merchant onboarding           |
| `POST /quote`     | ❌ Free      | Discovery                     |
| `POST /settle`    | ❌ Free      | Release exposure              |
| `POST /slash`     | ✅ Bond      | Slash non-delivering merchant |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment
cp .env.example .env
# Edit .env with your private key

# Start server
npm run dev
```

## Configuration

| Variable                 | Description                     | Default                |
| ------------------------ | ------------------------------- | ---------------------- |
| `PRIVATE_KEY`            | Aegis agent wallet (eigenAgent) | Required               |
| `CREDIT_MANAGER_ADDRESS` | Deployed contract               | `0x9fA96...`           |
| `PORT`                   | Server port                     | `10001`                |
| `MIN_STAKE_AMOUNT`       | Minimum stake (atomic)          | `100000000` (100 USDC) |
| `SLASH_BOND_AMOUNT`      | Slash bond (atomic)             | `10000000` (10 USDC)   |

## Flow

### 1. Merchant Subscribes

```
POST /subscribe → 402 (requires stake) → Pay stake → Subscribed
```

### 2. Client Discovers

```
POST /quote { skill, price } → Ranked merchants with capacity
```

### 3. Payment Tracking

Chain watcher detects USDC transfers → `recordPayment()` → Creates deadline

### 4. Settlement

```
POST /settle { txHash } → clearExposure() → Done
```

### 5. Slashing

```
POST /slash { txHash } → 402 (requires bond) → Pay bond → slash() → Client refunded
```

## Contract

Deployed on Base Sepolia: `0x9fA96fE9374F351538A051194b54D93350A48FBE`
