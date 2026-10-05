import { version } from '../package.json';
import * as root from '../src/index';
import { createTestMessage } from '../src/testing';
import * as banner from '../src/trace/banner';
import * as failure from '../src/inbound/inbound.failure';
import { encodeInboundKey } from '../src/inbound/inbound.idempotency';
import { envelopeReplyMapper, rawReplyMapper } from '../src/inbound/inbound.reply';
import * as outboundPlan from '../src/outbound/outbound.plan';
import * as serializers from '../src/outbound/outbound.serializers';

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

  it('the root barrel re-exports the selected outbound 0.8.0 members', () => {
    expect(root.DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(outboundPlan.DEFAULT_OUTBOUND_TIMEOUT_MS);
    expect(root.DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
    expect(root.DEFAULT_OUTBOUND_MAX_ATTEMPTS).toBe(3);
    expect(root.DEFAULT_OUTBOUND_IDEMPOTENCY_HEADER).toBe('Idempotency-Key');
    expect(root.jsonSerializer).toBe(serializers.jsonSerializer);
    expect(root.textSerializer).toBe(serializers.textSerializer);
    expect(root.formSerializer).toBe(serializers.formSerializer);
    expect(typeof root.OutboundRestGateway).toBe('function');
    expect(typeof root.OutboundRest).toBe('function');
    expect(Object.keys(root)).not.toContain('resolveOutboundRestPlan');
  });
});
