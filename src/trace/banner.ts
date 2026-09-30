/**
 * Startup banner: printed once per process when the first IntegrationModule initializes, so the
 * logs show which runtime is driving the flows. Written straight to stdout because a multi-line
 * block passed through the Nest logger gets its first line prefixed and the art misaligned.
 */
export const ESTELA_BANNER = String.raw`
 ______  _____ _______ ______ _
|  ____|/ ____|__   __|  ____| |        /\
| |__  | (___    | |  | |__  | |       /  \
|  __|  \___ \   | |  |  __| | |      / /\ \
| |____ ____) |  | |  | |____| |____ / ____ \
|______|_____/   |_|  |______|______/_/    \_\

  ESTELA - created by: www.dyddtech.com
  Enterprise Integration Patterns for NestJS
`;

/** Environment switch that silences the banner without touching the module options. */
export const ESTELA_BANNER_ENV = 'ESTELA_BANNER';

let printed = false;

export interface BannerOptions {
  /** `false` disables the banner. Default true. */
  enabled?: boolean | undefined;
  /** Where the banner goes. Defaults to process.stdout. */
  write?: (text: string) => void;
  /** Environment to read ESTELA_BANNER from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Prints the banner the first time it is called in the process; later calls are no-ops. */
export function printEstelaBanner(options: BannerOptions = {}): boolean {
  if (printed || options.enabled === false) return false;
  const env = options.env ?? process.env;
  if ((env[ESTELA_BANNER_ENV] ?? '').toLowerCase() === 'false') return false;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(`${ESTELA_BANNER}\n`);
  printed = true;
  return true;
}

/** Test hook: lets a spec print the banner again in the same process. */
export function resetEstelaBannerForTests(): void {
  printed = false;
}
