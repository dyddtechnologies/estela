const fs = require('fs');
const path = require('path');
const M = {
  esqueleto:'skeleton', líneas:'lines', lineas:'lines', bloques:'blocks', bloque:'block',
  pasos:'steps', paso:'step', canales:'channels', canal:'channel', mensaje:'message',
  mensajes:'messages', flujo:'flow', flujos:'flows', cola:'queue', colas:'queues',
  entrega:'delivery', entregan:'deliver', entrega2:'', publica:'publishes', publican:'publish',
  publicado:'published', publicación:'publication', creado:'created', creada:'created',
  creación:'creation', crea:'creates', crean:'create', valida:'validates', validan:'validate',
  validación:'validation', validaciones:'validations', asegurado:'insured', aseguradora:'',
  cotización:'quote', cotizacion:'quote', póliza:'policy', poliza:'policy', seguros:'insurance',
  seguro:'insurance', esqueleto:'skeleton', pendiente:'pending', pendientes:'pending',
  migración:'migration', migracion:'migration', silencio:'silence', idempotencia:'idempotency',
  trazas:'tracing', traza:'trace', ciclo:'cycle', ciclos:'cycles', aristas:'edges', arista:'edge',
  nodo:'node', nodos:'nodes', grafo:'graph', grafos:'graphs', reglas:'rules', regla:'rule',
  hereda:'inherits', heredan:'inherit', intacto:'intact', intacta:'intact', fuga:'leak',
  fugas:'leaks', espera:'awaits', esperan:'await', esperando:'awaiting', falla:'fails',
  fallan:'fail', fallo:'failure', fallos:'failures', éxito:'success', exito:'success',
  duplicado:'duplicate', duplicada:'duplicate', duplicados:'duplicates', duplicación:'duplication',
  requiere:'requires', requieren:'require', ejecuta:'executes', ejecutan:'execute',
  ejecución:'execution', ejecucion:'execution', envía:'sends', envian:'send',
  desuscribe:'unsubscribes', suscribe:'subscribes', suscriptores:'subscribers',
  suscriptor:'subscriber', carreras:'races', reenvían:'forward', reenvia:'forward',
  reenvío:'forwarding', reenvio:'forwarding', preserva:'preserves', preservan:'preserve',
  conserva:'keeps', conservan:'keep', construye:'builds', construido:'built',
  construida:'built', construir:'build', creadas:'created', instalar:'install',
  publicar:'publish', paquete:'package', paquetes:'packages', dominio:'domain',
  dominios:'domains', puertos:'ports', puerto:'port', adaptadores:'adapters',
  adaptador:'adapter', capa:'layer', capas:'layers', clase:'class', clases:'classes',
  método:'method', métodos:'methods', función:'function', funciones:'functions',
  interfaz:'interface', contrato:'contract', contratos:'contracts', invariantes:'invariants',
  invariante:'invariant', enforzado:'enforced', proyecto:'project', versión:'version',
  versiones:'versions', dependencia:'dependency', dependencias:'dependencies',
  inyección:'injection', resolución:'resolution', expira:'expires', expiró:'expired',
  suscripción:'subscription', difusión:'broadcast', vacío:'empty', vacia:'empty',
  llamada:'call', llamadas:'calls', llama:'calls', llaman:'call', notas:'notes',
  nota:'note', roto:'broken', rota:'broken', romper:'break', pierde:'loses',
  perder:'lose', pérdida:'loss', perdida:'loss', ganador:'winner', gana:'wins',
  reemplaza:'replaces', aislar:'isolate', aislado:'isolated', vuelo:'flight',
  remanente:'remainder', resto:'rest', nombre:'name', claves:'keys', clave:'key',
  valores:'values', valor:'value', nuevos:'new', nuevas:'new', nuevo:'new', nueva:'new',
  entradas:'inputs', entrada:'input', salida:'output', salidas:'outputs', siguiente:'next',
  anterior:'previous', terminal:'terminal', interno:'internal', interna:'internal',
  externo:'external', externa:'external', propia:'own', propios:'own', siempre:'always',
  nunca:'never', jamás:'never', requiere2:'', además:'also', ademas:'also', único:'sole',
  única:'sole', canónicos:'canonical', canónico:'canonical', ganan:'win', ganador:'',
  declarados:'declared', declarado:'declared', declarada:'declared', fuentes:'sources',
  fuente:'source', real:'real', real2:'', igual:'same', mismo:'same', misma:'same',
  loop2:'', enlazados:'linked', enlazado:'linked', infinito:'infinite', infinita:'',
  drop2:'', silencioso:'silent', silenciosa:'silent', overflow:'', pendientes2:'',
  determinista:'deterministic', remanente2:'', normal:'', detiene:'stops', procesa:'processes',
  respetando:'respecting', producto:'product', productos:'products', handler2:'', carga:'',
  arranca:'boots', arrancar:'boot', compila:'compiles', compilar:'compile', compilada:'compiled',
  compilado:'compiled', ejecutor:'executor', encadena:'chains', encadenan:'chain',
  encadenado:'chained', cadena:'chain', cadenas:'chains', salto:'hop', saltos:'hops',
  recorridos:'traversed', recorrido:'traversed', copia:'copy', copia2:'', copiado:'copied',
  clonado:'cloned', clones:'clones', vacías:'empty', vacíos:'empty', cola2:'', recursos:'',
  previene:'prevents', previene2:'', superior:'upper', media:'', baja:'', alto:'high',
  alta:'high', niveles:'levels', nivel:'level', estricto:'strict', estricta:'strict',
  gastos:'', abajo:'', arriba:'above', dentro:'inside', fuera:'outside', usa:'uses',
  usan:'use', usado:'used', usada:'used', usando:'using', util:'util', útil:'useful',
  núcleo:'core', núcleo2:'', raíz:'root', raíces:'', llaves:'keys', llave:'key',
  puente:'bridge', puentes:'', envoltorio:'wrapper', envoltura:'wrapper', fachada:'facade',
  fábrica:'factory', fábricas:'', petición:'request', peticiones:'requests', pedido:'',
  pedidos:'',答:'', respuesta2:'', viable:'viable', viables:'', corazón:'core',
  medula:'',StackTrace:'', pila:'', incidente:'', incidentes:'', alertas:'', alerta:'alert'
};
const ES = Object.keys(M).sort((a,b)=>b.length-a.length).map(w=>w.replace(/[.*+?^${}()|[\]]/g,'\\$&'));
const RE = new RegExp(`\\b(${ES.join('|')})\\b`,'giu');
const NA = /[^\x00-\x7F]/;
function tr(comment){
  let prev;
  let out = comment;
  do { prev = out;
    out = out.replace(RE, (m)=>{ const en = M[m.toLowerCase()]; return en ? (/[A-Z]/.test(m[0]) ? en[0].toUpperCase()+en.slice(1) : en) : m; });
  } while (out !== prev);
  out = out.replace(/[^\x00-\x7F]/g, (c)=>({á:'a',é:'e',í:'i',ó:'o',ú:'u',ñ:'n',Á:'A',É:'E',Í:'I',Ó:'O',Ú:'U',Ñ:'N','·':'·','→':'->','←':'<-','§':'sec.','‖':'','↔':'<->'})[c] ?? c);
  return out;
}
function* walk(dir){ for(const e of fs.readdirSync(dir,{withFileTypes:true})){ const p=path.join(dir,e.name); if(e.isDirectory()) yield* walk(p); else if(/\.(ts|js|mjs|cjs)$/.test(e.name)) yield p; } }
for(const root of ['src','test']){ if(!fs.existsSync(root)) continue;
  for(const file of walk(root)){
    const lines = fs.readFileSync(file,'utf8').split('\n');
    let inBlock=false, changed=false;
    for(let i=0;i<lines.length;i++){
      let s=lines[i], comment='';
      if(inBlock){ comment=s; if(s.includes('*/')){ comment=s.slice(0,s.indexOf('*/')+2); inBlock=false; } }
      else {
        const t=s.replace(/(['"`])(?:\\.|(?!\1).)*\1/g,"''").replace(/https?:\/\//g,'');
        if(/^\s*(\/\/|\*|\/\*)/.test(t)) comment=t;
        else if(t.includes(' // ')) comment='//'+t.slice(t.indexOf(' // ')+3);
        if(!inBlock && /\/\*/.test(t) && !/^\s*\//.test(t)===false && /^\s*\/\*/.test(t)) { inBlock=true; }
        else if(!inBlock && /\/\*/.test(t) && !/^\s*(\/\/)/.test(t) && !/^\s*\*/.test(t)) { comment=t; inBlock=true; }
        if(inBlock && comment.includes('*/')===false && s.includes('*/')) inBlock=false;
      }
      if(!comment) continue;
      const t2=NA.test(comment)||RE.test(comment);
      if(!t2) continue;
      const idx = s.lastIndexOf(comment.trim().split('\n')[0]);
      const start = comment===s ? 0 : s.indexOf(comment.trim()[0]==='/'?'/':'*');
      lines[i]=tr(comment)+s.slice(comment.length===s.length?s.length:0);
      if(lines[i]===s) lines[i]=tr(s.length?comment:s)+s.slice(comment.length);
      // simplest: replace comment substring
      lines[i]= s.slice(0, s.length - s.trimStart().length) + tr(s.trimStart());
      changed=true;
    }
    if(changed) fs.writeFileSync(file, lines.join('\n'));
  }
}
console.log('translate-pass done');
