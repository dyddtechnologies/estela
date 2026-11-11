export interface CompiledPattern {
  /**
   * Calls fn for every non-overlapping match, left to right; fn returns the replacement. An engine
   * may pass `spans`, the [start, end) offsets of each capture group inside the match, so a group
   * is replaced in place; without them Estela locates the group by its last occurrence.
   */
  replaceAll(
    input: string,
    fn: (
      match: string,
      groups: readonly (string | undefined)[],
      offset: number,
      spans?: readonly (readonly [number, number] | undefined)[],
    ) => string,
  ): string;
}

export interface RegexEngine {
  readonly name: string;
  compile(source: string, flags: string): CompiledPattern;
}

/** Flags kept from a rule; `g` and `d` are always added, `y` is refused by the analysis. */
function nativeFlags(flags: string): string {
  let out = flags.replace(/[gdy]/g, '');
  out += 'gd';
  return out;
}

/** The default engine: native RegExp, guarded by the boot analysis of SD-19. */
export const nativeRegexEngine: RegexEngine = {
  name: 'native',
  compile(source: string, flags: string): CompiledPattern {
    const regex = new RegExp(source, nativeFlags(flags));
    const sticky = new RegExp(source, nativeFlags(flags).replace('g', '') + 'y');
    return {
      replaceAll(input, fn) {
        regex.lastIndex = 0;
        return input.replace(regex, (...args: unknown[]) => {
          const match = args[0] as string;
          const last = args[args.length - 1];
          const hasNamed = typeof last === 'object' && last !== null;
          const offsetIndex = hasNamed ? args.length - 3 : args.length - 2;
          const offset = args[offsetIndex] as number;
          const groups = args.slice(1, offsetIndex) as (string | undefined)[];
          return fn(match, groups, offset, spansOf(sticky, input, offset, groups.length));
        });
      },
    };
  },
};

/** Group spans relative to the match, recomputed with the `d` flag at the match offset. */
function spansOf(
  sticky: RegExp,
  input: string,
  offset: number,
  count: number,
): (readonly [number, number] | undefined)[] | undefined {
  if (count === 0) return undefined;
  sticky.lastIndex = offset;
  const indices = sticky.exec(input)?.indices;
  if (indices === undefined) return undefined;
  const out: (readonly [number, number] | undefined)[] = [];
  for (let i = 1; i <= count; i++) {
    const span = indices[i];
    out.push(span === undefined ? undefined : [span[0] - offset, span[1] - offset]);
  }
  return out;
}
