import type { OrderSide } from "./order";

export type OrderIntent =
  | {
      type: "PLACE_LIMIT";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      price: number;
      quantity: number;
      postOnly: boolean;
      reduceOnly: boolean;
    }
  | {
      type: "PLACE_MARKET";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      quantity: number;
      reduceOnly: boolean;
      reason: string;
    }
  | {
      type: "PLACE_STOP";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      stopPrice: number;
      quantity: number;
      reduceOnly: true;
    }
  | {
      type: "PLACE_TRAILING_STOP";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      activationPrice: number;
      callbackRate: number;
      quantity: number;
      reduceOnly: true;
    }
  | {
      type: "CANCEL";
      strategyId: string;
      orderIds: string[];
    }
  | {
      type: "CANCEL_OWNED";
      strategyId: string;
      symbol: string;
    };
