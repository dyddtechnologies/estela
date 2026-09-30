import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import {
  ESTELA_BANNER,
  ESTELA_BANNER_ENV,
  printEstelaBanner,
  resetEstelaBannerForTests,
} from './banner';

describe('startup banner', () => {
  beforeEach(() => resetEstelaBannerForTests());

  it('names the runtime and its author', () => {
    expect(ESTELA_BANNER).toContain('ESTELA - created by: www.dyddtech.com');
    // Six rows of block letters, five of them opening with '|'; String.raw keeps the backslashes.
    const art = ESTELA_BANNER.split('\n').filter((line) => line.startsWith('|'));
    expect(art).toHaveLength(5);
    expect(ESTELA_BANNER).toContain(String.raw`/_/    \_\ `.trimEnd());
  });

  it('prints once per process', () => {
    const write = jest.fn<void, [string]>();
    expect(printEstelaBanner({ write, env: {} })).toBe(true);
    expect(printEstelaBanner({ write, env: {} })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('www.dyddtech.com'));
  });

  it('can be turned off by option or by environment', () => {
    const write = jest.fn<void, [string]>();
    expect(printEstelaBanner({ write, env: {}, enabled: false })).toBe(false);
    expect(printEstelaBanner({ write, env: { [ESTELA_BANNER_ENV]: 'FALSE' } })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(printEstelaBanner({ write, env: { [ESTELA_BANNER_ENV]: 'true' } })).toBe(true);
  });

  describe('IntegrationModule', () => {
    let stdout: jest.SpyInstance;
    const env = process.env[ESTELA_BANNER_ENV];

    beforeEach(() => {
      delete process.env[ESTELA_BANNER_ENV];
      stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      stdout.mockRestore();
      if (env === undefined) delete process.env[ESTELA_BANNER_ENV];
      else process.env[ESTELA_BANNER_ENV] = env;
    });

    const boot = async (options: IntegrationModuleOptions) => {
      const moduleRef = await Test.createTestingModule({
        imports: [IntegrationModule.forRoot(options)],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      await app.close();
    };
    const bannerWrites = (): unknown[][] =>
      (stdout.mock.calls as unknown[][]).filter(([text]) =>
        String(text).includes('created by: www.dyddtech.com'),
      );

    it('prints the banner when the first module starts, and only once', async () => {
      await boot({ channels: [] });
      await boot({ channels: [] });
      expect(bannerWrites()).toHaveLength(1);
    });

    it('stays quiet with logging.banner = false', async () => {
      await boot({ channels: [], logging: { banner: false } });
      expect(bannerWrites()).toHaveLength(0);
    });
  });
});
