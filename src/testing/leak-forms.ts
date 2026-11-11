/** Encoded forms a leaked secret may take in a trail write (SD-38). */
export enum LeakForm {
  AsIs = 'as-is',
  Base64At0 = 'base64@0',
  Base64At1 = 'base64@1',
  Base64At2 = 'base64@2',
  Base64UrlAt0 = 'base64url@0',
  Base64UrlAt1 = 'base64url@1',
  Base64UrlAt2 = 'base64url@2',
  Uri = 'uri',
  Form = 'form',
  Json = 'json',
  Json2 = 'json2',
}

/**
 * The part of a base64 encoding fully determined by the secret when it starts `offset` bytes into
 * the encoded data: the characters the prefix or the following bytes can change are cut off.
 */
function base64Core(secret: Buffer, offset: number, encoding: 'base64' | 'base64url'): string {
  const encoded = Buffer.concat([Buffer.alloc(offset), secret])
    .toString(encoding)
    .split('=', 1)[0]!;
  const start = Math.ceil((offset * 8) / 6);
  const end = Math.floor(((offset + secret.length) * 8) / 6);
  return encoded.slice(start, end);
}

/** Every form of one secret, keyed by form. */
export function leakForms(secret: string): ReadonlyMap<LeakForm, string> {
  const bytes = Buffer.from(secret, 'utf8');
  const json = JSON.stringify(secret).slice(1, -1);
  return new Map<LeakForm, string>([
    [LeakForm.AsIs, secret],
    [LeakForm.Base64At0, base64Core(bytes, 0, 'base64')],
    [LeakForm.Base64At1, base64Core(bytes, 1, 'base64')],
    [LeakForm.Base64At2, base64Core(bytes, 2, 'base64')],
    [LeakForm.Base64UrlAt0, base64Core(bytes, 0, 'base64url')],
    [LeakForm.Base64UrlAt1, base64Core(bytes, 1, 'base64url')],
    [LeakForm.Base64UrlAt2, base64Core(bytes, 2, 'base64url')],
    [LeakForm.Uri, encodeURIComponent(secret)],
    [LeakForm.Form, new URLSearchParams({ v: secret }).toString().slice(2)],
    [LeakForm.Json, json],
    [LeakForm.Json2, JSON.stringify(json).slice(1, -1)],
  ]);
}
