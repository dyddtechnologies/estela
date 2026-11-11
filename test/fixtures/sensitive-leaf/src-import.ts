// Fixture for test/sensitive-bounds.spec.ts: an import of another src/ folder the sensitive-is-leaf rule must flag.
import { createMessage } from '../../../src/message';
import { sibling } from './sibling';

export const message = createMessage(sibling);
