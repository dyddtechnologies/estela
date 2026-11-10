/** The HMAC key behind `Show.Fingerprint`. `id` matches `^[A-Za-z0-9_-]{1,16}$`; `secret` >= 32 bytes. */
export interface FingerprintSecret {
  id: string;
  secret: Uint8Array;
}

export interface FingerprintSecretProvider {
  current(): FingerprintSecret | Promise<FingerprintSecret>;
}

export const FINGERPRINT_SECRET_ID = /^[A-Za-z0-9_-]{1,16}$/;
export const MIN_FINGERPRINT_SECRET_BYTES = 32;

/** Why a fingerprint secret is unusable, naming only the id and the length (SD-42). */
export function fingerprintSecretProblem(material: FingerprintSecret): string | undefined {
  const id: unknown = material.id;
  if (typeof id !== 'string' || !FINGERPRINT_SECRET_ID.test(id)) {
    return 'has an invalid secret id';
  }
  const secret: unknown = material.secret;
  if (!(secret instanceof Uint8Array)) return `'${id}' is not a byte array`;
  if (secret.byteLength < MIN_FINGERPRINT_SECRET_BYTES) {
    return `'${id}' is ${secret.byteLength} bytes, below ${MIN_FINGERPRINT_SECRET_BYTES}`;
  }
  return undefined;
}

/**
 * Reads the secret as base64 from `secretVar` and its id from `idVar`. `current()` throws when either
 * is missing or the secret is short; the message names the variables, never their values.
 */
export function envFingerprintSecret(
  secretVar: string,
  idVar: string,
  env: Record<string, string | undefined> = process.env,
): FingerprintSecretProvider {
  return {
    current(): FingerprintSecret {
      const encoded = env[secretVar];
      const id = env[idVar];
      if (encoded === undefined || encoded === '' || id === undefined || id === '') {
        throw new Error(`fingerprint secret: ${secretVar} and ${idVar} must both be set`);
      }
      const material: FingerprintSecret = { id, secret: Buffer.from(encoded, 'base64') };
      const problem = fingerprintSecretProblem(material);
      if (problem !== undefined) {
        throw new Error(`fingerprint secret from ${secretVar}/${idVar} ${problem}`);
      }
      return material;
    },
  };
}
