import { Token } from '@uniswap/sdk-core';
import { schema, TokenInfo, TokenList } from '@uniswap/token-lists';
import Ajv from 'ajv';
import axios from 'axios';
import Logger from 'bunyan';
import _ from 'lodash';

import { ChainId } from '../util/chains';

type ChainToTokenInfoList = { [chainId in ChainId]: TokenInfo[] };
type SymbolTokenInfo = { [index: string]: TokenInfo };

type TokenInfoMapping = { [chainId in ChainId]: SymbolTokenInfo };

export class TokenProvider {
  private log: Logger;
  private tokenList: TokenList;
  private chainToTokenInfos: ChainToTokenInfoList;
  private chainSymbolToTokenInfo: TokenInfoMapping;

  constructor(tokenList: TokenList, log: Logger) {
    const tokenListValidator = new Ajv().compile(schema);
    if (!tokenListValidator(tokenList)) {
      throw new Error('Token list failed validation.');
    }

    this.log = log;
    this.tokenList = tokenList;

    this.chainToTokenInfos = _.reduce(
      this.tokenList.tokens,
      (result: ChainToTokenInfoList, tokenInfo: TokenInfo) => {
        result[tokenInfo.chainId as ChainId].push(tokenInfo);
        return result;
      },
      {
        [ChainId.MAINNET]: [],
        [ChainId.KOVAN]: [],
        [ChainId.RINKEBY]: [],
        [ChainId.ROPSTEN]: [],
        [ChainId.GÖRLI]: [],
      }
    );

    this.chainSymbolToTokenInfo = _.mapValues(
      this.chainToTokenInfos,
      (tokenInfos: TokenInfo[]) => _.keyBy(tokenInfos, 'symbol')
    );

  }

  public static async fromTokenListURI(tokenListURI: string, log: Logger) {
    const response = await axios.get(tokenListURI);
    const { data: tokenList, status } = response;

    if (status !== 200) {
      log.error({ response }, `Unable to get token list from ${tokenListURI}.`);

      throw new Error(`Unable to get token list from ${tokenListURI}`);
    }

    return new TokenProvider(tokenList, log);
  }

  public static async fromTokenList(tokenList: TokenList, log: Logger) {
    return new TokenProvider(tokenList, log);
  }

  public getToken(chainId: ChainId, symbol: string) {
    const token: Token | undefined = this.getTokenIfExists(chainId, symbol);

    if (!token) {
      throw new Error(
        `Token ${symbol} not found in token list '${this.tokenList.name}'`
      );
    }

    return token;
  }

  public getTokenIfExists(chainId: ChainId, _symbol: string) {
    let symbol = _symbol;
    if (_symbol == 'ETH') {
      symbol = 'WETH';
    }

    const tokenInfo: TokenInfo | undefined = this.chainSymbolToTokenInfo[
      chainId
    ][symbol];

    if (!tokenInfo) {
      this.log.trace(
        `Could not find ${symbol} in Token List ' ${this.tokenList.name}'. Ignoring.`
      );

      return undefined;
    }

    return new Token(
      chainId,
      tokenInfo.address,
      tokenInfo.decimals,
      tokenInfo.symbol,
      tokenInfo.name
    );
  }

  tokenExists(chainId: ChainId, symbol: string):boolean {
    return !!this.getTokenIfExists(chainId, symbol);
  }

  public getTokensIfExists(chainId: ChainId, ...symbols: string[]): Token[] {
    const tokens: Token[] = _(symbols)
      .map((symbol: string) => {
        return this.getTokenIfExists(chainId, symbol);
      })
      .compact()
      .value();

    return tokens;
  }
}
