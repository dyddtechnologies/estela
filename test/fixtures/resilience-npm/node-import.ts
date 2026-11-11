/** RU-05 fixture: a node: core import is allowed under src/resilience (RS-05). */
import { randomInt } from 'node:crypto';

export const nodeValue = (): number => randomInt(10);
