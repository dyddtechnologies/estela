import type { FieldRule, ShowOptions } from './privacy.types';
import { joinSelector } from './selector';

/**
 * Metadata lives on the constructor under a registry-wide symbol (non-enumerable), so the ESM and
 * CJS copies of the package share it (SD-06). No reflect-metadata.
 */
const PRIVATE_FIELDS = Symbol.for('@estela/nest.private');

export type PrivateFieldOptions = ShowOptions & { name?: string };

interface PrivateFieldEntry {
  readonly key: string;
  readonly options: PrivateFieldOptions;
}

type Holder = Record<symbol, readonly PrivateFieldEntry[] | undefined>;

function ownEntries(ctor: object): readonly PrivateFieldEntry[] {
  return Object.hasOwn(ctor, PRIVATE_FIELDS) ? ((ctor as Holder)[PRIVATE_FIELDS] ?? []) : [];
}

/** Marks a DTO property as private: the trail shows it by `options.show` (default hidden). */
export function Private(options: PrivateFieldOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    if (typeof propertyKey !== 'string') return;
    const ctor = (target as { constructor?: unknown }).constructor;
    if (typeof ctor !== 'function') return;
    const entries = [...ownEntries(ctor), { key: propertyKey, options: { ...options } }];
    Object.defineProperty(ctor, PRIVATE_FIELDS, {
      value: Object.freeze(entries),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  };
}

/** Own and inherited entries of a constructor, subclass last (a subclass entry wins). */
export function privateEntriesOf(ctor: unknown): Map<string, PrivateFieldOptions> {
  const chain: object[] = [];
  let current: unknown = ctor;
  while (typeof current === 'function' && current !== Function.prototype) {
    chain.unshift(current);
    current = Object.getPrototypeOf(current);
  }
  const out = new Map<string, PrivateFieldOptions>();
  for (const link of chain) for (const entry of ownEntries(link)) out.set(entry.key, entry.options);
  return out;
}

/** Selectors of a decorated class, prefixed (e.g. 'accounts[*]'). Own and inherited fields (SD-07). */
export function privateFieldsOf(
  type: abstract new (...args: never[]) => unknown,
  prefix?: string,
): FieldRule[] {
  const rules: FieldRule[] = [];
  for (const [key, options] of privateEntriesOf(type)) {
    rules.push({ ...options, path: joinSelector(prefix, key) });
  }
  return rules;
}
