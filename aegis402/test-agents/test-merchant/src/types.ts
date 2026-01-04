export interface MerchantConfig {
  walletPrivateKey: string;
  aegisUrl: string;
  facilitatorUrl: string;
  skills: string[];
  stakeAmount: string;
  port: number;
  agentId: string;
}

export interface SubscribeResponse {
  success: boolean;
  creditLimit: string;
  message: string;
  error?: string;
}

export interface SettleResponse {
  success: boolean;
  amount: string;
  message: string;
  error?: string;
}
