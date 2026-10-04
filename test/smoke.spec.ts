import { version } from '../package.json';
import * as root from '../src/index';
import { createTestMessage } from '../src/testing';
import * as banner from '../src/trace/banner';
import * as failure from '../src/inbound/inbound.failure';
import { encodeInboundKey } from '../src/inbound/inbound.idempotency';
import { envelopeReplyMapper, rawReplyMapper } from '../src/inbound/inbound.reply';

describe('Fase 0 — scaffolding', () => {
  it('el barrel raíz compila y expone la versión', () => {
    expect(root.INTEGRATION_LIBRARY_VERSION).toBe(version);
  });

  it('el subpath /testing compila y expone su marcador', () => {
    const msg = createTestMessage('smoke');
    expect(msg.payload).toBe('smoke');
  });

  it('the root barrel re-exports the selected banner and inbound 0.6.0 members', () => {
    expect(root.ESTELA_BANNER).toBe(banner.ESTELA_BANNER);
    expect(root.ESTELA_BANNER_ENV).toBe(banner.ESTELA_BANNER_ENV);
    expect(root.printEstelaBanner).toBe(banner.printEstelaBanner);
    expect(root.HttpExceptionFailureCodec).toBe(failure.HttpExceptionFailureCodec);
    expect(root.INBOUND_STORED_FAILURE_KEY).toBe(failure.INBOUND_STORED_FAILURE_KEY);
    expect(root.InboundIdempotencyInFlightError).toBe(failure.InboundIdempotencyInFlightError);
    expect(root.InboundReplayedFailureError).toBe(failure.InboundReplayedFailureError);
    expect(root.markInboundFailure).toBe(failure.markInboundFailure);
    expect(root.readInboundFailureMark).toBe(failure.readInboundFailureMark);
    expect(root.encodeInboundKey).toBe(encodeInboundKey);
    expect(root.envelopeReplyMapper).toBe(envelopeReplyMapper);
    expect(root.rawReplyMapper).toBe(rawReplyMapper);
  });
});
