import type { FlowParameterFinding } from '../resilience/resilience.errors';

export type { FlowParameterFinding };

/** Finding codes about the shape of a flow, owned by the `flow` concern (RS-57, RS-58, RS-67). */
export const FLOW_SHAPE_CODES = {
  wiretapResilience: 'WIRETAP_RESILIENCE',
  duplicateStepId: 'DUPLICATE_STEP_ID',
  primitiveNotAllowed: 'PRIMITIVE_NOT_ALLOWED',
} as const;

function summarize(findings: readonly FlowParameterFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const first = errors[0] ?? findings[0];
  if (first === undefined) return 'invalid flow definition';
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more finding(s))` : '';
  return `${first.message}${more}`;
}

/**
 * A flow whose shape or parameters are invalid (RS-57, RS-58, RS-67). `findings` lists every
 * finding of the boot pass; the message names the first error, its subject and its option path.
 */
export class FlowDefinitionError extends Error {
  readonly findings: readonly FlowParameterFinding[];

  constructor(findings: readonly FlowParameterFinding[]) {
    super(summarize(findings));
    this.name = 'FlowDefinitionError';
    this.findings = findings;
  }

  /** The finding codes, in order (handy in tests and logs). */
  get codes(): readonly string[] {
    return this.findings.map((finding) => finding.code);
  }
}

/** One `flow` concern error finding. */
export function flowFinding(
  subject: string,
  path: string,
  code: string,
  rule: string,
): FlowParameterFinding {
  return {
    concern: 'flow',
    code,
    severity: 'error',
    subject,
    path,
    message: `${subject}: ${path} ${rule}`,
  };
}
