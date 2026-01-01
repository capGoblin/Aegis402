# Aegis402 Test Agents

Test agents for end-to-end testing of the Aegis402 credit clearinghouse.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Test Client   │────►│    Aegis402     │◄────│  Test Merchant  │
│   (port 10003)  │     │  (port 10001)   │     │   (port 10002)  │
└────────┬────────┘     └─────────────────┘     └────────┬────────┘
         │                                               │
         └──────────────────────────────────────────────►│
                      (x402 payment)
```

## Quick Start

### 1. Start Aegis402

```bash
cd /path/to/aegis402
cp .env.example .env
# Add your PRIVATE_KEY
npm run dev
# Running on http://localhost:10001
```

### 2. Start Test Merchant

```bash
cd test-agents/test-merchant
cp .env.example .env
# Add MERCHANT_WALLET_ADDRESS and MERCHANT_PRIVATE_KEY
npm install
npm run dev
# Running on http://localhost:10002
```

### 3. Start Test Client

```bash
cd test-agents/test-client
cp .env.example .env
# Add WALLET_PRIVATE_KEY
npm install
npm run dev
# Running on http://localhost:10003
```

## Test Flow

### 1. Merchant Subscribes

```bash
curl -X POST http://localhost:10002 \
  -H "Content-Type: application/json" \
  -d '{"text": "subscribe to aegis402"}'
```

### 2. Client Finds Merchants

```bash
curl -X POST http://localhost:10003 \
  -H "Content-Type: application/json" \
  -d '{"text": "find merchants for data-analysis"}'
```

### 3. Client Requests Service

```bash
curl -X POST http://localhost:10003 \
  -H "Content-Type: application/json" \
  -d '{"text": "request data-analysis"}'
```

### 4. Client Confirms Payment

```bash
curl -X POST http://localhost:10003 \
  -H "Content-Type: application/json" \
  -d '{"text": "confirm payment"}'
```

### 5. Merchant Settles

```bash
curl -X POST http://localhost:10002 \
  -H "Content-Type: application/json" \
  -d '{"text": "settle transaction 0x..."}'
```

## Test Slashing

If merchant doesn't deliver after deadline:

```bash
curl -X POST http://localhost:10003 \
  -H "Content-Type: application/json" \
  -d '{"text": "slash 0x..."}'
```

## Ports

| Service       | Port  |
| ------------- | ----- |
| Aegis402      | 10001 |
| Test Merchant | 10002 |
| Test Client   | 10003 |
