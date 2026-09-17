import { createMessage, type IntegrationMessage } from './message';
import {
  assertNoFanoutCycle,
  CapacityExceededError,
  ChannelError,
  ChannelNotFoundError,
  FanoutCycleError,
  MAX_HOP_DEPTH,
  NoSubscriberError,
} from './channel';

describe('jerarquía de errores de dominio (plan §8.2)', () => {
  it('todos los errores de canal extienden ChannelError', () => {
    expect(new NoSubscriberError('a')).toBeInstanceOf(ChannelError);
    expect(new ChannelNotFoundError('a')).toBeInstanceOf(ChannelError);
    expect(new CapacityExceededError('a', 1)).toBeInstanceOf(ChannelError);
    expect(new FanoutCycleError('ciclo')).toBeInstanceOf(ChannelError);
  });
});

describe('assertNoFanoutCycle (ADR-019)', () => {
  const msgWithHistory = (channels: string[]): IntegrationMessage =>
    createMessage('p', { history: channels.map((channel) => ({ channel, at: 0 })) });

  it('permite el primer y segundo cruce a un canal', () => {
    expect(() => assertNoFanoutCycle(msgWithHistory(['a', 'b']), 'a')).not.toThrow();
    expect(() => assertNoFanoutCycle(msgWithHistory([]), 'a')).not.toThrow();
  });

  it('detecta ciclo cuando el target ya apareció 2+ veces (A↔B)', () => {
    expect(() => assertNoFanoutCycle(msgWithHistory(['b', 'a', 'b', 'a']), 'a')).toThrow(
      FanoutCycleError,
    );
  });

  it('falla por profundidad máxima', () => {
    const deep = msgWithHistory(Array.from({ length: MAX_HOP_DEPTH }, (_, i) => `c${i}`));
    expect(() => assertNoFanoutCycle(deep, 'next')).toThrow(FanoutCycleError);
  });
});
