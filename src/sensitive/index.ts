/** Privacy (SPI-433): public names only; internal helpers keep plain engineering names. */
export {
  DEFAULT_HIDDEN_HEADERS,
  KeyCase,
  Pack,
  Reach,
  Remember,
  Show,
  type Exemption,
  type FieldRule,
  type PackName,
  type PatternRule,
  type Privacy,
  type PrivacyModuleOptions,
  type PrivacyProfile,
  type PrivacyRef,
  type ShowOptions,
} from './privacy.types';
export { Private, privateFieldsOf } from './private.decorator';
export {
  envFingerprintSecret,
  type FingerprintSecret,
  type FingerprintSecretProvider,
} from './fingerprint-secret';
export type { SealKey, SealKeyProvider } from './seal-key';
export { nativeRegexEngine, type CompiledPattern, type RegexEngine } from './regex-engine';
export {
  PrivacyEngine,
  TrailOutput,
  urlForTrail,
  type PrivacyLogger,
  type PrivacyStats,
  type TrailContext,
  type TrailError,
} from './privacy-engine';
export type {
  PrivacyLevel,
  PrivacyLevelKind,
  PrivacyScope,
  PrivacyScopes,
} from './policy-resolver';
export {
  OUTCOME_ONLY_RECORD_KEY,
  SEALED_RECORD_KEY,
  type RecordCodec,
  type RecordSealer,
} from './sealed-record';
export {
  DeliveryCopyError,
  PRIVACY_FINDING_CODES,
  PrivacyConfigError,
  PrivacyError,
  ReplayUnavailableError,
  SealBrokenError,
  SealKeyUnavailableError,
  type PrivacyErrorKind,
  type PrivacyFinding,
} from './privacy-errors';
