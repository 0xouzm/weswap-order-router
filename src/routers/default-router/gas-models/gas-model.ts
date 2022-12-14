import { Token } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';

import { PoolAccessor } from '../../../providers/pool-provider';
import { TokenProvider } from '../../../providers/token-provider';
import { CurrencyAmount } from '../../../util/amounts';
import { RouteWithValidQuote } from '../entities';

export type GasModel = {
  estimateGasCostInTermsOfToken(
    routeWithValidQuote: RouteWithValidQuote
  ): CurrencyAmount;
};

export abstract class GasModelFactory {
  public buildGasModel(
    chainId: number,
    gasPriceWei: BigNumber,
    tokenProvider: TokenProvider,
    poolProvider: PoolAccessor,
    inTermsOfToken: Token
  ) {
    return this._buildGasModel(
      chainId,
      gasPriceWei,
      tokenProvider,
      poolProvider,
      inTermsOfToken
    );
  }

  protected abstract _buildGasModel(
    chainId: number,
    gasPriceWei: BigNumber,
    tokenProvider: TokenProvider,
    poolProvider: PoolAccessor,
    token: Token
  ): GasModel;
}
