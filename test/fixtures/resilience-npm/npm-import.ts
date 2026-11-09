/**
 * RU-05 fixture: stands in for a file under src/resilience that imports an npm package.
 * `test/resilience-bounds.spec.ts` points the `resilience-no-npm` rule at this folder.
 */
import { of } from 'rxjs';

export const npmValue = of(1);
