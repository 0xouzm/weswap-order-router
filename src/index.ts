import { Command, flags } from '@oclif/command';

export class WeswapSORCLI extends Command {
  static description = 'Weswap Smart Order Router CLI';

  static flags = {
    version: flags.version({ char: 'v' }),
    help: flags.help({ char: 'h' }),
    debug: flags.boolean(),
  }

  async run() {
    console.log('WeswapSORCLI');
  }
}
