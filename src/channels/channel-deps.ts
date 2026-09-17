import type { IntegrationMessage } from '../message';
import type { ChannelResolver } from '../channel';
import type { TraceContext } from '../trace/trace-context';

/**
 * Colaboradores inyectados a los canales (composición, plan §5.2).
 * `trace` SIEMPRE es la instancia compartida de la app: los canales
 * reconstruyen el contexto desde `msg.headers` en cada dispatch (plan §8.5).
 */
export interface ChannelDeps {
  trace: TraceContext;
  /** Resolución de bindings — requerido por FanoutChannel. */
  resolver?: ChannelResolver;
  /** Aislamiento de errores por subscriber/consumer (se cablea a error.channel en Fase 3). */
  onError?: (error: unknown, msg: IntegrationMessage) => void;
  /** Avisos no fatales (p. ej. re-subscripción en direct — spec §17.7). */
  onWarn?: (message: string) => void;
}
