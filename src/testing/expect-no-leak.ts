import { createHash } from 'node:crypto';
import type { TrailCapture } from './capture-trail';
import { LeakForm, leakForms } from './leak-forms';

const MIN_SECRET_CHARS = 8;

function hashPrefix(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Fails when any secret, in any form, appears in a captured trail write (SD-38). The failure names
 * the trail output, where it was written, the form and a SHA-256 prefix of the secret, never the
 * secret itself.
 */
export function expectNoLeak(
  capture: TrailCapture,
  secrets: readonly string[],
  options: { forms?: readonly LeakForm[] } = {},
): void {
  if (capture.keepOriginals) {
    throw new Error('expectNoLeak refuses a capture made with keepOriginals: true');
  }
  const forms = options.forms ?? Object.values(LeakForm);
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_CHARS) {
      throw new Error(
        `expectNoLeak refuses secrets shorter than ${MIN_SECRET_CHARS} chars (sha256:${hashPrefix(secret)})`,
      );
    }
    const encoded = leakForms(secret);
    for (const write of capture.writes) {
      for (const form of forms) {
        const needle = encoded.get(form);
        if (needle === undefined || needle.length < 4 || !write.text.includes(needle)) continue;
        throw new Error(
          `secret sha256:${hashPrefix(secret)} leaked to trail output '${write.output}'` +
            ` (${write.where}) in form ${form}`,
        );
      }
    }
  }
}
