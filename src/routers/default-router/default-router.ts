import { Fraction, Token } from '@uniswap/sdk-core';
import { FeeAmount, Pool } from '@uniswap/v3-sdk';
import Logger from 'bunyan';
import _ from 'lodash';

import { GasPriceProvider } from '../../providers/gas-price-provider';
import { Multicall2Provider } from '../../providers/multicall2-provider';
import { PoolAccessor, PoolProvider } from '../../providers/pool-provider';
import { QuoteProvider, RouteWithQuotes } from '../../providers/quote-provider';
import {
  printSubgraphPool,
  SubgraphPool,
  SubgraphProvider,
} from '../../providers/subgraph-provider';
import { TokenProvider } from '../../providers/token-provider';
import { CurrencyAmount, parseFeeAmount } from '../../util/amounts';
import { ChainId } from '../../util/chains';
import { routeToString } from '../../util/routes';
import {
  IRouter,
  Route,
  RouteAmount,
  RouteType,
  SwapRoute,
  SwapRoutes,
} from '../router';

import { RouteWithValidQuote } from './entities';
import { GasModel, GasModelFactory } from './gas-models/gas-model';

export type DefaultRouterParams = {
  chainId: ChainId;
  multicall2Provider: Multicall2Provider;
  subgraphProvider: SubgraphProvider;
  poolProvider: PoolProvider;
  quoteProvider: QuoteProvider;
  tokenProvider: TokenProvider;
  gasPriceProvider: GasPriceProvider;
  gasModelFactory: GasModelFactory;
  log: Logger;
};

const TOP_N = 10;
// Max swaps in a path.
const MAX_SWAPS = 3;
const MAX_SPLITS = 3;
const DISTRIBUTION_PERCENT = 5;

export class DefaultRouter implements IRouter {
  protected log: Logger;
  protected chainId: ChainId;
  protected multicall2Provider: Multicall2Provider;
  protected subgraphProvider: SubgraphProvider;
  protected poolProvider: PoolProvider;
  protected quoteProvider: QuoteProvider;
  protected tokenProvider: TokenProvider;
  protected gasPriceProvider: GasPriceProvider;
  protected gasModelFactory: GasModelFactory;

  constructor({
    chainId,
    multicall2Provider,
    subgraphProvider,
    poolProvider,
    quoteProvider,
    tokenProvider,
    gasPriceProvider,
    gasModelFactory,
    log,
  }: DefaultRouterParams) {
    this.chainId = chainId;
    this.multicall2Provider = multicall2Provider;
    this.subgraphProvider = subgraphProvider;
    this.poolProvider = poolProvider;
    this.quoteProvider = quoteProvider;
    this.tokenProvider = tokenProvider;
    this.gasPriceProvider = gasPriceProvider;
    this.gasModelFactory = gasModelFactory;
    this.log = log;
  }

  public async routeExactIn(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: CurrencyAmount
  ): Promise<SwapRoutes | null> {
    const poolAccessor = await this.getPoolsToConsider(
      tokenIn,
      tokenOut,
      RouteType.EXACT_IN
    );
    const pools = poolAccessor.getAllPools();

    const { gasPriceWei } = await this.gasPriceProvider.getGasPrice();
    const gasModel = this.gasModelFactory.buildGasModel(
      this.chainId,
      gasPriceWei,
      this.tokenProvider,
      poolAccessor,
      tokenOut
    );

    const routes = this.computeAllRoutes(tokenIn, tokenOut, pools, MAX_SWAPS);

    const [percents, amounts] = this.getAmountDistribution(amountIn);

    const routeWithQuotes = await this.quoteProvider.getQuotesManyExactIn(
      amounts,
      routes
    );

    const swapRoute = this.getBestSwapRoute(
      percents,
      routeWithQuotes,
      tokenOut,
      RouteType.EXACT_IN,
      gasModel
    );

    return swapRoute;
  }

  routeExactOut(
    tokenIn: Token,
    tokenOut: Token,
    amountIn: CurrencyAmount
  ): Promise<SwapRoutes | null> {
    return Promise.resolve(undefined) as any;
  }

  private async getPoolsToConsider(
    tokenIn: Token,
    tokenOut: Token,
    routeType: RouteType
  ): Promise<PoolAccessor> {
    const allPools = await this.subgraphProvider.getPools();

    // Only consider pools where both tokens are in the token list.
    const tokenListPools = _.filter(allPools, (pool) => {
      return (
        this.tokenProvider.tokenExists(this.chainId, pool.token0.symbol) &&
        this.tokenProvider.tokenExists(this.chainId, pool.token1.symbol)
      );
    });

    // find direct pools from token list pools

    const directSwapPool = _.find(tokenListPools, (tokenListPool) => {
      return (
        (tokenListPool.token0.symbol == tokenIn.symbol &&
          tokenListPool.token1.symbol == tokenOut.symbol) ||
        (tokenListPool.token1.symbol == tokenIn.symbol &&
          tokenListPool.token0.symbol == tokenOut.symbol)
      );
    });
    const ethPool = _.find(tokenListPools, (tokenListPool) => {
      if (routeType == RouteType.EXACT_IN) {
        return (
          (tokenListPool.token0.symbol == 'WETH' &&
            tokenListPool.token1.symbol == tokenOut.symbol) ||
          (tokenListPool.token1.symbol == tokenOut.symbol &&
            tokenListPool.token0.symbol == 'WETH')
        );
      } else {
        return (
          (tokenListPool.token0.symbol == 'WETH' &&
            tokenListPool.token1.symbol == tokenIn.symbol) ||
          (tokenListPool.token1.symbol == tokenIn.symbol &&
            tokenListPool.token0.symbol == 'WETH')
        );
      }
    });

    const topByTVL = _(tokenListPools)
      .sortBy((tokenListPool) => {
        -tokenListPool.totalValueLockedETH;
      })
      .slice(0, TOP_N)
      .value();

    const topByTVLUsingTokenIn = _(tokenListPools)
      .filter((tokenListPool) => {
        return (
          tokenListPool.token0.symbol == tokenIn.symbol ||
          tokenListPool.token1.symbol == tokenIn.symbol
        );
      })
      .sortBy((tokenListPool) => {
        -tokenListPool.totalValueLockedETH;
      })
      .slice(0, TOP_N)
      .value();

    const topByTVLUsingTokenOut = _(tokenListPools)
      .filter((tokenListPool) => {
        return (
          tokenListPool.token0.symbol == tokenOut.symbol ||
          tokenListPool.token1.symbol == tokenOut.symbol
        );
      })
      .sortBy((tokenListPool) => -tokenListPool.totalValueLockedETH)
      .slice(0, TOP_N)
      .value();

    this.log.debug(
      {
        topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printSubgraphPool),
        topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(printSubgraphPool),
        topByTVL: topByTVL.map(printSubgraphPool),
        directSwap: directSwapPool
          ? printSubgraphPool(directSwapPool)
          : undefined,
        ethPool: ethPool ? printSubgraphPool(ethPool) : undefined,
      },
      `Pools for consideration using top ${TOP_N}`
    );

    const subgraphPools = _([
      directSwapPool,
      ethPool,
      ...topByTVL,
      ...topByTVLUsingTokenIn,
      ...topByTVLUsingTokenOut,
    ])
      .compact()
      .uniqBy((pool) => pool.id)
      .value();

    const tokenPairs = _.map<SubgraphPool, [Token, Token, FeeAmount]>(
      subgraphPools,
      (subgraphPool) => {
        const tokenA = this.tokenProvider.getToken(
          this.chainId,
          subgraphPool.token0.symbol
        );
        const tokenB = this.tokenProvider.getToken(
          this.chainId,
          subgraphPool.token1.symbol
        );
        const fee = parseFeeAmount(subgraphPool.feeTier);

        return [tokenA, tokenB, fee];
      }
    );

    const poolAccessor = await this.poolProvider.getPools(tokenPairs);

    return poolAccessor;
  }

  private computeAllRoutes(
    tokenIn: Token,
    tokenOut: Token,
    pools: Pool[],
    maxHops: number
  ): Route[] {
    const poolsUsed = Array<boolean>(pools.length).fill(false);
    const routes: Route[] = [];

    const computeRoutes = (
      tokenIn: Token,
      tokenOut: Token,
      currentRoute: Pool[],
      poolsUsed: boolean[],
      _previousTokenOut?: Token
    ) => {
      if (currentRoute.length > maxHops) return;
      if (
        currentRoute.length > 0 &&
        currentRoute[currentRoute.length - 1]!.involvesToken(tokenOut)
      ) {
        routes.push(new Route([...currentRoute], tokenIn, tokenOut));
        return;
      }

      for (let i = 0; i < pools.length; i++) {
        if (poolsUsed[i]) {
          continue;
        }
        const curPool = pools[i]!;
        const previousTokenOut = _previousTokenOut
          ? _previousTokenOut
          : tokenIn;

        if (!curPool.involvesToken(previousTokenOut)) {
          continue;
        }

        const currentTokenOut = curPool.token0.equals(previousTokenOut)
          ? curPool.token1
          : curPool.token0;

        currentRoute.push(curPool);
        poolsUsed[i] = true;
        computeRoutes(
          tokenIn,
          tokenOut,
          currentRoute,
          poolsUsed,
          currentTokenOut
        );
        poolsUsed[i] = false;
        currentRoute.pop();
      }
    };

    computeRoutes(tokenIn, tokenOut, [], poolsUsed);

    this.log.debug(
      { routes: routes.map(routeToString) },
      `Computed ${routes.length} possible routes.`
    );

    return routes;
  }

  private getAmountDistribution(
    amount: CurrencyAmount
  ): [number[], CurrencyAmount[]] {
    const percents = [];
    const amounts = [];
    for (let i = 1; i <= 100 / DISTRIBUTION_PERCENT; i++) {
      percents.push(i * DISTRIBUTION_PERCENT);
      amounts.push(
        amount.multiply(new Fraction(i * DISTRIBUTION_PERCENT, 100))
      );
    }
    return [percents, amounts];
  }

  private getBestSwapRoute(
    percents: number[],
    routeWithQuotes: RouteWithQuotes[],
    quoteToken: Token,
    routeType: RouteType,
    gasModel: GasModel
  ): SwapRoutes | null {
    const percentToQuotes: { [percent: number]: RouteWithValidQuote[] } = {};
    for (const routeWithQuote of routeWithQuotes) {
      const [route, quotes] = routeWithQuote;

      for (let i = 0; i < quotes.length; i++) {
        const percent = percents[i]!;
        const amountQuote = quotes[i]!;
        const {
          quote,
          amount,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          gasEstimate,
        } = amountQuote;

        if (
          !quote ||
          !sqrtPriceX96AfterList ||
          !initializedTicksCrossedList ||
          !gasEstimate
        ) {
          this.log.debug(
            {
              route: routeToString(route),
              amount: amount.toFixed(2),
              amountQuote,
            },
            'Dropping a null quote for route.'
          );
          continue;
        }

        if (!percentToQuotes[percent]) {
          percentToQuotes[percent] = [];
        }

        const routeWithValidQuote = new RouteWithValidQuote({
          route,
          rawQuote: quote,
          amount,
          percent,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          gasEstimate,
          gasModel,
          quoteToken,
          log: this.log,
        });

        percentToQuotes[percent]!.push(routeWithValidQuote);
      }
    }
    const swapRoute = this.getBestSwapRouteBy(
      routeType,
      percentToQuotes,
      percents,
      (rq: RouteWithValidQuote) => rq.quote
    );

    if (!swapRoute) {
      return null;
    }

    const swapRouteGasAdjusted = this.getBestSwapRouteBy(
      routeType,
      percentToQuotes,
      percents,
      (rq: RouteWithValidQuote) => rq.quoteAdjustedForGas
    );

    return { raw: swapRoute, gasAdjusted: swapRouteGasAdjusted };
  }

  private getBestSwapRouteBy(
    routeType: RouteType,
    percentToQuotes: { [percent: number]: RouteWithValidQuote[] },
    percents: number[],
    by: (rq: RouteWithValidQuote) => CurrencyAmount
  ): SwapRoute | undefined {
    const percentToSortedQuotes = _.mapValues(
      percentToQuotes,
      (routeQuotes: RouteWithValidQuote[]) => {
        return routeQuotes.sort((a, b) => {
          if (routeType == RouteType.EXACT_IN) {
            return by(a).greaterThan(by(b)) ? -1 : 1;
          } else {
            return by(a).lessThan(by(b)) ? -1 : 1;
          }
        });
      }
    );

    this.log.debug({ percentToSortedQuotes }, 'Percentages to sorted quotes.');

    const findFirstRouteNotUsingUsedPools = (
      usedRoutes: Route[],
      candidateRouteQuotes: RouteWithValidQuote[]
    ): RouteWithValidQuote | null => {
      const getPoolAddress = (pool: Pool) =>
        Pool.getAddress(pool.token0, pool.token1, pool.fee);

      const poolAddressSet = new Set();
      const usedPoolAddresses = _(usedRoutes)
        .flatMap((r) => r.pools)
        .map(getPoolAddress)
        .value();
      for (const poolAddress of usedPoolAddresses) {
        poolAddressSet.add(poolAddress);
      }

      for (const routeQuote of candidateRouteQuotes) {
        const {
          route: { pools },
        } = routeQuote;
        if (pools.some((pool) => poolAddressSet.has(getPoolAddress(pool)))) {
          continue;
        }
        return routeQuote;
      }
      return null;
    };

    if (!percentToSortedQuotes[100]) {
      this.log.info(
        { percentToSortedQuotes },
        'Did not find a valid route without any splits.'
      );
      return undefined;
    }

    // Start with our first best swap as being the quote where we send 100% of token through a single route.
    let bestQuote = by(percentToSortedQuotes[100][0]!);
    let bestSwap: RouteWithValidQuote[] = [percentToSortedQuotes[100][0]!];

    const quoteCompFn =
      routeType == RouteType.EXACT_IN
        ? (a: CurrencyAmount, b: CurrencyAmount) => a.greaterThan(b)
        : (a: CurrencyAmount, b: CurrencyAmount) => a.lessThan(b);

    let splits = 2;

    while (splits <= MAX_SPLITS) {
      if (splits == 2) {
        for (let i = 0; i < Math.ceil(percents.length / 2); i++) {
          const percentA = percents[i]!;
          const routeWithQuoteA = percentToSortedQuotes[percentA]![0]!;

          const { route: routeA } = routeWithQuoteA;
          const quoteA = by(routeWithQuoteA);

          const percentB = 100 - percentA;
          const candidateQuotesB = percentToSortedQuotes[percentB]!;
          if (!candidateQuotesB) {
            continue;
          }
          const routeWithQuoteB = findFirstRouteNotUsingUsedPools(
            [routeA],
            candidateQuotesB
          );
          if (!routeWithQuoteB) {
            continue;
          }

          const newQuote = quoteA.add(by(routeWithQuoteB));
          if (quoteCompFn(newQuote, bestQuote)) {
            bestQuote = newQuote;
            bestSwap = [routeWithQuoteA, routeWithQuoteB];
          }
        }
      }
      if (splits == 3) {
        for (let i = 0; i < percents.length; i++) {
          const percentA = percents[i]!;
          const routeWithQuoteA = percentToSortedQuotes[percentA]![0]!;
          const { route: routeA } = routeWithQuoteA;
          const quoteA = by(routeWithQuoteA);

          const remainingPercent = 100 - percentA;

          for (let j = i + 1; j < percents.length; j++) {
            const percentB = percents[j]!;
            const candidateRoutesB = percentToSortedQuotes[percentB]!;

            const routeWithQuoteB = findFirstRouteNotUsingUsedPools(
              [routeA],
              candidateRoutesB
            );

            if (!routeWithQuoteB) {
              continue;
            }

            const { route: routeB } = routeWithQuoteB;
            const quoteB = by(routeWithQuoteB);
            const percentC = remainingPercent - percentB;

            const candidateRoutesC = percentToSortedQuotes[percentC]!;

            if (!candidateRoutesC) {
              continue;
            }

            const routeWithQuoteC = findFirstRouteNotUsingUsedPools(
              [routeA, routeB],
              candidateRoutesC
            );

            if (!routeWithQuoteC) {
              continue;
            }

            const quoteC = by(routeWithQuoteC);

            const newQuote = quoteA.add(quoteB).add(quoteC);

            if (quoteCompFn(newQuote, bestQuote)) {
              bestQuote = newQuote;
              bestSwap = [routeWithQuoteA, routeWithQuoteB, routeWithQuoteC];
            }
          }
        }
      }

      if (splits == 4) {
        throw new Error('Not implemented');
      }

      splits += 1;
    }

    const sum = (currencyAmounts: CurrencyAmount[]): CurrencyAmount => {
      let sum = currencyAmounts[0]!;
      for (let i = 1; i < currencyAmounts.length; i++) {
        sum = sum.add(currencyAmounts[i]!);
      }
      return sum;
    };

    const quoteGasAdjusted = sum(
      _.map(
        bestSwap,
        (routeWithValidQuote) => routeWithValidQuote.quoteAdjustedForGas
      )
    );

    const quote = sum(
      _.map(bestSwap, (routeWithValidQuote) => routeWithValidQuote.quote)
    );

    const routeAmounts = _.map<RouteWithValidQuote, RouteAmount>(
      bestSwap,
      (rq: RouteWithValidQuote) => {
        return {
          route: rq.route,
          amount: rq.quote,
          percentage: rq.percent,
        };
      }
    ).sort(
      (routeAmountA, routeAmountB) =>
        routeAmountB.percentage - routeAmountA.percentage
    );

    return { quote, quoteGasAdjusted, routeAmounts };
  }

}
