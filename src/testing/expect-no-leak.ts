import type { TrailCapture } from './capture-trail';
import { LeakForm, leakForms } from './leak-forms';

const MIN_SECRET_CHARS = 8;

/**
 * Names a secret by its position in the caller's list and its length. The caller holds the list, so
 * the index is enough to tell which secret leaked; nothing derived from the value itself (not even a
 * hash, which a short or guessable secret would give away) reaches the message.
 */
function secretLabel(index: number, secret: string): string {
  return `secrets[${index}] (${secret.length} chars)`;
}

/**
 * Fails when any secret, in any form, appears in a captured trail write (SD-38). The failure names
 * the trail output, where it was written, the form and the secret's index and length in `secrets`,
 * never the secret itself.
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
  secrets.forEach((secret, index) => {
    if (secret.length < MIN_SECRET_CHARS) {
      throw new Error(
        `expectNoLeak refuses secrets shorter than ${MIN_SECRET_CHARS} chars (${secretLabel(index, secret)})`,
      );
    }
    const encoded = leakForms(secret);
    for (const write of capture.writes) {
      for (const form of forms) {
        const needle = encoded.get(form);
        if (needle === undefined || needle.length < 4 || !write.text.includes(needle)) continue;
        throw new Error(
          `${secretLabel(index, secret)} leaked to trail output '${write.output}'` +
            ` (${write.where}) in form ${form}`,
        );
      }
    }
  });
}
