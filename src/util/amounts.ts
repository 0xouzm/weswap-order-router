import { CurrencyAmount as CurrencyAmountRaw, Token } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';
import { parseUnits } from 'ethers/lib/utils';
import JSBI from 'jsbi';

export class CurrencyAmount extends CurrencyAmountRaw<Token> {}

export function parseAmount(value: string, currency: Token): CurrencyAmount {
  const typedValueParsed = parseUnits(value, currency.decimals).toString();
  return CurrencyAmount.fromRawAmount(currency, JSBI.BigInt(typedValueParsed));
}

export function parseFeeAmount(feeAmountStr: string){
  switch (feeAmountStr) {
    case '10000':
      return FeeAmount.HIGH;
    case '3000':
      return FeeAmount.MEDIUM;
    case '500':
      return FeeAmount.LOW;
    case '100':
      return 100;
    default:
      throw new Error(`Fee amount ${feeAmountStr} not supported.`);
  }
}
