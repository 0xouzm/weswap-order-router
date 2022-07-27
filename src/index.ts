/// <reference types="./types/bunyan-debug-stream" />
import { Command, flags } from '@oclif/command';
import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list';
import { ethers } from 'ethers';

import { ROUTER_IDS_LIST, RouterId } from "./routers/router-factory";

export class WeswapSORCLI extends Command {
  static description = 'Weswap Smart Order Router CLI';

  static flags = {
    version: flags.version({ char: 'v' }),
    help: flags.help({ char: 'h' }),
    tokenIn: flags.string({ char: 'i', required: true }),
    tokenOut: flags.string({ char: 'o', required: true }),
    amount: flags.string({ char: 'a', required: true }),
    exactIn: flags.boolean({ required: false }),
    exactOut: flags.boolean({ required: false }),
    router: flags.string({
      char: 's',
      required: false,
      default: RouterId.Default,
      options: ROUTER_IDS_LIST,
    }),

    debug: flags.boolean(),
  };

  async run() {
    this.parse(WeswapSORCLI);
    console.log('WeswapSORCLI');
  }
}
