/**
 * Privacy spec sections 4 and 19: the runtime values each public entry must export, and no
 * pre-vocabulary name (`sensitive*`, `redact*`, `mask*`, `salt*`, `statusOnly`) reaches a barrel.
 * `redactUrl` is the one exception: it shipped in 0.9.0, so removing it would be a breaking change.
 */
import * as main from '../src/index';
import * as testing from '../src/testing/index';

const MAIN_VALUES = [
  'Show',
  'Remember',
  'KeyCase',
  'Reach',
  'TapCopy',
  'Pack',
  'TrailOutput',
  'DEFAULT_HIDDEN_HEADERS',
  'Private',
  'privateFieldsOf',
  'envFingerprintSecret',
  'nativeRegexEngine',
  'PrivacyEngine',
  'urlForTrail',
  'SEALED_RECORD_KEY',
  'OUTCOME_ONLY_RECORD_KEY',
  'PrivacyError',
  'PrivacyConfigError',
  'SealKeyUnavailableError',
  'ReplayUnavailableError',
  'SealBrokenError',
  'DeliveryCopyError',
  'PRIVACY_FINDING_CODES',
];

const TESTING_VALUES = ['captureTrail', 'expectNoLeak', 'leakForms', 'LeakForm'];

const LEGACY = /sensitive|redact|mask|salt|statusonly|status_only/i;
const SHIPPED_IN_0_9_0 = new Set(['redactUrl']);

describe('privacy barrels (spec sections 4 and 19)', () => {
  it.each(MAIN_VALUES)('@estela/nest exports %s', (name) => {
    expect((main as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(TESTING_VALUES)('@estela/nest/testing exports %s', (name) => {
    expect((testing as Record<string, unknown>)[name]).toBeDefined();
  });

  it('no barrel exports a pre-vocabulary privacy name (section 19.7, no aliases)', () => {
    const names = [...Object.keys(main), ...Object.keys(testing)];
    expect(names.filter((name) => LEGACY.test(name) && !SHIPPED_IN_0_9_0.has(name))).toEqual([]);
  });

  it('FlowParameterFinding names the privacy concern, never the unreleased sensitive one (D23)', () => {
    type Concern = main.FlowParameterFinding['concern'];
    const privacy: Concern = 'privacy';
    // @ts-expect-error 'sensitive' never shipped and is not a concern name (section 19.7)
    const legacy: Concern = 'sensitive';
    expect([privacy, legacy]).toHaveLength(2);
  });

  it('the enums carry the final string values (section 3)', () => {
    expect(Object.values(main.Show)).toEqual([
      'hidden',
      'omitted',
      'ends',
      'fingerprint',
      'length',
      'text',
    ]);
    expect(Object.values(main.Remember)).toEqual([
      'everything',
      'as-shown',
      'sealed',
      'outcome-only',
    ]);
    expect(Object.values(main.KeyCase)).toEqual(['ignore', 'match']);
    expect(Object.values(main.Reach)).toEqual(['trail', 'delivery']);
    expect(Object.values(main.TapCopy)).toEqual(['as-shown', 'original']);
    expect(Object.values(main.Pack)).toEqual(['secrets', 'secrets@1', 'personal', 'personal@1']);
    expect(main.OUTCOME_ONLY_RECORD_KEY).toBe('estelaOutcomeOnly');
    expect(main.SEALED_RECORD_KEY).toBe('estelaSealed');
    expect(testing.LeakForm.AsIs).toBe('as-is');
  });
});
