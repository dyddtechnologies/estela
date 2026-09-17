/**
 * ESTELA guard: all code comments MUST be English.
 * Flags comments containing Spanish-only words or non-ASCII characters.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['src', 'test'];
const EXT = /\.(ts|js|mjs|cjs)$/;

// Word-boundary Spanish-only vocabulary (English-safe words excluded).
const ES = [
  'el',
  'la',
  'los',
  'las',
  'del',
  'para',
  'con',
  'sin',
  'por',
  'cada',
  'todo',
  'toda',
  'todos',
  'todas',
  'solo',
  'sólo',
  'está',
  'están',
  'esté',
  'más',
  'también',
  'tambien',
  'pero',
  'entre',
  'sobre',
  'según',
  'segun',
  'cuando',
  'donde',
  'porque',
  'porqué',
  'siempre',
  'jamás',
  'jamais',
  'nunca',
  'antes',
  'después',
  'despues',
  'mensaje',
  'mensajes',
  'canal',
  'canales',
  'flujo',
  'flujos',
  'paso',
  'pasos',
  'cola',
  'colas',
  'publica',
  'publican',
  'publicado',
  'responde',
  'responden',
  'respuesta',
  'respuestas',
  'espera',
  'esperan',
  'falla',
  'fallan',
  'fallas',
  'éxito',
  'exito',
  'duplicado',
  'duplicada',
  'duplicados',
  'licencia',
  'nuevo',
  'nueva',
  'nuevos',
  'nuevas',
  'nombre',
  'nombres',
  'clave',
  'claves',
  'valor',
  'valores',
  'vacío',
  'vacio',
  'cadena',
  'cadenas',
  'entrada',
  'salida',
  'siguiente',
  'anterior',
  'terminal',
  'interno',
  'interna',
  'externo',
  'externa',
  'propios',
  'propia',
  'requiere',
  'requieren',
  'ejecuta',
  'ejecutan',
  'envía',
  'envian',
  'entrega',
  'entregan',
  'crea',
  'crean',
  'creado',
  'creada',
  'creación',
  'creacion',
  'valida',
  'validan',
  'validación',
  'validacion',
  'conector',
  'contratante',
  'asegurado',
  'cotizacion',
  'cotización',
  'póliza',
  'poliza',
  'seguros',
  'seguro',
  'esqueleto',
  'esqueleto',
  'pendiente',
  'pendientes',
  'migración',
  'migracion',
  'original',
  'canónicos',
  'canonicos',
  'ganadores',
  'perdida',
  'pérdida',
  'silencio',
  'idempotencia',
  'trazas',
  'traza',
  'conector',
  'esperando',
  'mensaje',
  'firmas',
  'firmas',
  'clona',
  'clones',
  'ciclo',
  'ciclos',
  'arista',
  'aristas',
  'nodo',
  'nodos',
  'grafo',
  'grafos',
  'reglas',
  'regla',
  'hereda',
  'heredan',
  'intacto',
  'intactos',
  'afuera',
  'adentro',
  'ambos',
  'ambas',
  'demás',
  'demas',
  'aquí',
  'aqui',
  'ahí',
  'ahi',
  'allí',
  'alli',
  'así',
  'asi',
  'denso',
  'detalle',
  'detalles',
  'falta',
  'faltan',
  'cambios',
  'cambio',
  'llama',
  'llaman',
  'llamada',
  'usando',
  'usado',
  'usada',
  'evita',
  'evitan',
  'evitar',
  'rompe',
  'rompen',
  'roto',
  'rota',
  'romper',
  'crash',
  'corre',
  'corren',
  'corrida',
  'levantada',
];
const RE_ES = new RegExp(`\\b(${ES.join('|')})\\b`, 'i');
const RE_NON_ASCII = /[^\x00-\x7F]/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (EXT.test(entry.name)) yield p;
  }
}

let bad = 0;
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let inBlock = false;
    lines.forEach((raw, i) => {
      let line = raw;
      if (inBlock || /\s\/\*/.test(line) || /^\s*\/\*/.test(line)) {
        const commentPart = line.slice(line.indexOf(inBlock ? -1 : '/*'));
        line = inBlock || /\/\*/.test(line) ? line : line;
      }
      // simplified: test whole line but strip code quotes and https://
      const stripped = raw.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''").replace(/https?:\/\//g, '');
      const isComment =
        /^\s*(\/\/|\/\*|\*)/.test(stripped) || /.\s\/\/\s/.test(stripped) || inBlock;
      if (!isComment) {
        if (/\/\*/.test(stripped)) inBlock = true;
        if (inBlock && /\*\//.test(stripped)) inBlock = false;
        return;
      }
      if (inBlock && /\*\//.test(stripped)) inBlock = false;
      const m = stripped.match(RE_ES) || (RE_NON_ASCII.test(stripped) ? ['<non-ascii>'] : null);
      if (m) {
        bad += 1;
        console.log(
          `${file}:${i + 1}: non-English comment (${m[0]}) → ${stripped.trim().slice(0, 110)}`,
        );
      }
    });
  }
}
console.log(
  bad === 0 ? 'comments-en: OK — all comments are English' : `comments-en: ${bad} violation(s)`,
);
process.exit(bad === 0 ? 0 : 1);
