import * as root from '../src/index';
import { createTestMessage } from '../src/testing';

describe('Fase 0 — scaffolding', () => {
  it('el barrel raíz compila y expone la versión', () => {
    expect(root.INTEGRATION_LIBRARY_VERSION).toBe('0.1.0');
  });

  it('el subpath /testing compila y expone su marcador', () => {
    const msg = createTestMessage('smoke');
    expect(msg.payload).toBe('smoke');
  });
});
