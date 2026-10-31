// Test helpers: real ABI encodings of the provider calls Kyro decodes (verify.ts).
import { encodeAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { LIFI_ABI, LIFI_FEE_FORWARDER, LIFI_FEE_FORWARDER_ABI, NATIVE_EVM, ZERO_ADDRESS, ZEROX_ABI, isNative } from '../src';

export const SETTLER = '0x7f6ceE965959295cC64d0E6c00d99d6532d8e86b';

/** AllowanceHolder.exec(settler, token, amount, settler, Settler.execute(slippage, actions, zid)). */
export function zeroExData(o: { sellToken: string; sellAmount: bigint; recipient: string; buyToken: string; minAmountOut: bigint; feeRecipient?: string; settler?: string; operator?: string }): Hex {
  const settler = o.settler ?? SETTLER;
  // A fee transfer action carries the recipient (the exact action encoding does not matter to Kyro).
  const action = o.feeRecipient ? encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [o.sellToken === NATIVE_EVM ? ZERO_ADDRESS : (o.sellToken as Hex), o.feeRecipient as Hex, 70n]) : '0x';
  const inner = encodeFunctionData({ abi: ZEROX_ABI, functionName: 'execute', args: [{ recipient: o.recipient as Hex, buyToken: o.buyToken as Hex, minAmountOut: o.minAmountOut }, ['0x12345678' as Hex, ('0xc1fb425e' + action.slice(2)) as Hex], ('0x' + '00'.repeat(32)) as Hex] });
  return encodeFunctionData({ abi: ZEROX_ABI, functionName: 'exec', args: [(o.operator ?? settler) as Hex, (isNative(o.sellToken) ? ZERO_ADDRESS : o.sellToken) as Hex, o.sellAmount, settler as Hex, inner] });
}

/** LI.FI swapTokensMultipleV3* with a FeeForwarder step then a DEX step. */
export function lifiData(o: { sellToken: string; buyToken: string; sellAmount: bigint; receiver: string; minAmountOut: bigint; fees?: Array<{ recipient: string; amount: bigint }>; forwarder?: string }): Hex {
  const sell = (isNative(o.sellToken) ? ZERO_ADDRESS : o.sellToken) as Hex;
  const buy = (isNative(o.buyToken) ? ZERO_ADDRESS : o.buyToken) as Hex;
  const fees = (o.fees ?? []).map((f) => ({ recipient: f.recipient as Hex, amount: f.amount }));
  const total = fees.reduce((s, f) => s + f.amount, 0n);
  const feeCall = isNative(o.sellToken) ? encodeFunctionData({ abi: LIFI_FEE_FORWARDER_ABI, functionName: 'forwardNativeFees', args: [fees] }) : encodeFunctionData({ abi: LIFI_FEE_FORWARDER_ABI, functionName: 'forwardERC20Fees', args: [sell, fees] });
  const forwarder = (o.forwarder ?? LIFI_FEE_FORWARDER) as Hex;
  const dex = '0x57f96440f1b1cAD53B40A8924BD540b1279A491c' as Hex;
  const steps = [
    ...(fees.length ? [{ callTo: forwarder, approveTo: forwarder, sendingAssetId: sell, receivingAssetId: sell, fromAmount: o.sellAmount, callData: feeCall, requiresDeposit: true }] : []),
    { callTo: dex, approveTo: dex, sendingAssetId: sell, receivingAssetId: buy, fromAmount: fees.length ? o.sellAmount - total : o.sellAmount, callData: '0x3f0bde25' as Hex, requiresDeposit: !fees.length },
  ];
  const fn = isNative(o.sellToken) ? 'swapTokensMultipleV3NativeToERC20' : isNative(o.buyToken) ? 'swapTokensMultipleV3ERC20ToNative' : 'swapTokensMultipleV3ERC20ToERC20';
  return encodeFunctionData({ abi: LIFI_ABI, functionName: fn, args: [('0x' + '11'.repeat(32)) as Hex, 'lifi-api', ZERO_ADDRESS, o.receiver as Hex, o.minAmountOut, steps] });
}
