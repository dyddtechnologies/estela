import type { IntegrationMessage } from '../message';
import type { ChannelResolver } from '../channel';
import type { TraceContext } from '../trace/trace-context';

/**
 * Colaboradores inyectados a los channels (composicion, plan sec.5.2).
 * `trace` Always es la instancia compartida de la app: los channels
 * reconstruyen el contexto desde `msg.headers` en cada dispatch (plan sec.8.5).
 */
export interface ChannelDeps {
  trace: TraceContext;
  /** Resolution de bindings — requerido por FanoutChannel. */
  resolver?: ChannelResolver;
  /** Aislamiento de errores por subscriber/consumer (se cablea a error.channel en Fase 3). */
  onError?: (error: unknown, msg: IntegrationMessage) => void;
  /** Avisos no fatales (p. ej. re-subscripcion en direct — spec sec.17.7). */
  onWarn?: (message: string) => void;
}
