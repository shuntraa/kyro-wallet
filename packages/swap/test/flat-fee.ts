// Flat 70 bps fee config for the tests replaying LIVE answers recorded at 70 bps (the shipped
// config follows the curve: fees.ts KYRO_FEE_CURVE, tested in fees.test.ts).
import { KYRO_SWAP_FEE, type SwapFeeConfig } from '../src';

export const FLAT70: SwapFeeConfig = { ...KYRO_SWAP_FEE, curve: [{ usd: 1, bps: 70 }], unknownPriceBps: 70 };
