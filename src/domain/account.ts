export interface AccountState {
  walletBalance: number;
  availableBalance: number;
  positions: FuturesPosition[];
  updateTime: number;
}

export interface FuturesPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice?: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  updateTime: number;
}
