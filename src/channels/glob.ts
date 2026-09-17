function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Glob de routingKey (spec §5): `*` = exactamente 1 segmento, `#` = resto
 * (cero o más segmentos). Precalculado por subscriber (plan §8.5 regla 3).
 */
export function compileGlob(pattern: string): (key: string) => boolean {
  const segments = pattern.split('.');
  let source = '';
  segments.forEach((segment, index) => {
    let piece: string;
    let joiner: string;
    if (segment === '*') {
      piece = '[^.]+';
      joiner = '\\.';
    } else if (segment === '#') {
      piece = '[^.]+(?:\\.[^.]+)*';
      joiner = '\\.';
    } else {
      piece = escapeRegExp(segment);
      joiner = '\\.';
    }
    if (segment === '#') {
      source += index === 0 ? `(?:${piece})?` : `(?:${joiner}${piece})?`;
    } else {
      source += index === 0 ? piece : `${joiner}${piece}`;
    }
  });
  const regex = new RegExp(`^${source}$`);
  return (key: string) => regex.test(key);
}
