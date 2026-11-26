
/*!
 * Rumo à Posse · Camada de armazenamento (IndexedDB)
 * ---------------------------------------------------------------------------
 * Objetivo: guardar os dados do estudante de forma mais segura e sem o limite
 * de ~5 MB do localStorage, SEM mudar como o resto do app funciona.
 *
 * Como funciona (resumo):
 *   1. O app continua iniciando pelo localStorage (rápido e síncrono).
 *   2. Cada salvamento grava (a) um ESPELHO no localStorage, se couber, e
 *      (b) o dado no IndexedDB (fonte principal e durável).
 *   3. Ao abrir, o IndexedDB é conferido: se tiver dados mais novos que o
 *      localStorage (ex.: o espelho ficou cheio ou foi apagado), o app é
 *      recarregado com eles ("hidratação"). Na primeira vez, o dado do
 *      localStorage é copiado e VERIFICADO antes de qualquer coisa.
 *   4. Pontos de restauração (cópias de segurança) ficam no IndexedDB (até 10).
 *   5. Se o IndexedDB não existir/falhar, tudo continua como antes (localStorage).
 *
 * Estrutura do banco "rumo-posse" (versão 1):
 *   meta       { k:'estado' , rev, t, schema, app, n, sessao, gravadoEm }
 *              { k:'migracao', t, de:'localStorage', resumo }
 *   raiz       { k:'raiz', v:<store sem "concursos">, ordem:[ids dos concursos] }
 *   concursos  { id, v:<dados completos do concurso> }          (1 registro por concurso)
 *   snapshots  { t, motivo, data:<JSON do store> }              (pontos de restauração)
 *
 * Segurança contra perda:
 *   - Nada do localStorage é apagado na migração (o espelho continua).
 *   - Só são regravados os concursos que mudaram (hash), numa única transação.
 *   - Cada gravação confere a "revisão" (rev): se outra aba/janela gravou algo
 *     mais novo, a gravação é BLOQUEADA e o app avisa (nunca sobrescreve em silêncio).
 *   - Ao esconder a página ou fechar, o que estiver pendente é enviado na hora.
 *
 * API pública: window.Armazenamento = { iniciar, salvar, snapshots,
 *   guardarSnapshot, status, estimativa, verificar, pedirPersistencia, descarregar }
 */
(function (global) {
  'use strict';

  var DB_NOME = 'rumo-posse', DB_VER = 1;
  var LS_STORE = 'rumo-posse-v1', LS_SNAP = 'rumo-posse-snap-v1';
  var MAX_SNAPS = 10, MAX_SNAPS_LS = 3, ATRASO_MS = 250;
  var SESSAO = Math.random().toString(36).slice(2) + Date.now().toString(36);

  var db = null, pronto = false, modo = 'localStorage', erro = '';
  var espelhoOk = true, conflito = false, persistente = null;
  var cfg = { getStore: null, resumo: null, aoHidratar: null, aoStatus: null, aoConflito: null, app: '' };
  var hashes = {}, sujo = false, timer = null, fila = Promise.resolve();
  var revGravada = 0, ultimoGravado = 0, snapsSujos = false, canal = null;
  var snaps = lerSnapsLS();

  /* ---------- utilitários ---------- */
  function hash(s) { var x = 0x811c9dc5; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x.toString(16) + '-' + s.length; }
  function clonar(o) { return JSON.parse(JSON.stringify(o)); }
  function avisar() { try { if (cfg.aoStatus) cfg.aoStatus(status()); } catch (e) {} }
  function lerSnapsLS() { try { var l = JSON.parse(localStorage.getItem(LS_SNAP) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
  function ordenarSnaps(l, max) { return l.slice().sort(function (a, b) { return b.t - a.t; }).slice(0, max); }

  /* ---------- acesso ao IndexedDB ---------- */
  function abrir() {
    return new Promise(function (res, rej) {
      if (!global.indexedDB) { rej(new Error('IndexedDB indisponível neste navegador')); return; }
      var r; try { r = indexedDB.open(DB_NOME, DB_VER); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('raiz')) d.createObjectStore('raiz', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('concursos')) d.createObjectStore('concursos', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 't' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('falha ao abrir o IndexedDB')); };
      r.onblocked = function () { rej(new Error('IndexedDB bloqueado por outra janela')); };
    });
  }
  /* executa fn dentro de uma transação; resolve quando ela TERMINA com sucesso */
  function tx(nomes, tipo, fn) {
    return new Promise(function (res, rej) {
      var t, out;
      try { t = db.transaction(nomes, tipo); } catch (e) { rej(e); return; }
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error || new Error('erro na transação')); };
      t.onabort = function () { rej(t.error || new Error(t.__motivo || 'transação cancelada')); };
      try { out = fn(t); } catch (e) { try { t.abort(); } catch (_) {} rej(e); }
    });
  }

  function lerDoDB() {
    var d = { raiz: null, meta: null, conc: [] };
    return tx(['raiz', 'concursos', 'meta'], 'readonly', function (t) {
      t.objectStore('raiz').get('raiz').onsuccess = function (e) { d.raiz = e.target.result; };
      t.objectStore('meta').get('estado').onsuccess = function (e) { d.meta = e.target.result; };
      t.objectStore('concursos').getAll().onsuccess = function (e) { d.conc = e.target.result || []; };
      return d;
    }).then(function (d) {
      if (!d.raiz || !d.meta) return null;
      var s = Object.assign({}, d.raiz.v), porId = {}, ordem = d.raiz.ordem || [];
      d.conc.forEach(function (c) { porId[c.id] = c.v; });
      s.concursos = {};
      ordem.forEach(function (id) { if (porId[id]) { s.concursos[id] = porId[id]; delete porId[id]; } });
      Object.keys(porId).forEach(function (id) { s.concursos[id] = porId[id]; });
      return { store: s, meta: d.meta };
    });
  }

  /* grava o ESTADO ATUAL do app (sempre o mais recente) numa única transação */
  function gravar() {
    var s = cfg.getStore(), ids = Object.keys(s.concursos), rev = s._rev || 0, t0 = s._t || 0;
    var rest = Object.assign({}, s); delete rest.concursos;
    var novos = {}, novosHash = {}, vivos = {};
    ids.forEach(function (id) {
      var js = JSON.stringify(s.concursos[id]), h = hash(js); vivos[id] = 1;
      if (hashes[id] !== h) { novos[id] = JSON.parse(js); novosHash[id] = h; }
    });
    var raizCopia = clonar(rest);
    return tx(['raiz', 'concursos', 'meta'], 'readwrite', function (t) {
      var meta = t.objectStore('meta'), g = meta.get('estado');
      g.onsuccess = function () {
        var cur = g.result;
        if (cur && cur.sessao !== SESSAO && (cur.rev > rev || (cur.rev === rev && cur.t !== t0))) { conflito = true; t.__motivo = 'conflito'; t.abort(); return; }
        t.objectStore('raiz').put({ k: 'raiz', v: raizCopia, ordem: ids });
        var cs = t.objectStore('concursos');
        Object.keys(novos).forEach(function (id) { cs.put({ id: id, v: novos[id] }); });
        cs.getAllKeys().onsuccess = function (e) { (e.target.result || []).forEach(function (k) { if (!vivos[k]) cs.delete(k); }); };
        meta.put({ k: 'estado', rev: rev, t: t0, schema: s.schema || 0, app: cfg.app, n: ids.length, sessao: SESSAO, gravadoEm: Date.now() });
      };
    }).then(function () {
      Object.keys(novosHash).forEach(function (id) { hashes[id] = novosHash[id]; });
      Object.keys(hashes).forEach(function (id) { if (!vivos[id]) delete hashes[id]; });
      revGravada = rev; ultimoGravado = Date.now(); erro = '';
      try { if (canal) canal.postMessage({ rev: rev, sessao: SESSAO }); } catch (e) {}
    });
  }

  function descarregarAgora() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!db || !pronto || !sujo || conflito) return fila;
    sujo = false;
    fila = fila.then(gravar).then(avisar).catch(function (e) {
      if (conflito) { avisar(); try { if (cfg.aoConflito) cfg.aoConflito(); } catch (_) {} return; }
      erro = String((e && e.message) || e); sujo = true; avisar();
    });
    return fila;
  }
  function agendar() { if (timer) clearTimeout(timer); timer = setTimeout(descarregarAgora, ATRASO_MS); }

  /* ---------- API: salvar o store ---------- */
  function salvar(s) {
    if (conflito) return { bloqueado: true, espelho: false, indexeddb: false };   // outra janela gravou algo mais novo: não sobrescreve nada
    s._rev = Math.max(s._rev || 0, revGravada) + 1;   // sempre crescente (mesmo após restaurar um backup antigo)
    s._t = Date.now();
    var gravouEspelho = true;
    try { localStorage.setItem(LS_STORE, JSON.stringify(s)); espelhoOk = true; }
    catch (e) { gravouEspelho = false; espelhoOk = false; }
    if (!gravouEspelho && !global.indexedDB) throw new Error('Sem espaço no armazenamento do navegador');
    if (global.indexedDB) { sujo = true; if (db && pronto) agendar(); }
    return { espelho: gravouEspelho, indexeddb: !!(db && pronto) };
  }

  /* ---------- pontos de restauração ---------- */
  function gravarSnapsDB() {
    var l = snaps.slice();
    return tx(['snapshots'], 'readwrite', function (t) {
      var os = t.objectStore('snapshots');
      l.forEach(function (r) { os.put(r); });
      os.getAllKeys().onsuccess = function (e) { (e.target.result || []).forEach(function (k) { if (!l.some(function (r) { return r.t === k; })) os.delete(k); }); };
    });
  }
  function gravarSnapsLS() {
    var l = snaps.slice(0, MAX_SNAPS_LS);
    for (var k = 0; k < 4; k++) { try { localStorage.setItem(LS_SNAP, JSON.stringify(l)); return true; } catch (e) { if (l.length <= 1) return false; l.pop(); } }
    return false;
  }
  function guardarSnapshot(rec) {
    var ult = snaps.length ? snaps[0].t : 0; if (rec.t <= ult) rec.t = ult + 1;
    snaps.unshift(rec); snaps = ordenarSnaps(snaps, MAX_SNAPS);
    if (db && pronto) { fila = fila.then(gravarSnapsDB).catch(function (e) { erro = String((e && e.message) || e); avisar(); }); return true; }
    if (!global.indexedDB) return gravarSnapsLS();
    snapsSujos = true; return true;   // aguarda o banco abrir; será gravado em seguida
  }
  function mesclarSnaps() {
    return tx(['snapshots'], 'readonly', function (t) {
      var o = { l: [] }; t.objectStore('snapshots').getAll().onsuccess = function (e) { o.l = e.target.result || []; }; return o;
    }).then(function (o) {
      var mapa = {}; o.l.concat(snaps).concat(lerSnapsLS()).forEach(function (r) { if (r && r.t) mapa[r.t] = r; });
      snaps = ordenarSnaps(Object.keys(mapa).map(function (k) { return mapa[k]; }), MAX_SNAPS);
      return gravarSnapsDB();
    }).then(function () { try { localStorage.removeItem(LS_SNAP); } catch (e) {} snapsSujos = false; });
  }

  /* ---------- inicialização ---------- */
  function resumoIgual(a, b) { try { return JSON.stringify(cfg.resumo(a)) === JSON.stringify(cfg.resumo(b)) && Object.keys(a.concursos).join('|') === Object.keys(b.concursos).join('|'); } catch (e) { return false; } }

  function iniciar(opcoes) {
    Object.keys(opcoes || {}).forEach(function (k) { cfg[k] = opcoes[k]; });
    try { if (global.BroadcastChannel) { canal = new BroadcastChannel('rumo-posse-armazenamento'); canal.onmessage = function (e) { if (e.data && e.data.sessao !== SESSAO && e.data.rev > revGravada) { conflito = true; avisar(); try { if (cfg.aoConflito) cfg.aoConflito(); } catch (_) {} } }; } } catch (e) {}
    global.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') descarregarAgora(); });
    global.addEventListener('pagehide', descarregarAgora);
    try { if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(function (p) { persistente = p; avisar(); }); } catch (e) {}
    return abrir().then(function (d) {
      db = d; d.onversionchange = function () { try { d.close(); } catch (e) {} db = null; pronto = false; modo = 'localStorage'; avisar(); };
      return lerDoDB();
    }).then(function (dado) {
      var atual = cfg.getStore();
      if (!dado) {                                   // primeira vez: copia o que está na tela e VERIFICA
        pronto = true; sujo = true;
        return gravar().then(lerDoDB).then(function (rel) {
          if (rel && resumoIgual(rel.store, atual)) {
            modo = 'indexeddb';
            return tx(['meta'], 'readwrite', function (t) { t.objectStore('meta').put({ k: 'migracao', t: Date.now(), de: 'localStorage', resumo: cfg.resumo(atual) }); });
          }
          throw new Error('A conferência da cópia no IndexedDB falhou; o app segue usando o localStorage.');
        }).then(function () { sujo = false; });
      }
      modo = 'indexeddb'; pronto = true;
      if ((dado.meta.rev || 0) > (atual._rev || 0)) {  // o IndexedDB é mais novo: recarrega o app com ele
        Object.keys(dado.store.concursos).forEach(function (id) { hashes[id] = hash(JSON.stringify(dado.store.concursos[id])); });
        revGravada = dado.meta.rev || 0; sujo = false;
        if (cfg.aoHidratar) cfg.aoHidratar(dado.store);
        return;
      }
      revGravada = Math.max(revGravada, dado.meta.rev || 0);
      Object.keys(dado.store.concursos).forEach(function (id) { hashes[id] = hash(JSON.stringify(dado.store.concursos[id])); });
      sujo = true; return descarregarAgora();
    }).then(function () { return mesclarSnaps(); }).then(function () {
      if (sujo) descarregarAgora(); avisar();
    }).catch(function (e) {
      erro = String((e && e.message) || e); pronto = false; modo = 'localStorage';
      if (db) { try { db.close(); } catch (_) {} db = null; }
      gravarSnapsLS(); avisar();
    });
  }

  /* ---------- diagnóstico ---------- */
  function status() {
    return { modo: modo, pronto: pronto, erro: erro, espelhoOk: espelhoOk, conflito: conflito, persistente: persistente, rev: revGravada, ultimoGravado: ultimoGravado, snapshots: snaps.length, banco: DB_NOME + ' v' + DB_VER };
  }
  function estimativa() {
    try { if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().then(function (e) { return { uso: e.usage || 0, quota: e.quota || 0 }; }).catch(function () { return null; }); } catch (e) {}
    return Promise.resolve(null);
  }
  function pedirPersistencia() {
    try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().then(function (p) { persistente = p; avisar(); return p; }); } catch (e) {}
    return Promise.resolve(false);
  }
  /* compara a cópia do IndexedDB com o que está na tela */
  function verificar() {
    if (!db || !pronto) return Promise.resolve({ ok: false, detalhe: 'O IndexedDB não está ativo neste aparelho (o app usa o localStorage).' });
    return (sujo ? descarregarAgora() : fila).then(lerDoDB).then(function (d) {
      if (!d) return { ok: false, detalhe: 'Ainda não há dados gravados no IndexedDB.' };
      var mem = cfg.getStore(), a = cfg.resumo(d.store), b = cfg.resumo(mem), ok = resumoIgual(d.store, mem);
      return { ok: ok, gravado: a, tela: b, rev: d.meta.rev, detalhe: ok ? 'A cópia do IndexedDB é idêntica à da tela.' : 'Há diferença entre a tela e o IndexedDB. Exporte um backup e recarregue o app.' };
    }).catch(function (e) { return { ok: false, detalhe: 'Falha ao conferir: ' + ((e && e.message) || e) }; });
  }

  global.Armazenamento = {
    iniciar: iniciar, salvar: salvar, snapshots: function () { return snaps; }, guardarSnapshot: guardarSnapshot,
    status: status, estimativa: estimativa, verificar: verificar, pedirPersistencia: pedirPersistencia, descarregar: descarregarAgora,
    versao: '1.0'
  };
})(window);

/*!
 * Rumo à Posse · Leitor de edital
 * ---------------------------------------------------------------------------
 * Lê o texto de um edital (PDF já convertido em texto, ou texto colado) e separa:
 *   ✅ certas    matérias aceitas só quando passam por VÁRIAS provas independentes
 *   ❓ duvidas   parecem matérias, mas falta alguma prova (você decide)
 *   🗑️ ignorados  títulos que NÃO são matéria (cargos, datas, regras, anexos…)
 *
 * Uma matéria só é "certa" quando TODAS estas provas passam:
 *   P1 tem pelo menos 3 tópicos de verdade logo abaixo do título
 *   P2 está dentro da seção "Conteúdo programático" (ou o texto colado é só conteúdo)
 *   P3 o título é plausível (curto, sem número/frase, não é cargo, data, taxa, regra…)
 *   P4 o nome é de matéria conhecida OU a numeração é sequencial (1,2,3…) com 5+ tópicos
 *   P5 não existe outra versão da mesma matéria com conteúdo diferente (outro cargo)
 * Nada é gravado aqui: o app mostra o resultado e VOCÊ confirma.
 *
 * API: EditalLeitor.analisar(texto) -> { certas, duvidas, ignorados, resumo, avisos }
 *      EditalLeitor.paraEditais(lista) -> [{ nome, grupos:[{ nome, topicos:[] }] }]
 * Páginas do PDF vêm separadas por "\f" (usado para remover cabeçalhos/rodapés repetidos).
 */
(function (root) {
  'use strict';

  var norm = function (s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); };
  var ITEM_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3}[.)]?|[a-z]\)|[•\-–—·▪●○◦])\s+/i;
  var NOISE_RE = /^(p[aá]gina|p[aá]g\.?)\s*\d+(\s*(de|\/)\s*\d+)?$|^\d{1,3}$|^\d+\s*\/\s*\d+$|^www\.|^https?:|^-+\s*\d+\s*-+$/i;
  var T_MIN = /^(de|da|do|das|dos|e|em|para|a|o|as|os|no|na|nos|nas|ao|aos|com|por)$/;

  /* matérias conhecidas (comparação sem acento e sem maiúsculas) */
  var CONHECIDAS = /^(lingua\b|portugues|redacao|interpretacao de texto|raciocinio|matematica|estatistica|informatica|nocoes\b|direito\b|direitos\b|legislacao|estatuto|lei organica|conhecimentos? (gerais|basicos|especificos|pedagogicos|regionais|de|sobre)|atualidades|historia|geografia|etica|fisica|quimica|biologia|ciencias|ingles|lingua inglesa|espanhol|lingua espanhola|administracao|contabilidade|economia|arquivologia|auditoria|gestao|criminologia|medicina legal|sociologia|filosofia|literatura|sistemas operacionais|banco de dados|redes de computadores|seguranca da informacao|programacao|engenharia|enfermagem|saude publica|pedagogia|didatica|educacao|psicologia|servico social|primeiros socorros|politicas publicas|realidade|cidadania|direitos humanos)/;
  var GRUPO_RE = /^(conhecimentos (basicos|gerais|especificos)|parte [ivx\d]+|nivel (fundamental|medio|superior)|prova (objetiva|discursiva)|bloco [ivx\d]+|modulo [ivx\d]+|disciplinas? (basicas?|especificas?)|grupo [ivx\d]+)\b/;
  /* títulos que NÃO são matéria */
  var RUIDO_RE = /(cargos?\b|emprego|funcao|\bvagas?\b|remuneracao|salario|inscric|edital|anexo|resultado|recursos?\b|prazo|cronograma|calendario|\bdatas?\b|taxa|isencao|criterios?|aprovacao|eliminacao|classificacao|disposic|etapas?\b|\bfase\b|banca|organizadora|requisitos|atribuic|jornada|local de|quadro|tabela|observac|legenda|sumario|indice|bibliografia|referencias|apresentacao|considerand|processo seletivo|concurso publico|prefeitura|governo|secretaria|municipio de|estado d[eo]|republica|ministerio|assinatura|presidente|comissao|diario oficial|publicac|convocac|nomeac|\bposse\b|estagio probatorio|aptidao fisica|exame (medico|toxicologico|psicotecnico)|investigacao social|curso de formacao|heteroidentificacao|candidatos?|\bnotas?\b|pontuac|\bpeso\b|\btotal\b|requerimento|declaracao|modelo|\bdas? provas?\b|dos? recursos?|devera|sera\b|serao|podera)/;
  var CARGO_CTX_RE = /^(cargos?|emprego|fun[cç][aã]o)\s*(n[º°o]\s*)?\d*\s*[:\-–]\s*\S|^(para|conte[uú]do (program[aá]tico )?(d[oa]s?|para))\s+(o\s+)?(cargo|emprego)/i;
  var MARC_RE = /(conte[uú]dos?\s+program[aá]ticos?|programa\s+das?\s+provas?|conte[uú]dos?\s+das?\s+provas?|objetos?\s+de\s+avalia[cç][aã]o|das\s+mat[eé]rias?\s+e\s+dos\s+conte[uú]dos)/gi;

  var SIGLAS = /^(prf|pf|pm|pc|pcdf|sus|ctb|cf|clt|stf|stj|tcu|onu|oab|pgr|ibge|eca|ldb|lgpd|lrf|tic|ti|df|rj|sp|mg|ma|pi|ce|pe|ba|pa|am|rs|sc|pr|go|mt|ms|es|rn|pb|al|se|to|ro|ac|ap|rr)$/;
  function cap(w) { return w.charAt(0).toUpperCase() + w.slice(1); }
  function titulo(s) {
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().split(' ').map(function (w, i) {
      if (/^[ivxlc]{1,4}$/.test(w) && i > 0) return w.toUpperCase();
      if (SIGLAS.test(w)) return w.toUpperCase();
      if (i > 0 && T_MIN.test(w)) return w;
      return w.split('-').map(cap).join('-');
    }).join(' ');
  }
  function normHead(s) { return s.replace(/^[IVXLC]+\s*[-–.)]\s+/, '').replace(/^\d+\s*[-–.)]\s+/, '').replace(/[\s:.\-–]+$/, '').trim(); }
  function conhecida(nome) { return CONHECIDAS.test(norm(nome)); }

  /* ---------- 1) limpeza do texto ---------- */
  function limpar(raw) {
    var t = String(raw || '').replace(/\r/g, '').replace(/\u00ad/g, '').replace(/[ \t\u00a0]+/g, ' ');
    t = t.replace(/([A-Za-zÀ-ÿ])-\n([a-zà-ÿ])/g, '$1$2');                        // palavra quebrada no fim da linha
    var paginas = t.split('\f').map(function (p) { return p.split('\n').map(function (s) { return s.trim(); }); });
    if (paginas.length >= 4) {                                                     // remove cabeçalho/rodapé repetido nas páginas
      var cont = {}, chave = function (l) { return norm(l).replace(/\d+/g, '#'); };
      paginas.forEach(function (p) {
        var ls = p.filter(Boolean), bordas = ls.slice(0, 2).concat(ls.slice(-2)), vistos = {};
        bordas.forEach(function (l) { var k = chave(l); if (!vistos[k]) { vistos[k] = 1; cont[k] = (cont[k] || 0) + 1; } });
      });
      var lim = Math.max(3, Math.ceil(paginas.length * 0.5));
      paginas = paginas.map(function (p) {
        var ls = p.filter(Boolean), n = ls.length;
        return ls.filter(function (l, i) { return !((i < 2 || i >= n - 2) && cont[chave(l)] >= lim && !ITEM_RE.test(l)); });
      });
    } else paginas = paginas.map(function (p) { return p.filter(Boolean); });
    return { texto: paginas.map(function (p) { return p.join('\n'); }).join('\n'), numPaginas: paginas.length };
  }

  /* ---------- 2) onde fica o conteúdo programático ---------- */
  function contaItens(seg) {   // itens em linhas separadas + itens "em linha" (ex.: "MATÉRIA: 1 Tópico. 2 Tópico.")
    var linhas = seg.split('\n').reduce(function (a, l) { return a + (ITEM_RE.test(l.trim()) ? 1 : 0); }, 0);
    var emLinha = (seg.match(/[.;:]\s+\d{1,2}(?:\.\d{1,2})*\s+(?=[A-ZÀ-Ý])/g) || []).length;
    return linhas + emLinha;
  }
  function regiao(t) {
    var m, pos = []; MARC_RE.lastIndex = 0;
    while ((m = MARC_RE.exec(t))) pos.push(m.index);
    if (!pos.length) return { texto: t, marcada: false, janelas: 0 };
    var jan = pos.map(function (p, i) {
      var fim = Math.min(i + 1 < pos.length ? pos[i + 1] : t.length, p + 90000), seg = t.slice(p, fim), re = /\n\s*ANEXO\s+[IVXLC\d]+[^\n]*/gi, a, stop = -1;
      while ((a = re.exec(seg))) { if (a.index > 200 && !/conte[uú]do|program|mat[eé]ria/i.test(a[0])) { stop = a.index; break; } }
      if (stop > 0) seg = seg.slice(0, stop);
      return { seg: seg, n: contaItens(seg) };
    });
    var boas = jan.filter(function (j) { return j.n >= 8; });
    if (!boas.length) { var best = jan.slice().sort(function (a, b) { return b.n - a.n; })[0]; if (best.n >= 3) boas = [best]; }
    if (!boas.length) return { texto: t, marcada: false, janelas: 0 };
    return { texto: boas.map(function (j) { return j.seg; }).join('\n'), marcada: true, janelas: boas.length };
  }

  /* ---------- 3) títulos ---------- */
  function parecTitulo(l, next, cur) {
    if (!l || l.length > 110 || ITEM_RE.test(l)) return false;
    var c = normHead(l); if (c.length < 4) return false;
    var letras = c.replace(/[^A-Za-zÀ-ÿ]/g, ''); if (letras.length < 4) return false;
    var up = letras.replace(/[^A-ZÀ-Ý]/g, '').length / letras.length, palavras = c.split(' ').length, temItem = !!next && ITEM_RE.test(next);
    if (up >= 0.85 && palavras <= 10) return temItem || conhecida(c) || !cur || cur.itens.length === 0;   // no meio de uma lista, caixa alta sem tópicos abaixo é continuação
    if (conhecida(c) && palavras <= 8 && !/[;,]$/.test(l) && (/:$/.test(l) || temItem)) return true;
    if (/:$/.test(l) && palavras <= 8 && temItem && /^[A-ZÀ-Ý]/.test(c)) return true;
    return false;
  }

  /* ---------- 4) montar blocos (título + tópicos) ---------- */
  function blocos(linhas) {
    var out = [], cur = null, grupo = 'Conteúdo', cargo = '', last = null;
    var abrir = function (bruto, linha) { cur = { bruto: bruto, nome: titulo(normHead(bruto)), grupo: grupo, cargo: cargo, itens: [], nums: [], linha: linha }; out.push(cur); last = null; };
    var add = function (s) {
      if (!cur) return;
      var mi = s.match(/^(\d{1,2})[.)]?\s/);
      if (ITEM_RE.test(s)) { if (mi) cur.nums.push(parseInt(mi[1], 10)); last = { t: s.replace(ITEM_RE, '').trim() }; cur.itens.push(last); }
      else if (last && !/[.;]$/.test(last.t) && (/^[a-zà-ÿ(,]/.test(s) || /[,\-–(]$/.test(last.t) || /\b(de|da|do|das|dos|e|em|para|com|ou|a|o|à|ao|no|na|por|sobre|entre|que)$/i.test(last.t) || last.t.length < 25)) last.t += ' ' + s;
      else { last = { t: s }; cur.itens.push(last); }
    };
    for (var i = 0; i < linhas.length; i++) {
      var l = linhas[i], next = linhas[i + 1] || '';
      if (CARGO_CTX_RE.test(l) && l.length < 130 && !ITEM_RE.test(l)) { cargo = l.replace(/[\s:.\-–]+$/, ''); cur = null; last = null; continue; }
      if (/^(anexo [ivxlc\d]+\s*[-–.:]?\s*)?(do |dos )?(conteudos? programaticos?|programa das provas?)\b/.test(norm(l)) && l.length < 110 && !ITEM_RE.test(l)) { cur = null; last = null; continue; }
      var n = norm(normHead(l));
      if (GRUPO_RE.test(n) && l.length < 80 && !ITEM_RE.test(l) && !ITEM_RE.test(next) && !/:\s*\S/.test(l)) { grupo = titulo(normHead(l)); cur = null; last = null; continue; }
      var inl = l.match(/^([A-ZÀ-Ý][A-ZÀ-Ý0-9 ,\/\-–()ªº.&]{3,80}?):\s+(\S.*)$/) || l.match(/^([A-ZÀ-Ý][^:;.\d]{3,70}):\s+(\S.*)$/);
      if (inl && inl[1].split(' ').length <= 9 && (parecTitulo(inl[1] + ':', '1 x', cur) || conhecida(inl[1]))) { abrir(inl[1], i); add(inl[2]); continue; }
      if (parecTitulo(l, next, cur)) { abrir(l, i); continue; }
      if (!cur) continue;
      add(l);
    }
    return out;
  }

  function limparTopicos(itens) {
    var tops = [], seen = {};
    itens.forEach(function (o) {
      var s = o.t.replace(/\s+/g, ' ').replace(/-\s+(?=[a-zà-ÿ])/g, '').trim(), parts = [s], nFr = (s.match(/\.\s+(?=[A-ZÀ-Ý])/g) || []).length;
      if (s.length > 160 && s.indexOf(';') > -1) parts = s.split(/;\s*/);
      else if (nFr >= 2 || s.length > 160) parts = s.split(/\.\s+(?=[A-ZÀ-Ý])/);
      parts.forEach(function (x) {
        x = x.replace(/[;.\s]+$/, '').trim();
        if (x.length < 5 || x.length > 400) return;
        x = x.charAt(0).toUpperCase() + x.slice(1);
        var k = norm(x); if (seen[k]) return; seen[k] = 1; tops.push(x);
      });
    });
    return tops.slice(0, 200);
  }

  function nomePlausivel(nome) {
    var n = norm(nome), pal = nome.split(' ').filter(Boolean).length;
    if (pal < 1 || pal > 8 || nome.length < 4 || nome.length > 70) return 'título longo demais para ser matéria';
    if (/[0-9]/.test(nome.replace(/\b[IVX]+\b/g, ''))) return 'título com número';
    if (/[;,]$/.test(nome) || /[%€$]|r\$/.test(nome)) return 'título com sinais de texto corrido';
    return '';
  }
  function jaccard(a, b) {
    var A = {}, B = {}, i = 0, inter = 0;
    a.forEach(function (x) { A[norm(x)] = 1; }); b.forEach(function (x) { B[norm(x)] = 1; });
    var ka = Object.keys(A), kb = Object.keys(B); ka.forEach(function (k) { if (B[k]) inter++; });
    var uni = ka.length + kb.length - inter; return uni ? inter / uni : 1;
  }

  /* ---------- 5) análise completa ---------- */
  function analisar(raw) {
    var avisos = [], L = limpar(raw), t = L.texto, tamanho = t.replace(/\s/g, '').length;
    if (tamanho < 80) return { certas: [], duvidas: [], ignorados: [], avisos: ['O texto é muito curto para ser um edital.'], resumo: { paginas: L.numPaginas, caracteres: tamanho, regiaoMarcada: false, certas: 0, duvidas: 0, ignorados: 0 } };
    if (L.numPaginas > 1 && tamanho / L.numPaginas < 200) avisos.push('O PDF parece ser uma imagem escaneada (quase não há texto). Use um PDF com texto selecionável ou cole o texto.');
    var R = regiao(t); if (!R.marcada) avisos.push('Não encontrei a seção "Conteúdo programático": analisei o texto inteiro, então só aceito como certas as matérias muito claras.');
    var txt = R.texto.replace(/([.;])\s+(\d{1,2}(?:\.\d{1,2})*)\s+(?=[A-ZÀ-Ý])/g, '$1\n$2 ');
    var linhas = txt.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s && !NOISE_RE.test(s); });
    var itensTxt = linhas.filter(function (l) { return ITEM_RE.test(l); }).length, parecConteudo = R.marcada || (t.length <= 30000 && itensTxt / Math.max(1, linhas.length) >= 0.25);
    var bl = blocos(linhas), certas = [], duvidas = [], ignorados = [];

    bl.forEach(function (b) {
      b.topicos = limparTopicos(b.itens);
      var conh = conhecida(b.nome), motivoNome = nomePlausivel(b.nome), ruido = !conh && RUIDO_RE.test(norm(b.nome));
      if (ruido) { ignorados.push({ texto: b.bruto, motivo: 'não é matéria (parece regra, cargo, data ou anexo do edital)' }); return; }
      if (motivoNome) { ignorados.push({ texto: b.bruto, motivo: motivoNome }); return; }
      if (b.topicos.length === 0) { ignorados.push({ texto: b.bruto, motivo: 'título sem tópicos abaixo' }); return; }
      b.seq1 = b.nums.length >= 3 && b.nums[0] === 1 && b.nums[1] === 2 && b.nums[2] === 3;
      b.conhecida = conh; b.motivos = []; b.faltas = [];
      if (b.topicos.length >= 3) b.motivos.push(b.topicos.length + ' tópicos abaixo do título'); else b.faltas.push('só ' + b.topicos.length + ' tópico(s) (mínimo 3)');
      if (parecConteudo) { if (R.marcada) b.motivos.push('dentro do Conteúdo programático'); } else b.faltas.push('fora de uma seção de conteúdo programático');
      if (conh) b.motivos.push('nome de matéria conhecida');
      else if (b.seq1 && b.topicos.length >= 5 && R.marcada) b.motivos.push('tópicos numerados em sequência (1, 2, 3…)');
      else b.faltas.push('nome não reconhecido e sem numeração sequencial com 5+ tópicos');
      (b.faltas.length ? duvidas : certas).push(b);
    });

    /* P5: mesma matéria repetida (ex.: um bloco por cargo) */
    var porNome = {}; certas.concat(duvidas).forEach(function (b) { var k = norm(b.nome); (porNome[k] = porNome[k] || []).push(b); });
    var remover = [];
    Object.keys(porNome).forEach(function (k) {
      var g = porNome[k]; if (g.length < 2) return;
      var iguais = g.every(function (b) { return jaccard(b.topicos, g[0].topicos) >= 0.9; });
      if (iguais) { g[0].repetida = g.length; g[0].motivos.push('aparece ' + g.length + ' vezes com o mesmo conteúdo (juntei)'); g.slice(1).forEach(function (b) { remover.push(b); }); }
      else g.forEach(function (b) { b.faltas.push('aparece mais de uma vez com conteúdo diferente' + (b.cargo ? ' (' + b.cargo + ')' : ' (outro cargo?)')); });
    });
    var todas = certas.concat(duvidas).filter(function (b) { return remover.indexOf(b) < 0; });
    certas = todas.filter(function (b) { return !b.faltas.length; });
    duvidas = todas.filter(function (b) { return b.faltas.length; });
    var fmt = function (b, i, pre) { return { id: pre + i, nome: b.nome, grupo: b.grupo, cargo: b.cargo || '', topicos: b.topicos, motivos: b.motivos.slice(), faltas: b.faltas.slice(), linha: b.linha }; };
    var C = certas.map(function (b, i) { return fmt(b, i, 'c'); }), D = duvidas.map(function (b, i) { return fmt(b, i, 'd'); });
    if (!C.length && !D.length) avisos.push('Não encontrei matérias com tópicos. Tente colar só o trecho do conteúdo programático.');
    return { certas: C, duvidas: D, ignorados: ignorados.slice(0, 80), avisos: avisos, resumo: { paginas: L.numPaginas, caracteres: tamanho, regiaoMarcada: R.marcada, certas: C.length, duvidas: D.length, ignorados: ignorados.length } };
  }

  /* junta a seleção do usuário no formato que o app já usa; mesmo nome = une os tópicos */
  function paraEditais(lista) {
    var out = [], idx = {};
    (lista || []).forEach(function (m) {
      var nome = (m.nome || '').trim(); if (!nome) return; var k = norm(nome);
      if (idx[k] === undefined) { idx[k] = out.length; out.push({ nome: nome, grupos: [{ nome: m.grupo || 'Conteúdo', topicos: [] }] }); }
      var alvo = out[idx[k]].grupos[0].topicos, vistos = {}; alvo.forEach(function (x) { vistos[norm(x)] = 1; });
      (m.topicos || []).forEach(function (x) { if (!vistos[norm(x)]) { vistos[norm(x)] = 1; alvo.push(x); } });
    });
    return out;
  }

  var API = { analisar: analisar, paraEditais: paraEditais, versao: '1.0', _interno: { limpar: limpar, regiao: regiao, blocos: blocos } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.EditalLeitor = API;
})(typeof window !== 'undefined' ? window : this);



/* ═══ Helpers de escolha e nota (carregados com o núcleo: são usados já na inicialização) ═══ */
/* ═══ Meus concursos: só os que a pessoa escolheu · barra de progresso · nota da prova ═══
   - Cada concurso tem marcador `chosen`. Quem já tem dados continua vendo seus concursos (nada é apagado).
   - Pré-cadastrados sem nenhum dado ficam fora da lista até a pessoa escolher (busca, novo concurso ou "Recuperar").
   - Nota oficial e status "realizada" ficam em info.notaProva / info.provaRealizada, por concurso. */

/* concurso tem dados do usuário? (histórico, erros, simulados, revisões, estudo, prova) */
function temDadosUsuario(c) {
  const d = c.data || {};
  return !!((d.historico || []).length || (d.erros || []).length || (d.simulados || []).length ||
    (d.revisoes || []).length || Object.keys(d.state || {}).length || (c.info && (c.info.provaRealizada || c.info.notaProva != null)));
}
/* migração preguiçosa e segura: concurso antigo sem marcador ganha o valor com base nos dados existentes */
/* regra: nunca grava "não escolhido". Um concurso vira escolhido quando a pessoa o escolhe OU quando recebe qualquer dado.
   Depois disso fica para sempre (não some ao recarregar). */
/* migração única, por registro: concurso ANTIGO não tem o campo `chosen`. Esses são os que a pessoa já via:
   continuam visíveis. Concursos criados pela versão nova sempre trazem chosen: true ou false. */
function migrarEscolhaUmaVez() {
  if (store.escolhaMig || !store.concursos) return;
  Object.keys(store.concursos).forEach(id => { if (store.concursos[id].chosen === undefined) store.concursos[id].chosen = true; });
  store.escolhaMig = 1;
}
function isEscolhido(id) {
  migrarEscolhaUmaVez();
  const c = store.concursos[id]; if (!c) return false;
  if (c.chosen === true) return true;
  if (temDadosUsuario(c)) { c.chosen = true; return true; }
  return false;
}
/* status da prova: 'realizada' | 'faltou' (manual) ou null (automático pela data) */
function provaStatus(c) {
  const s = c.info && c.info.provaStatus;
  if (s === 'realizada' || s === 'faltou') return s;
  if (c.info && c.info.provaRealizada === true) return 'realizada';   // compatibilidade com a versão anterior
  return null;
}
/* realizada = marcada como realizada OU (sem marcação manual) a data da prova já passou */
function provaRealizada(c) {
  const s = provaStatus(c); if (s === 'realizada') return true; if (s === 'faltou') return false;
  const d = daysTo(c.info ? c.info.dataProva : ''); return d !== null && d < 0;
}
/* há status definido (manual) ou a data já passou: o chip do cartão mostra realizada / não realizada */
function provaFinal(c) { return provaStatus(c) !== null || provaRealizada(c); }
/* chip do cartão quando o status está definido */
function provaChip(c) {
  if (provaStatus(c) === 'faltou') return '<span class="chip red">não realizada</span>';
  return '<span class="chip grn">realizada</span>';
}
function fmtNota(n) { return String(n).replace('.', ','); }
/* texto da nota no cartão */
function notaTexto(c) {
  const inf = c.info || {};
  if (provaStatus(c) === 'faltou') return 'não realizada';
  if (inf.notaProva !== undefined && inf.notaProva !== null && inf.notaProva !== '') {
    const cor = Number(inf.notaCorte) || 0;
    let t = 'nota ' + fmtNota(inf.notaProva);
    if (cor) t += ' · corte ' + fmtNota(cor) + (Number(inf.notaProva) >= cor ? ' ✔' : ' ✖');
    return t;
  }
  if (provaRealizada(c)) return 'nota: a lançar';
  const L = (c.data && c.data.simulados) || [];
  if (!L.length) return 'nota: —';
  const ult = L.slice().sort((a, b) => a.date < b.date ? -1 : 1).pop(), n = simScore(ult), cor = Number(inf.notaCorte) || 0;
  return 'nota ' + n + '% (simulado)' + (cor ? ' · corte ' + cor + '%' : '');
}
/* botão no cartão para lançar a nota (só depois da prova) */
function provaBtn(c) {
  if (!provaFinal(c)) return '';
  const s = provaStatus(c), tem = c.info && c.info.notaProva !== undefined && c.info.notaProva !== null && c.info.notaProva !== '';
  const rotulo = s === 'faltou' ? 'Prova: não realizada' : tem ? 'Editar nota da prova' : 'Lançar nota da prova';
  return `<button class="mini-btn" style="margin-top:8px" onclick="event.stopPropagation();openNotaProva('${c.id}')">✏️ ${rotulo}</button>`;
}
let _nprId = null;
function npStatusSel() { const r = document.querySelector('input[name="npr-status"]:checked'); return r ? r.value : 'auto'; }
function npStatusUI() { const f = npStatusSel() === 'faltou'; const n = document.getElementById('npr-nota'); if (n) { n.disabled = f; n.style.opacity = f ? '.5' : '1'; } }
function openNotaProva(id) {
  const c = store.concursos[id]; if (!c) return; _nprId = id;
  document.getElementById('npr-titulo').textContent = c.info.concurso || 'Concurso';
  const s = provaStatus(c) || 'auto';
  document.querySelectorAll('input[name="npr-status"]').forEach(r => { r.checked = (r.value === s); r.onchange = npStatusUI; });
  document.getElementById('npr-nota').value = (c.info.notaProva !== undefined && c.info.notaProva !== null) ? c.info.notaProva : '';
  document.getElementById('npr-corte').value = c.info.notaCorte || '';
  npStatusUI(); document.getElementById('npr-modal').classList.add('open');
}
function saveNotaProva() {
  const c = store.concursos[_nprId]; if (!c) return;
  const st = npStatusSel();
  if (st === 'auto') delete c.info.provaStatus; else c.info.provaStatus = st;
  delete c.info.provaRealizada;
  if (st === 'faltou') {
    delete c.info.notaProva;
  } else {
    const nota = parseFloat(String(document.getElementById('npr-nota').value).replace(',', '.'));
    if (!isNaN(nota) && nota >= 0) { c.info.notaProva = nota; if (st === 'auto') c.info.provaStatus = 'realizada'; }   // nota lançada = a prova aconteceu
    else { delete c.info.notaProva; if (st === 'realizada') { showToast('⚠️', 'Informe a nota obtida na prova.'); return; } }
  }
  const corteTxt = String(document.getElementById('npr-corte').value).replace(',', '.').trim();
  if (corteTxt !== '') c.info.notaCorte = parseFloat(corteTxt) || 0;
  persist(); document.getElementById('npr-modal').classList.remove('open');
  renderConcursoSelect(); renderHoje();
  showToast('🏁', st === 'faltou' ? 'Marcado como não realizada.' : 'Prova atualizada.');
}


// ═══════════════════════════════════════════════════════
//  CONFIGURAÇÃO DO CONCURSO — EDITE AQUI
// ═══════════════════════════════════════════════════════
let CONCURSO_INFO={concurso:"PM MA - Polícia Militar do Estado do Maranhão",cargo:"Soldado",banca:"Cebraspe",dataProva:"2026-10-11"};
const DISC_CORES = ['#C8102E','#0D134C','#E255BE','#A7C3BB','#EFBD7B','#AFE8D0','#7c3aed','#BAFF38','#0d9488','#ea580c'];

// ═══════════════════════════════════════════════════════
//  DADOS DO EDITAL — EDITE AQUI
// ═══════════════════════════════════════════════════════
let EDITAL=[{"id":"lingua-portuguesa","nome":"LÍNGUA PORTUGUESA","grupos":[{"nome":"Compreensão, Interpretação e Tipologia Textual","topicos":["1 Compreensão e interpretação de textos de gêneros variados.","2 Reconhecimento de tipos e gêneros textuais."]},{"nome":"Ortografia e Coesão Textual","topicos":["3 Domínio da ortografia oficial.","4 Domínio dos mecanismos de coesão textual.","4.1 Emprego de elementos de referenciação, substituição e repetição, de conectores e de outros elementos de sequenciação textual.","4.2 Emprego de tempos e modos verbais."]},{"nome":"Estrutura Morfossintática","topicos":["5 Domínio da estrutura morfossintática do período.","5.1 Emprego das classes de palavras.","5.2 Relações de coordenação entre orações e entre termos da oração.","5.3 Relações de subordinação entre orações e entre termos da oração.","5.4 Emprego dos sinais de pontuação.","5.5 Concordância verbal e nominal.","5.6 Regência verbal e nominal.","5.7 Emprego do sinal indicativo de crase.","5.8 Colocação dos pronomes átonos."]},{"nome":"Reescrita e Semântica","topicos":["6 Reescrita de frases e parágrafos do texto.","6.1 Significação das palavras.","6.2 Substituição de palavras ou de trechos de texto.","6.3 Reorganização da estrutura de orações e de períodos do texto.","6.4 Reescrita de textos de diferentes gêneros e níveis de formalidade."]}]},{"id":"historia-do-brasil","nome":"HISTÓRIA DO BRASIL","grupos":[{"nome":"Formação, Oligarquias e Era Vargas","topicos":["1 A contribuição dos índios e negros para a formação do Brasil; A formação do Brasil Contemporâneo; A República Velha e as estruturas oligárquicas; Economia e Sociedade: o café e estratificação social; A Revolução de 1930; A Era Vargas: política, economia e sociedade; O período democrático (1945 a 1964)."]},{"nome":"Democracia, Ditadura Militar e Redemocratização","topicos":["2 A redemocratização do Estado e a constituição de 1946.","3 A política de industrialização do governo JK.","5 A crisis do regime democrático.","6 O golpe de 1964.","7 A crise do regime militar e a redemocratização."]},{"nome":"Território e Organização do Estado","topicos":["8 O Brasil político: nação e território.","9 Organização do Estado Brasileiro.","10 As Constituições."]}]},{"id":"historia-do-maranhao","nome":"HISTÓRIA DO MARANHÃO","grupos":[{"nome":"Período Colonial e Invasões Estrangeiras","topicos":["1 França equinocial: expedição de Daniel de La Touche.","2 Fundação de São Luís.","3 Batalha de Guaxenduba.","4 Capitães‐mores do Maranhão.","5 Invasão holandesa.","6 Expulsão dos holandeses.","7 Estado do Maranhão e Grão‐Pará: Revolta de Bequimão (causas e objetivos da revolta); Companhia de Comércio do Maranhão e Grão‐Pará."]},{"nome":"Império, Independência e Revoltas Sociais","topicos":["8 Período do Império: adesão do Maranhão.","9 Independência do Brasil.","10 Causas da não adesão: Batalha do Jenipapo.","11 Balaiada: caracterização e causas do movimento."]},{"nome":"Período Republicano até a Contemporaneidade","topicos":["12 Período Republicano: adesão do Maranhão à República.","13 Revolução de 1930 no Maranhão.","14 Principais fatos políticos, econômicos e sociais ocorridos no Maranhão, na segunda metade do século XX."]}]},{"id":"geografia-do-brasil","nome":"GEOGRAFIA DO BRASIL","grupos":[{"nome":"Espaço Econômico e Infraestrutura","topicos":["1 A integração ao processo de internacionalização da economia.","2 O processo de industrialização e suas repercussões na organização do espaço.","3 A rede brasileira de transportes e sua evolução.","4 A estrutura urbana brasileira e as grandes metrópoles."]},{"nome":"Espaço Agrário e Demografia","topicos":["5 A dinâmica das fronteiras agrícolas e sua expansão para o Centro‐Oeste e a Amazônia.","6 A evolução da estrutura fundiária e problemas demográficos.","7 Os movimentos migratórios internos.","8 A população brasileira: distribuição dos efetivos demográficos no território nacional; evolução do crescimento ao longo do século XX; estrutura etária."]},{"nome":"Integração Setorial e Recursos Naturais","topicos":["8 Integração entre indústria, estrutura urbana, rede de transportes e setor agrícola no Brasil.","9 Recursos naturais: aproveitamento, desperdício e política de conservação de recursos naturais."]}]},{"id":"geografia-do-maranhao","nome":"GEOGRAFIA DO MARANHÃO","grupos":[{"nome":"Aspectos Físicos e Ambientais","topicos":["1 Localização do Estado do Maranhão: superfície; limites; linhas de fronteira; pontos extremos; áreas de proteção ambiental (APA).","2 Parques nacionais.","3 Climas do Maranhão: pluviosidade e temperatura.","4 Geomorfologia.","4.1 Classificação do relevo maranhense: planaltos, planícies e baixadas.","5 Características dos rios maranhenses: bacias dos rios limítrofes (Parnaíba, Gurupi e Tocantins‐Araguaia).","6 Bacias dos rios genuinamente maranhenses.","7 Principais formações vegetais: floresta, cerrado e cocais."]},{"nome":"Geografia Humana e Econômica","topicos":["8 Geografia da população: população absoluta; densidade demográfica; povoamento; movimentos populacionais.","9 Agricultura maranhense: caracterização e principais produtos agrícolas; caracterização da pecuária.","10 Extrativismo: vegetal, animal e mineral.","11 Parque industrial: indústrias de base e indústrias de transformação.","12 Setor terciário: comércio, telecomunicações, transportes.","13 Malha viária.","14 Portos e aeroportos.","15 Cultura maranhense."]}]},{"id":"nocoes-de-informatica-somente-para-os-cargos-de-2-a-11-soldado-do-quadro-de-pracas-musicos-qpmus","nome":"NOÇÕES DE INFORMÁTICA (SOMENTE PARA OS CARGOS DE 2 A 11: SOLDADO DO QUADRO DE PRAÇAS MÚSICOS (QPMus)","grupos":[{"nome":"Sistemas Operacionais, Suítes de Escritório e Arquivos","topicos":["1 Noções de sistema operacional (ambientes Linux e Windows).","2 Edição de textos, planilhas e apresentações (ambientes Microsoft Office e BrOffice).","4 Conceitos de organização e de gerenciamento de informações, arquivos, pastas e programas."]},{"nome":"Redes de Computadores e Internet","topicos":["3 Redes de computadores.","3.1 Conceitos básicos, ferramentas, aplicativos e procedimentos de Internet e intranet.","3.2 Programas de navegação (Microsoft Internet Explorer, Mozilla Firefox e Google Chrome).","3.3 Programas de correio eletrônico (Outlook Express e Mozilla Thunderbird).","3.4 Sítios de busca e pesquisa na Internet.","3.5 Grupos de discussão.","3.6 Redes sociais.","3.7 Computação na nuvem (cloud computing)."]},{"nome":"Segurança da Informação","topicos":["5 Segurança da informação.","5.1 Procedimentos de segurança.","5.2 Noções de vírus, worms e pragas virtuais.","5.3 Aplicativos para segurança (antivírus, firewall, anti‐spyware etc.).","5.4 Procedimentos de backup.","5.5 Armazenamento de dados na nuvem (cloud storage)."]}]},{"id":"legislacao-pertinente-a-pmma","nome":"LEGISLAÇÃO PERTINENTE À PMMA","grupos":[{"nome":"Legislação Federal e Estadual Aplicada","topicos":["1 Decreto nº 88.777/1983 e suas alterações (regulamento das polícias militares e dos corpos de bombeiros militares).","2 Decreto‐lei nº 1.001/1969 e suas alterações (Código Penal Militar).","3 Lei estadual nº 6.513/1995 e suas alterações (Estatuto dos Policiais Militares do Estado do Maranhão).","4 Lei estadual nº 10.823/2018 e suas alterações (criação e transformação de organizações policiais militares da Polícia Militar do Maranhão).","5 Lei nº 14.751/2023."]}]},{"id":"legislacao-institucional","nome":"LEGISLAÇÃO INSTITUCIONAL","grupos":[{"nome":"Estatuto Estadual","topicos":["Lei estadual nº 6.513/1995 e suas alterações (Estatuto dos Policiais Militares do Estado do Maranhão)."]}]},{"id":"nocoes-de-informatica","nome":"NOÇÕES DE INFORMÁTICA","grupos":[{"nome":"Sistemas Operacionais, Suítes de Escritório e Arquivos","topicos":["1 Noções de sistema operacional (ambientes Linux e Windows).","2 Edição de textos, planilhas e apresentações (ambientes Microsoft Office e BrOffice).","4 Conceitos de organização e de gerenciamento de informações, arquivos, pastas e programas."]},{"nome":"Redes de Computadores e Internet","topicos":["3 Redes de computadores.","3.1 Conceitos básicos, ferramentas, aplicativos e procedimentos de Internet e intranet.","3.2 Programas de navegação (Microsoft Internet Explorer, Mozilla Firefox e Google Chrome).","3.3 Programas de correio eletrônico (Outlook Express e Mozilla Thunderbird).","3.4 Sítios de busca e pesquisa na Internet.","3.5 Grupos de discussão.","3.6 Redes sociais.","3.7 Computação na nuvem (cloud computing)."]},{"nome":"Segurança da Informação","topicos":["5 Segurança da informação.","5.1 Procedimentos de segurança.","5.2 Noções de vírus, worms e pragas virtuais.","5.3 Aplicativos para segurança (antivírus, firewall, anti‐spyware etc.).","5.4 Procedimentos de backup.","5.5 Armazenamento de dados na nuvem (cloud storage)."]}]}];
const LEGACY_KEY="gran-pm-ma-policia-militar-do-estado-do-maranhao";
const SEED_INFO=JSON.parse(JSON.stringify(CONCURSO_INFO));
const SEED_EDITAL=JSON.parse(JSON.stringify(EDITAL));
let state={};
let historico=[];
let revisoes=[];
let calOffset=0;
let modalDay=null;
let curFilter="todos";

// ── CRONÔMETRO ─────────────────────────────────────────
let cronoStartTime = null;  // Date.now() quando iniciou/retomou
let cronoAccumSecs = 0;     // segundos acumulados em pausas anteriores
let cronoInterval  = null;
let cronoRunning   = false;

function getCronoSecs() {
  let total = cronoAccumSecs;
  if (cronoRunning && cronoStartTime) {
    total += Math.floor((Date.now() - cronoStartTime) / 1000);
  }
  return total;
}

function cronoStart() {
  cronoRunning   = true;
  cronoStartTime = Date.now();
  cronoInterval  = setInterval(updateCronoDisplay, 500);
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('btn-pause').style.display = '';
  document.getElementById('btn-stop').style.display  = '';
  document.getElementById('crono-display').className  = 'crono-time running';
  document.getElementById('crono-status').textContent = 'Cronômetro em andamento...';
}

function cronoPause() {
  if (!cronoRunning) { cronoResumeInternal(); return; }
  cronoRunning    = false;
  cronoAccumSecs += Math.floor((Date.now() - cronoStartTime) / 1000);
  cronoStartTime  = null;
  clearInterval(cronoInterval);
  document.getElementById('btn-pause').textContent    = '▶ Retomar';
  document.getElementById('btn-pause').className      = 'crono-btn start';
  document.getElementById('crono-display').className   = 'crono-time paused';
  document.getElementById('crono-status').textContent  = 'Pausado — clique Retomar para continuar';
}

function cronoResumeInternal() {
  cronoRunning   = true;
  cronoStartTime = Date.now();
  cronoInterval  = setInterval(updateCronoDisplay, 500);
  document.getElementById('btn-pause').textContent    = '⏸ Pausar';
  document.getElementById('btn-pause').className      = 'crono-btn pause';
  document.getElementById('crono-display').className   = 'crono-time running';
  document.getElementById('crono-status').textContent  = 'Cronômetro em andamento...';
}

function cronoStop() {
  cronoRunning = false;
  clearInterval(cronoInterval);
  if (cronoStartTime) {
    cronoAccumSecs += Math.floor((Date.now() - cronoStartTime) / 1000);
    cronoStartTime = null;
  }

  const totalSecs = cronoAccumSecs;

  if (totalSecs > 0) {
    const horas    = Math.round((totalSecs / 3600) * 100) / 100;
    const disc     = document.getElementById('crono-disc').value;
    const topic    = document.getElementById('crono-topic').value;
    const tipo     = document.getElementById('crono-tipo').value;
    const acertos  = parseInt(document.getElementById('crono-acertos').value) || 0;
    const erros    = parseInt(document.getElementById('crono-erros').value) || 0;
    const obs      = document.getElementById('crono-obs').value.trim();
    const today    = todayKey();

    const revDays = getSelectedRevDays();
    addRegistro(Object.assign({ date: today, disc, topic, tipo, horas, questoes: acertos + erros, acertos, erros, obs, origem: 'cronômetro' }, getNR('crono', acertos, erros)));
    if (topic && revDays.length === 0 && (revAutoSel || store.cfg.revAuto)) { agendarCadeia(disc, topic, acertos, erros, today); revAutoSel = false; syncRevAutoBtn(); renderRevisoes(); debouncedSave(); }

    if (revDays.length > 0 && topic) {
      revDays.forEach(days => {
        const revDate = addDays(today, days);
        if (!revisoes) revisoes = [];
        revisoes.push({ id: Date.now() + Math.random(), disc, topic, studyDate: today, revDate, days, done: false });
      });
      renderRevisoes();
      debouncedSave();
    }

    document.getElementById('crono-acertos').value = '';
    document.getElementById('crono-erros').value   = '';
    document.getElementById('crono-obs').value     = '';
    document.getElementById('crono-tipo').value    = '';
    clearRevBtns();
    document.getElementById('crono-rev-custom').value      = '';
    document.getElementById('crono-rev-selected').textContent = '';
    showToast('✅', secsToHMS(totalSecs) + ' registrados!' + (revDays.length ? ' ' + revDays.length + ' revisão(ões) agendada(s).' : ''));
  }

  cronoAccumSecs = 0;
  updateCronoDisplay();
  document.getElementById('btn-start').style.display  = '';
  document.getElementById('btn-pause').style.display  = 'none';
  document.getElementById('btn-stop').style.display   = 'none';
  document.getElementById('btn-pause').textContent    = '⏸ Pausar';
  document.getElementById('btn-pause').className      = 'crono-btn pause';
  document.getElementById('crono-display').className  = 'crono-time';
  document.getElementById('crono-status').textContent = 'Pronto para iniciar';
}

function updateCronoDisplay() {
  document.getElementById('crono-display').textContent = secsToHMS(getCronoSecs());
}

function onCronoDiscChange() {
  const disc = document.getElementById('crono-disc').value;
  const row = document.getElementById('crono-topic-row');
  const sel = document.getElementById('crono-topic');
  if (disc) {
    sel.innerHTML = '<option value="">— Assunto / Tópico —</option>' + getTopicsForDisc(disc).map(t => `<option value="${t}">${t}</option>`).join('');
    row.style.display = 'flex';
  } else {
    row.style.display = 'none';
  }
}

function escOpt(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function normTopic(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
}

function getTopicOptionsForDisc(discNome) {
  const d = EDITAL.find(d => d.nome === discNome);
  if (!d) return [];
  const opts = [];
  d.grupos.forEach(g => g.topicos.forEach((topic, idx) => {
    opts.push({ tid: d.id + '_' + slug(g.nome) + '_' + idx, topic, grupo: g.nome });
  }));
  return opts;
}

function onManDiscChange() {
  const disc = document.getElementById('man-disc').value;
  const wrap = document.getElementById('man-topic-wrap');
  const sel  = document.getElementById('man-topic');
  if (disc) {
    sel.innerHTML = '<option value="">— selecione —</option>' + getTopicOptionsForDisc(disc).map(o => `<option value="${escOpt(o.tid)}" data-topic="${escOpt(o.topic)}">${escOpt(o.topic)}</option>`).join('');
    wrap.style.display = '';
  } else {
    sel.innerHTML = '<option value="">— selecione —</option>';
    wrap.style.display = 'none';
  }
}

function onModalDiscChange() {
  const disc = document.getElementById('modal-disc').value;
  const field = document.getElementById('modal-topic-field');
  const sel = document.getElementById('modal-topic');
  if (disc) {
    sel.innerHTML = '<option value="">— Assunto / Tópico —</option>' + getTopicOptionsForDisc(disc).map(o => `<option value="${escOpt(o.topic)}">${escOpt(o.topic)}</option>`).join('');
    field.classList.add('visible');
  } else {
    field.classList.remove('visible');
  }
}

function getTopicsForDisc(discNome) {
  return getTopicOptionsForDisc(discNome).map(o => o.topic);
}

function findTopicTid(discNome, topicOrTid) {
  const d = EDITAL.find(d => d.nome === discNome);
  if (!d || !topicOrTid) return null;
  const direct = getTopicOptionsForDisc(discNome).find(o => o.tid === topicOrTid);
  if (direct) return direct.tid;
  const wanted = normTopic(topicOrTid);
  const fuzzy = getTopicOptionsForDisc(discNome).find(o => normTopic(o.topic) === wanted);
  return fuzzy ? fuzzy.tid : null;
}

function getTopicLabelFromTid(discNome, topicOrTid) {
  const match = getTopicOptionsForDisc(discNome).find(o => o.tid === topicOrTid);
  return match ? match.topic : topicOrTid;
}

function syncManualQuestionsToEdital(disc, topic, acertos, erros, totalQ, date) {
  const tid = findTopicTid(disc, topic);
  if (!tid || totalQ <= 0) return false;
  const ts = getTS(tid);
  const prevAc = parseInt(ts.acertos) || 0;
  const prevEr = parseInt(ts.erros) || 0;
  const prevTotal = Math.max(parseInt(ts.questoes) || 0, prevAc + prevEr);
  const answered = (parseInt(acertos) || 0) + (parseInt(erros) || 0);
  setTS(tid, 'acertos', prevAc + (parseInt(acertos) || 0));
  setTS(tid, 'erros', prevEr + (parseInt(erros) || 0));
  const nextAnswered = (parseInt(getTS(tid).acertos) || 0) + (parseInt(getTS(tid).erros) || 0);
  const extraTotal = Math.max((parseInt(totalQ) || 0) - answered, 0);
  setTS(tid, 'questoes', Math.max(prevTotal + extraTotal, nextAnswered));
  if (date && !ts.datetime) {
    const [y,m,d] = date.split('-');
    setTS(tid, 'datetime', d + '/' + m + '/' + y);
  }
  return true;
}

function manualAdd() {
  const date    = document.getElementById('man-data').value;
  const h       = parseFloat(document.getElementById('man-h').value) || 0;
  const m       = parseFloat(document.getElementById('man-m').value) || 0;
  const sec     = parseFloat(document.getElementById('man-s').value) || 0;
  const q       = parseInt(document.getElementById('man-q').value) || 0;
  const acertos = parseInt(document.getElementById('man-acertos').value) || 0;
  const erros   = parseInt(document.getElementById('man-erros').value) || 0;
  const disc    = document.getElementById('man-disc').value;
  const topicVal = document.getElementById('man-topic').value;
  const topic   = getTopicLabelFromTid(disc, topicVal);
  const tipo    = document.getElementById('man-tipo').value;
  const obs     = document.getElementById('man-obs').value.trim();
  if (!date) { showToast('⚠️', 'Selecione a data.'); return; }
  const horas = Math.round((h + m / 60 + sec / 3600) * 10000) / 10000;
  if (horas === 0 && q === 0 && acertos === 0 && erros === 0) { showToast('⚠️', 'Informe horas ou questões.'); return; }
  const totalQ = q || (acertos + erros);
  const synced = syncManualQuestionsToEdital(disc, topicVal, acertos, erros, totalQ, date);
  addRegistro(Object.assign({ date, disc, topic, tipo, horas, questoes: totalQ, acertos, erros, obs, origem: 'manual' }, getNR('man', acertos, erros)));
  if (synced) { renderDiscs(); applyFilter(); updateAll(); }
  ['man-h','man-m','man-s','man-q','man-acertos','man-erros','man-obs'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('man-disc').value = '';
  document.getElementById('man-topic').value = '';
  document.getElementById('man-tipo').value = '';
  const wrap = document.getElementById('man-topic-wrap');
  if (wrap) wrap.style.display = 'none';
  showToast('✅', synced ? 'Registro adicionado e edital atualizado!' : 'Registro adicionado!');
}

// ── REGISTROS (histórico + calendário unificados) ──────
function addRegistro(r) {
  r.id = Date.now() + Math.random();
  historico.push(r);
  updateAll();
  renderCal();
  renderCharts();
  renderHistorico();
  debouncedSave();
}

function deleteRegistro(id) {
  historico = historico.filter(r => r.id !== id);
  updateAll();
  renderCal();
  renderHistorico();
  debouncedSave();
  showToast('🗑️', 'Registro removido.');
}

// ── CALENDÁRIO ─────────────────────────────────────────
function calNav(dir) { calOffset = dir === 0 ? 0 : calOffset + dir; renderCal(); }

function renderCal() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + calOffset, 1);
  const y = target.getFullYear(), m = target.getMonth();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  document.getElementById('cal-title').textContent = months[m] + ' ' + y;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].forEach(d => {
    const el = document.createElement('div'); el.className = 'cal-dow'; el.textContent = d; grid.appendChild(el);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const todayStr = todayKey();

  for (let i = 0; i < firstDay; i++) grid.appendChild(makeDayEl(y, m - 1, daysInPrev - firstDay + 1 + i, true));
  for (let d = 1; d <= daysInMonth; d++) grid.appendChild(makeDayEl(y, m, d, false));
  const rem = (firstDay + daysInMonth) % 7; if (rem > 0) for (let d = 1; d <= 7 - rem; d++) grid.appendChild(makeDayEl(y, m + 1, d, true));

  updateCronoTodayVal();
}

function makeDayEl(y, m, d, other) {
  const date = new Date(y, m, d);
  const key = dateToKey(date);
  const regs = historico.filter(r => r.date === key);
  const totalH = regs.reduce((s, r) => s + (r.horas || 0), 0);
  const totalQ = regs.reduce((s, r) => s + (r.questoes || 0), 0);
  const discs = [...new Set(regs.map(r => r.disc).filter(Boolean))];

  const el = document.createElement('div');
  el.className = 'cal-day' + (other ? ' other-month' : '') + (key === todayKey() ? ' today' : '') + (regs.length ? ' has-data' : '');
  el.innerHTML = `<div class="cal-day-num">${d}</div>`;
  if (totalH > 0) el.innerHTML += `<div class="cal-day-h">⏱ ${horasLabel(totalH)}</div>`;
  if (!other) el.onclick = () => openModal(key);
  return el;
}

function updateCronoTodayVal() {
  const today = todayKey();
  const totalH = historico.filter(r => r.date === today).reduce((s, r) => s + (r.horas || 0), 0);
  document.getElementById('crono-today-val').textContent = horasLabel(totalH);
}

// ── MODAL CALENDÁRIO ─────────────────────────────────────
function openModal(key) {
  modalDay = key;
  const [y, m, d] = key.split('-');
  document.getElementById('modal-date-lbl').textContent = `${d}/${m}/${y}`;
  const regs = historico.filter(r => r.date === key);
  const totalH = regs.reduce((s, r) => s + (r.horas || 0), 0);
  const totalQ = regs.reduce((s, r) => s + (r.questoes || 0), 0);
  document.getElementById('modal-horas').value = totalH > 0 ? totalH : '';
  document.getElementById('modal-questoes').value = totalQ > 0 ? totalQ : '';
  document.getElementById('modal-disc').value = '';
  document.getElementById('modal-topic').value = '';
  document.getElementById('modal-topic-field').classList.remove('visible');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('open');
    modalDay = null;
  }
}

function saveModalDay() {
  if (!modalDay) return;
  const horas = parseFloat(document.getElementById('modal-horas').value) || 0;
  const questoes = parseInt(document.getElementById('modal-questoes').value) || 0;
  const disc = document.getElementById('modal-disc').value;
  const topic = document.getElementById('modal-topic').value;
  // Remove registros manuais do dia e adiciona novo consolidado
  historico = historico.filter(r => !(r.date === modalDay && r.origem === 'modal'));
  if (horas > 0 || questoes > 0) addRegistro({ date: modalDay, disc, topic, horas, questoes, origem: 'modal' });
  document.getElementById('modal-overlay').classList.remove('open');
  modalDay = null;
  showToast('✅', 'Dia atualizado!');
}

// ── HISTÓRICO ──────────────────────────────────────────
function renderHistorico() {
  const discFilter = document.getElementById('hist-filter-disc').value;
  const periodDays = parseInt(document.getElementById('hist-filter-period').value);
  const cutoff = periodDays > 0 ? new Date(Date.now() - periodDays * 86400000) : null;

  let filtered = [...historico].filter(r => {
    if (discFilter && r.disc !== discFilter) return false;
    if (cutoff && new Date(r.date + 'T00:00:00') < cutoff) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));

  // Summary
  const totalH = filtered.reduce((s, r) => s + (r.horas || 0), 0);
  const totalQ = filtered.reduce((s, r) => s + (r.questoes || 0), 0);
  const dias = new Set(filtered.map(r => r.date)).size;
  document.getElementById('hs-dias').textContent = dias;
  document.getElementById('hs-horas').textContent = horasLabel(totalH);
  document.getElementById('hs-questoes').textContent = totalQ;
  document.getElementById('hs-media').textContent = dias > 0 ? horasLabel(totalH / dias) : '0h';

  const tbody = document.getElementById('hist-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="hist-empty">Nenhum registro encontrado.<br>Use o cronômetro ou inserção manual para começar.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const discIdx = EDITAL.findIndex(d => d.nome === r.disc);
    const cor = discIdx >= 0 ? DISC_CORES[discIdx % DISC_CORES.length] : 'var(--text-soft)';
    const [y, m, d] = r.date.split('-');
    const ac  = r.acertos || 0;
    const er  = r.erros || 0;
    const tot = ac + er;
    const pct = tot > 0 ? Math.round(ac / tot * 100) : null;
    const pctBadge = pct !== null
      ? `<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;background:${pct>=70?'var(--green-bg)':pct>=50?'var(--yellow-bg)':'var(--red-bg)'};color:${pct>=70?'#15803d':pct>=50?'#b45309':'var(--red)'}">${pct}%</span>`
      : '<span style="color:var(--text-soft)">—</span>';
    const tipoBadge = r.tipo ? `<span style="font-size:10px;background:var(--bg);padding:2px 8px;border-radius:4px;color:var(--text-mid)">${r.tipo}</span>` : '<span style="color:var(--text-soft)">—</span>';
    return `<tr>
      <td style="font-weight:600;color:var(--navy);white-space:nowrap">${d}/${m}/${y}</td>
      <td>${r.disc ? `<span class="hist-disc-badge" style="background:${cor}20;color:${cor}">${r.disc}</span>` : '<span style="color:var(--text-soft)">—</span>'}</td>
      <td style="font-size:12px;color:var(--text-mid);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.topic||''}">${r.topic || '—'}</td>
      <td>${tipoBadge}</td>
      <td style="font-weight:700;color:var(--navy);white-space:nowrap">${r.horas > 0 ? horasLabel(r.horas) : '—'}</td>
      <td style="text-align:center;font-weight:700;color:var(--navy)">${r.questoes > 0 ? r.questoes : '—'}</td>
      <td style="text-align:center;font-weight:700;color:var(--green)">${ac > 0 ? ac : '—'}</td>
      <td style="text-align:center;font-weight:700;color:var(--red)">${er > 0 ? er : '—'}</td>
      <td style="text-align:center">${pctBadge}</td>
      <td style="font-size:11px;color:var(--text-mid);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.obs||''}">${r.obs ? `💬 ${r.obs.length > 35 ? r.obs.slice(0,35)+'…' : r.obs}` : '<span style="color:var(--text-soft)">—</span>'}</td>
      <td><span style="font-size:10px;background:var(--bg);padding:2px 8px;border-radius:4px;color:var(--text-soft)">${r.origem}</span></td>
      <td><button class="btn-del" onclick="deleteRegistro(${r.id})" title="Remover">🗑</button></td>
    </tr>`;
  }).join('');
}

function populateHistFilterDisc() {
  const sel = document.getElementById('hist-filter-disc');
  sel.innerHTML = '<option value="">Todas as disciplinas</option>' + EDITAL.map(d => `<option value="${d.nome}">${d.nome}</option>`).join('');
}

// ── SELECTS DE DISCIPLINA ─────────────────────────────
function populateDiscSelects() {
  const opts = '<option value="">— selecione —</option>' + EDITAL.map(d => `<option value="${d.nome}">${d.nome}</option>`).join('');
  document.getElementById('crono-disc').innerHTML = opts;
  document.getElementById('man-disc').innerHTML = opts;
  document.getElementById('modal-disc').innerHTML = opts;
}

// ── TABS ───────────────────────────────────────────────
function compactTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.querySelector('.ti') || b.querySelector('svg')) return;   // já tem ícone (SVG) ou já foi compactada: não mexe
    const t = b.textContent.trim(), i = t.indexOf(' ');
    b.title = t.slice(i + 1); b.innerHTML = '<span class="ti">' + t.slice(0, i) + '</span><span class="tl"> ' + t.slice(i + 1) + '</span>';
  });
}
function switchTab(tab) {
  const pg = document.getElementById('page-' + tab); if (!pg) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  pg.classList.add('active');
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('btn-expand').style.display  = tab === 'edital' ? '' : 'none';
  document.getElementById('btn-collapse').style.display = tab === 'edital' ? '' : 'none';
  if (tab === 'hoje')      renderHoje();
  if (tab === 'historico') renderHistorico();
  if (tab === 'bizus')     renderBizus();
  if (tab === 'revisoes')  { renderRevCfg(); renderRevisoes(); }
  if (tab === 'estudos')   renderCharts();
  if (tab === 'simulados') renderSimulados();
  if (tab === 'erros')     renderErros();
  if (tab === 'desempenho') renderDesempenho();
  if (tab === 'cronograma') renderCronograma();
  if (tab === 'raiox')     renderRaioX();
  if (tab === 'cruzar')    renderCruzar();
  if (tab === 'treinador') renderTrein();
  if (tab === 'mapas')     renderMapas();
  window.scrollTo(0, 0);
}

function scrollToId(id) {
  setTimeout(() => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
}

// ── SIDEBAR ────────────────────────────────────────────
function renderSidebar() {
  const info = document.getElementById('sb-info');
  const rows = [{l:'Concurso',v:CONCURSO_INFO.concurso},{l:'Cargo',v:CONCURSO_INFO.cargo},{l:'Banca',v:CONCURSO_INFO.banca},{l:'Prazo',v:prazoLabel(CONCURSO_INFO.prazo)}];
  info.innerHTML = rows.map((r,i) => `${i>0?'<div class="si-div"></div>':''}<div class="si-row"><div class="si-lbl">${r.l}</div><div class="si-val${r.v?'':' empty'}">${r.v||'—'}</div></div>`).join('');
  const cd = document.getElementById('cd-date'), cn = document.getElementById('cd-num');
  if (CONCURSO_INFO.dataProva) {
    const p = new Date(CONCURSO_INFO.dataProva + 'T00:00:00'), h = new Date(); h.setHours(0,0,0,0);
    const diff = Math.ceil((p-h)/86400000);
    cd.textContent = p.toLocaleDateString('pt-BR');
    cn.textContent = diff > 0 ? diff : diff === 0 ? 'Hoje!' : 'Passou';
  } else { cd.textContent = '—'; cn.textContent = '—'; }
  document.getElementById('nav-discs').innerHTML = EDITAL.map((d,i) =>
    `<a class="nav-item" href="#" onclick="switchTab('edital');goDisc('${d.id}');return false;" style="gap:8px"><div class="nav-dot" style="background:${DISC_CORES[i%DISC_CORES.length]}"></div><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${d.nome}</span></a>`
  ).join('');
}

function goDisc(id) {
  const el = document.getElementById('disc-' + id);
  if (el) { el.classList.add('open'); setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }
}

// ── DISCIPLINAS ────────────────────────────────────────
function renderDiscs() {
  const list = document.getElementById('disc-list'); list.innerHTML = '';
  if (!EDITAL.length) { list.innerHTML = '<div class="rev-empty">Este concurso ainda não tem matérias.<br><br><button class="btn btn-navy" style="margin:0 auto" onclick="openEditEdital()">✏️ Adicionar matérias</button></div>'; return; }
  EDITAL.forEach((disc, di) => {
    const cor = DISC_CORES[di % DISC_CORES.length];
    const s = getDiscStats(disc);
    const card = document.createElement('div'); card.className = 'disc-card'; card.id = 'disc-' + disc.id; card.style.setProperty('--dc', cor);
    const cp = s.totalTopicos > 0 ? Math.round(s.concluidos / s.totalTopicos * 100) : 0;
    const hdr = document.createElement('div'); hdr.className = 'disc-hdr'; hdr.onclick = () => card.classList.toggle('open');
    hdr.innerHTML = `<div class="dc-dot"></div><div class="dc-info"><div class="dc-name">${disc.nome}${pesoBadge(disc)}</div><div class="dc-meta"><span class="dc-sub" id="dcsub0-${disc.id}">${s.concluidos}/${s.totalTopicos} concluídos</span><div class="dc-mini-bar"><div class="dc-mini-fill" id="dcmf-${disc.id}" style="width:${cp}%"></div></div><span class="dc-sub" id="dcsub1-${disc.id}">${s.total>0?s.pct+'% acertos':'Sem questões'}</span></div></div><div class="dc-stats"><div class="dcs"><div class="dcs-v g" id="dcac-${disc.id}">${s.acertos}</div><div class="dcs-l">Acertos</div></div><div class="dcs"><div class="dcs-v r" id="dcer-${disc.id}">${s.erros}</div><div class="dcs-l">Erros</div></div><div class="dcs"><div class="dcs-v b" id="dcto-${disc.id}">${s.total}</div><div class="dcs-l">Total</div></div><div class="pct-pill ${pc(s.pct,s.total)}" id="dcpct-${disc.id}">${s.total>0?s.pct+'%':'—'}</div></div><div class="dc-chevron">▼</div>`;
    const body = document.createElement('div'); body.className = 'disc-body';
    body.innerHTML = (disc.dica ? '<div class="dica-box">💡 <b>Estratégia:</b> ' + escOpt(disc.dica) + '</div>' : '') + bizusHtml(disc);
    const tbl = document.createElement('table'); tbl.className = 'ctable';
    tbl.innerHTML = `<thead><tr><th class="c">✓</th><th>Tópico / Conteúdo</th><th>Concluído em</th><th class="c">Questões (Acertos × Erros)</th><th class="c">Total</th><th class="c">% Acerto</th></tr></thead><tbody id="tb-${disc.id}"></tbody>`;
    const tbody = tbl.querySelector('tbody');
    disc.grupos.forEach(g => {
      const gr = document.createElement('tr'); gr.className = 'grow'; gr.style.setProperty('--dc', cor);
      gr.innerHTML = `<td colspan="6">${g.nome}</td>`; tbody.appendChild(gr);
      g.topicos.forEach((tp, ti) => {
        const tid = disc.id + '_' + slug(g.nome) + '_' + ti, ts = getTS(tid);
        const answered = (ts.acertos||0) + (ts.erros||0), tot = Math.max(answered, parseInt(ts.questoes)||0), tpct = tot > 0 && answered > 0 ? Math.round((ts.acertos||0)/tot*100) : null;
        const tr = document.createElement('tr'); tr.id = 'row-' + tid; if (ts.done) tr.classList.add('done');
        tr.innerHTML = `<td class="td-ck"><input class="cbx" type="checkbox" ${ts.done?'checked':''} onchange="toggleT('${tid}',this)"></td><td class="td-topic"><div class="topic-nm">${tp}${linkBadge(tid)}${domBadge(disc, tid, tp)}</div><div class="topic-dt" id="tdt-${tid}">${ts.datetime||''}</div></td><td class="td-dt" id="dt-${tid}">${ts.done&&ts.datetime?ts.datetime:'<span style="color:var(--border)">—</span>'}</td><td class="td-q"><div class="q-row"><div class="qwrap ac"><label>Acertos</label><input class="qinp" type="number" min="0" value="${ts.acertos||''}" placeholder="0" oninput="updateQ('${tid}','acertos',this.value)"></div><span class="qsep">×</span><div class="qwrap er"><label>Erros</label><input class="qinp" type="number" min="0" value="${ts.erros||''}" placeholder="0" oninput="updateQ('${tid}','erros',this.value)"></div></div></td><td class="td-tot"><span class="tot-v" id="tot-${tid}">${tot>0?tot:'—'}</span></td><td class="td-pct"><span class="pct-pill ${pc(tpct,tot)}" id="pct-${tid}">${tpct!==null?tpct+'%':'—'}</span></td>`;
        tbody.appendChild(tr);
      });
    });
    body.appendChild(tbl); card.appendChild(hdr); card.appendChild(body); list.appendChild(card);
  });
}

function toggleT(tid, cb) {
  setTS(tid,'done',cb.checked);
  const now = cb.checked ? fmtDt(new Date()) : null; setTS(tid,'datetime',now);
  const row = document.getElementById('row-'+tid), dtc = document.getElementById('dt-'+tid), tdt = document.getElementById('tdt-'+tid);
  if (cb.checked) { row.classList.add('done'); dtc.innerHTML=now; if(tdt)tdt.textContent=now; }
  else { row.classList.remove('done'); dtc.innerHTML='<span style="color:var(--border)">—</span>'; if(tdt)tdt.textContent=''; }
  updateAll(); debouncedSave();
}
function updateQ(tid, field, val) {
  setTS(tid,field,parseInt(val)||0);
  const ts=getTS(tid),answered=(ts.acertos||0)+(ts.erros||0);
  if (answered > (parseInt(ts.questoes)||0)) setTS(tid,'questoes',answered);
  const totalForDisplay=Math.max(answered,parseInt(getTS(tid).questoes)||0),tpct=totalForDisplay>0&&answered>0?Math.round((ts.acertos||0)/totalForDisplay*100):null;
  document.getElementById('tot-'+tid).textContent=totalForDisplay>0?totalForDisplay:'—';
  const p=document.getElementById('pct-'+tid); p.textContent=tpct!==null?tpct+'%':'—'; p.className='pct-pill '+pc(tpct,tot);
  updateAll(); debouncedSave();
}
function setFilter(f,btn){curFilter=f;document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');applyFilter();}
function applyFilter(){EDITAL.forEach(d=>d.grupos.forEach(g=>g.topicos.forEach((t,i)=>{const tid=d.id+'_'+slug(g.nome)+'_'+i,row=document.getElementById('row-'+tid);if(!row)return;const ts=getTS(tid);let show=true;if(curFilter==='pendentes')show=!ts.done;else if(curFilter==='concluidos')show=!!ts.done;else if(curFilter==='questoes')show=Math.max((ts.acertos||0)+(ts.erros||0),parseInt(ts.questoes)||0)>0;row.style.display=show?'':'none';})));}
function expandAll(){document.querySelectorAll('.disc-card').forEach(c=>c.classList.add('open'));}
function collapseAll(){document.querySelectorAll('.disc-card').forEach(c=>c.classList.remove('open'));}

// ── UPDATE ALL ──────────────────────────────────────────
// Cada questão conta UMA vez: por tópico vale o maior valor entre o registro do tópico (Edital)
// e o histórico daquele tópico (lançamento manual sincroniza nos dois); sem tópico, entra o histórico.
function contarQuestoesUnicas() {
  const porTid = {}; let ac = 0, er = 0;
  historico.forEach(r => {
    const a = r.acertos || 0, e = r.erros || 0; if (!(a + e)) return;
    const tid = r.topic ? findTopicTid(r.disc, r.topic) : null;
    if (tid) { const o = porTid[tid] || (porTid[tid] = { a: 0, e: 0 }); o.a += a; o.e += e; } else { ac += a; er += e; }
  });
  EDITAL.forEach(d => d.grupos.forEach((g, gi) => g.topicos.forEach((tp, i) => {
    const tid = d.id + '_' + slug(g.nome) + '_' + i, ts = getTS(tid), h = porTid[tid] || { a: 0, e: 0 };
    ac += Math.max(parseInt(ts.acertos) || 0, h.a); er += Math.max(parseInt(ts.erros) || 0, h.e);
  })));
  return { ac, er };
}
function updateAll() {
  // Progresso edital — checkboxes
  let tot=0,conc=0,acEdital=0,erEdital=0;
  EDITAL.forEach(d=>{const s=getDiscStats(d);tot+=s.totalTopicos;conc+=s.concluidos;acEdital+=s.acertos;erEdital+=s.erros;});
  const pct=tot>0?Math.round(conc/tot*100):0;

  // Aproveitamento TOTAL = edital + cronômetro + inserção manual
  const _uq = contarQuestoesUnicas();
  const acTotal = _uq.ac;
  const erTotal = _uq.er;
  const totQ    = acTotal + erTotal;
  const aprov   = totQ > 0 ? Math.round(acTotal / totQ * 100) : null;

  document.getElementById('prog-pct').textContent=pct+'%';
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('prog-sub').textContent=conc+' de '+tot+' tópicos concluídos';
  document.getElementById('ps-ac').textContent=acTotal;
  document.getElementById('ps-er').textContent=erTotal;
  document.getElementById('ps-tot').textContent=totQ;
  document.getElementById('ps-aprov').textContent=aprov!==null?aprov+'%':'—';

  // Metas — horas e questões da semana atual (automático)
  const weekStart = getWeekStart();
  const weekRegs = historico.filter(r => r.date >= weekStart);
  const weekH = weekRegs.reduce((s,r)=>s+(r.horas||0),0);
  const weekQ = weekRegs.reduce((s,r)=>s+(r.questoes||0),0);
  document.getElementById('real-horas').value = Math.round(weekH * 10) / 10;
  document.getElementById('real-questoes').value = weekQ;

  const mH=parseFloat(document.getElementById('meta-horas').value)||0,pH=mH>0?Math.min(Math.round(weekH/mH*100),100):0;
  document.getElementById('mf-h').style.width=pH+'%';
  document.getElementById('ml-h').textContent=horasLabel(weekH)+' esta semana';
  document.getElementById('mp-h').textContent=pH+'%';

  const mQ=parseInt(document.getElementById('meta-questoes').value)||0,pQ=mQ>0?Math.min(Math.round(weekQ/mQ*100),100):0;
  document.getElementById('mf-q').style.width=pQ+'%';
  document.getElementById('ml-q').textContent=weekQ+' esta semana';
  document.getElementById('mp-q').textContent=pQ+'%';

  const mC=parseInt(document.getElementById('meta-conclusao').value)||0,rC=tot>0?Math.round(conc/tot*100):0,pC=mC>0?Math.min(Math.round(rC/mC*100),100):rC;
  document.getElementById('mf-c').style.width=pC+'%';
  document.getElementById('ml-c').textContent=mC>0?conc+'/'+tot+' concluídos ('+rC+'% do edital; meta '+mC+'%)':conc+'/'+tot+' concluídos ('+rC+'% do edital)';
  document.getElementById('mp-c').textContent=pC+'%';

  const mA=parseInt(document.getElementById('meta-aprov').value)||0,rA=totQ>0?Math.round(acTotal/totQ*100):0,pA=mA>0?Math.min(Math.round(rA/mA*100),100):0;
  document.getElementById('mf-a').style.width=pA+'%';
  document.getElementById('ml-a').textContent=totQ>0?acTotal+' acertos de '+totQ:'Sem questões';
  document.getElementById('mp-a').textContent=rA+'%';

  // Disc headers
  EDITAL.forEach(d=>{
    const s=getDiscStats(d),cp=s.totalTopicos>0?Math.round(s.concluidos/s.totalTopicos*100):0,g=id=>document.getElementById(id);
    if(g('dcac-'+d.id))g('dcac-'+d.id).textContent=s.acertos;if(g('dcer-'+d.id))g('dcer-'+d.id).textContent=s.erros;if(g('dcto-'+d.id))g('dcto-'+d.id).textContent=s.total;
    if(g('dcmf-'+d.id))g('dcmf-'+d.id).style.width=cp+'%';
    if(g('dcsub0-'+d.id))g('dcsub0-'+d.id).textContent=s.concluidos+'/'+s.totalTopicos+' concluídos';
    if(g('dcsub1-'+d.id))g('dcsub1-'+d.id).textContent=s.total>0?s.pct+'% acertos':'Sem questões';
    const badge=g('dcpct-'+d.id);if(badge){badge.textContent=s.total>0?s.pct+'%':'—';badge.className='pct-pill '+pc(s.pct,s.total);}
  });

  updateCronoTodayVal();
  renderPlano();
  renderHoje();
}

function getWeekStart() {
  const d = new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay()); // domingo
  return dateToKey(d);
}

// ── STATE ───────────────────────────────────────────────
function kbA(cid, tid) { return (typeof store !== 'undefined' && store && store.kb && store.kb.link) ? store.kb.link[cid + '|' + tid] : undefined; }
function getTS(tid) { const a = kbA(curId, tid); if (a) return store.kb.prog[a] || {}; return state[tid] || {}; }
function setTS(tid, k, v) {
  const a = kbA(curId, tid);
  if (a) { const p = store.kb.prog[a] = store.kb.prog[a] || {}; p[k] = v; return; }
  if (!state[tid]) state[tid] = {}; state[tid][k] = v;
}
function tsOf(cid, tid) {
  const a = kbA(cid, tid); if (a) return store.kb.prog[a] || {};
  const s = cid === curId ? state : ((store.concursos[cid] && store.concursos[cid].data.state) || {});
  return s[tid] || {};
}
function getDiscStats(disc){
  let ac=0,er=0,totalQ=0,c=0,t=0;
  disc.grupos.forEach(g=>g.topicos.forEach((tp,i)=>{const ts=getTS(disc.id+'_'+slug(g.nome)+'_'+i),a=parseInt(ts.acertos)||0,e=parseInt(ts.erros)||0;ac+=a;er+=e;totalQ+=Math.max(a+e,parseInt(ts.questoes)||0);if(ts.done)c++;t++;}));
  const pct=totalQ>0?Math.round(ac/totalQ*100):0;return{acertos:ac,erros:er,total:totalQ,pct,concluidos:c,totalTopicos:t};
}

// ── STORAGE (multi-concurso) ────────────────────────────
const STORE_KEY = 'rumo-posse-v1';
const PRAZOS = [
  { k:'curto', l:'🟢 Curto prazo' }, { k:'medio', l:'🟡 Médio prazo' },
  { k:'longo', l:'🟠 Longo prazo' }, { k:'muito-longo', l:'🔴 Mais longo prazo' }, { k:'', l:'⚪ Sem prazo definido' }
];
function prazoLabel(k) { const pz = PRAZOS.find(x => x.k === (k || '')); return (pz && k) ? pz.l.replace(/^\S+\s/, '') : ''; }
const PRESETS = [
  { id:'detran-ma',  info:{ concurso:'DETRAN-MA', cargo:'', banca:'', dataProva:'', prazo:'curto' } },
  { id:'procon-ma',  info:{ concurso:'PROCON-MA', cargo:'', banca:'', dataProva:'', prazo:'curto' } },
  { id:'gc-imperatriz', info:{ concurso:'Guarda Civil Municipal de Imperatriz (MA)', cargo:'Guarda Civil Municipal', banca:'', dataProva:'', prazo:'curto' } },
  { id:'gc-teresina',   info:{ concurso:'Guarda Civil Municipal de Teresina (PI)', cargo:'Guarda Civil Municipal', banca:'', dataProva:'', prazo:'curto' } },
  { id:'prf-administrativo', info:{ concurso:'PRF - Administrativo', cargo:'Agente Administrativo', banca:'', dataProva:'', prazo:'longo' } },
  { id:'prf-policial', info:{ concurso:'PRF - Policial Rodoviário Federal', cargo:'Policial Rodoviário Federal', banca:'', dataProva:'', prazo:'muito-longo' } }
];
const META_IDS = ['meta-horas','meta-questoes','meta-conclusao','meta-aprov'];
let store = { v: 2, active: null, concursos: {} };
let curId = null;

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function slugId(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || 'item'; }
function uniqueId(base, taken){ let id = base, n = 2; while (taken.indexOf(id) !== -1) { id = base + '-' + (n++); } return id; }
function readMetas(){ const m = {}; META_IDS.forEach(id => { const el = document.getElementById(id); if (el) m[id] = el.value; }); return m; }
function writeMetas(m){ META_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.value = (m && m[id] !== undefined) ? m[id] : ''; }); }

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem('gran-concursos-v2');
    if (raw) { const s = JSON.parse(raw); if (s && s.concursos && Object.keys(s.concursos).length) store = s; }
  } catch(e) {}
  if (!Object.keys(store.concursos).length) {
    // primeira vez na versão multi-concurso: traz o progresso antigo (PM-MA) se existir
    let data = { state:{}, historico:[], revisoes:[], metas:{} };
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        data = { state: s.state||{}, historico: s.historico||[], revisoes: s.revisoes||[], metas:{} };
        META_IDS.forEach(id => { if (s[id] !== undefined) data.metas[id] = s[id]; });
      }
    } catch(e) {}
    store = { v:2, active:'pm-ma', concursos:{ 'pm-ma': { id:'pm-ma', chosen: false, info: clone(SEED_INFO), edital: clone(SEED_EDITAL), data } } };
  }
  // concursos pré-cadastrados: entram uma única vez (se você excluir, não voltam)
  store.seeded = store.seeded || [];
  if (store.seedV !== 2) { store.seeded = []; store.seedV = 2; }
  PRESETS.forEach(pr => {
    if (store.seeded.indexOf(pr.id) !== -1) return;
    if (!store.concursos[pr.id]) store.concursos[pr.id] = { id: pr.id, chosen: false, info: clone(pr.info), edital: [], data: { state:{}, historico:[], revisoes:[], metas:{} } };
    store.seeded.push(pr.id);
  });
  applyPresetContent();
  if (!store.concursos[store.active]) store.active = Object.keys(store.concursos)[0];
}
function loadConcurso(id) {
  const c = store.concursos[id]; curId = id; store.active = id;
  CONCURSO_INFO = c.info; EDITAL = c.edital;
  const d = c.data || {};
  state = d.state || {}; historico = d.historico || []; revisoes = d.revisoes || [];
  simulados = d.simulados || []; erros = d.erros || []; plano = d.plano || {};
  writeMetas(d.metas);
}
function loadStorage() { readStore(); migrateStore(); loadConcurso(store.active); }
function commitCurrent() {
  const c = store.concursos[curId]; if (!c) return;
  c.info = CONCURSO_INFO; c.edital = EDITAL;
  c.data = { state, historico, revisoes, simulados, erros, plano, metas: readMetas() };
}
function persist() {
  commitCurrent();
  if (window.Armazenamento) Armazenamento.salvar(store);          // espelho no localStorage + IndexedDB
  else localStorage.setItem(STORE_KEY, JSON.stringify(store));    // plano B (modo antigo)
}
let saveTimer;
function debouncedSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveData, 1200); }
function saveData() {
  try { persist(); showToast('✅', 'Progresso salvo!'); }
  catch(e) { showToast('⚠️', 'Erro ao salvar.'); }
}

function renderConcursoSelect() {
  const sel = document.getElementById('conc-select'); if (!sel) return;
  sel.innerHTML = PRAZOS.map(pz => {
    const ids = Object.keys(store.concursos).filter(id => (store.concursos[id].info.prazo || '') === pz.k && isEscolhido(id));
    if (!ids.length) return '';
    return `<optgroup label="${pz.l}">` + ids.map(id =>
      `<option value="${escOpt(id)}"${id === curId ? ' selected' : ''}>${escOpt(store.concursos[id].info.concurso || 'Sem nome')}</option>`).join('') + '</optgroup>';
  }).join('');
  document.title = (CONCURSO_INFO.concurso || 'Edital') + ' – AprovaTropa';
}
function refreshAll() {
  renderRevCfg(); renderConcursoSelect(); renderSidebar(); renderDiscs(); populateDiscSelects();
  populateHistFilterDisc(); populateChartDisc(); onCronoDiscChange(); onManDiscChange();
  curFilter = 'todos';
  document.querySelectorAll('.fbtn').forEach((b, i) => b.classList.toggle('active', i === 0));
  renderEstrategia(); renderBizus(); renderHoje(); renderSimulados(); renderErros(); renderCronograma(); renderRaioX(); renderDesempenho(); renderCruzar(); renderCal(); renderCharts(); renderRevisoes(); renderHistorico(); updateAll();
}
function cronoBusy() { return cronoRunning || cronoAccumSecs > 0; }

function switchConcurso(id) {
  // (botão Hora de Ser Aprovado do topo acompanha o concurso: ver módulo 205)
  if (id === curId || !store.concursos[id]) return;
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de trocar de concurso.'); renderConcursoSelect(); return; }
  persist(); loadConcurso(id); persist(); refreshAll();
  showToast('📚', CONCURSO_INFO.concurso);
}

// ── MODAL CONCURSO (novo / editar / excluir) ────────────
let concMode = 'new';
function openConcModal(mode) {
  if (mode === 'new' && cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes.'); return; }
  concMode = mode;
  const isNew = mode === 'new';
  document.getElementById('cm-title').textContent = isNew ? '➕ Novo concurso' : '✏️ Editar concurso';
  document.getElementById('cm-sub').textContent = isNew ? 'Cada concurso tem suas próprias matérias, progresso, histórico, revisões e metas.' : '';
  document.getElementById('cm-nome').value  = isNew ? '' : (CONCURSO_INFO.concurso || '');
  document.getElementById('cm-cargo').value = isNew ? '' : (CONCURSO_INFO.cargo || '');
  document.getElementById('cm-banca').value = isNew ? '' : (CONCURSO_INFO.banca || '');
  document.getElementById('cm-data').value  = isNew ? '' : (CONCURSO_INFO.dataProva || '');
  document.getElementById('cm-prazo').value = isNew ? 'curto' : (CONCURSO_INFO.prazo || '');
  document.getElementById('cm-est').value = isNew ? '' : (CONCURSO_INFO.estrategia || '');
  document.getElementById('cm-dias').value = '';
  document.getElementById('cm-corte').value = isNew ? '' : (CONCURSO_INFO.notaCorte || '');
  document.getElementById('cm-base').value = 'vazio';
  document.getElementById('cm-base-wrap').style.display = isNew ? '' : 'none';
  document.getElementById('cm-del').style.display = (!isNew && Object.keys(store.concursos).length > 1) ? '' : 'none';
  document.getElementById('conc-modal').classList.add('open');
  setTimeout(() => document.getElementById('cm-nome').focus(), 50);
}
function closeConcModal(e) {
  const m = document.getElementById('conc-modal');
  if (!e || e.target === m) m.classList.remove('open');
}
function saveConcModal() {
  const nome = document.getElementById('cm-nome').value.trim();
  if (!nome) { showToast('⚠️', 'Informe o nome do concurso.'); return; }
  const info = {
    concurso: nome,
    cargo: document.getElementById('cm-cargo').value.trim(),
    banca: document.getElementById('cm-banca').value.trim(),
    dataProva: document.getElementById('cm-data').value || '',
    prazo: document.getElementById('cm-prazo').value,
    estrategia: document.getElementById('cm-est').value.trim(),
    notaCorte: parseInt(document.getElementById('cm-corte').value) || 0
  };
  if (concMode === 'edit') {
    Object.assign(CONCURSO_INFO, info);
    persist(); renderConcursoSelect(); renderSidebar(); renderEstrategia(); renderHoje(); renderSimulados();
    document.getElementById('conc-modal').classList.remove('open');
    showToast('✅', 'Concurso atualizado!');
    return;
  }
  persist();
  const id = uniqueId(slugId(nome), Object.keys(store.concursos));
  const base = document.getElementById('cm-base').value;
  store.concursos[id] = { id, info, edital: base === 'copia' ? clone(EDITAL) : [], data: { state:{}, historico:[], revisoes:[], metas:{} } };
  loadConcurso(id); persist(); refreshAll();
  document.getElementById('conc-modal').classList.remove('open');
  showToast('✅', 'Concurso criado!');
  if (!EDITAL.length) { switchTab('edital'); }
}
function deleteConcurso() {
  const ids = Object.keys(store.concursos);
  if (ids.length < 2) { showToast('⚠️', 'Mantenha ao menos um concurso.'); return; }
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de excluir.'); return; }
  askConfirm('Excluir "' + CONCURSO_INFO.concurso + '" com TODO o progresso, histórico e revisões? Isso não pode ser desfeito.', () => {
    snapshot('antes de excluir concurso');
  kbPurge(curId);
  delete store.concursos[curId];
    const next = Object.keys(store.concursos)[0];
    loadConcurso(next); persist(); refreshAll();
    document.getElementById('conc-modal').classList.remove('open');
    showToast('🗑️', 'Concurso excluído.');
  }, 'Excluir');
}

let cfCb = null;

let cfRes = null;
function askConfirm(msg, cb, okLabel) {
  if (typeof cb !== 'function') { okLabel = cb; cb = null; }
  return new Promise(res => {
    const m = document.getElementById('cf-msg'); m.textContent = msg; m.style.whiteSpace = 'pre-line';
    document.getElementById('cf-ok').textContent = okLabel || 'Confirmar';
    cfCb = cb; cfRes = res; document.getElementById('cf-modal').classList.add('open');
  });
}
function cfClose(ok) {
  document.getElementById('cf-modal').classList.remove('open');
  const cb = cfCb, r = cfRes; cfCb = null; cfRes = null;
  if (ok && cb) cb();
  if (r) r(!!ok);
}

// ── EDITOR DE MATÉRIAS ──────────────────────────────────
let edW = null;
let edConfirmed = false;
function openEditEdital() {
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de editar as matérias.'); return; }
  edW = EDITAL.map(d => ({
    id: d.id, on: d.nome, nome: d.nome, peso: d.peso || 3, dica: d.dica || '', bizus: bizusFor(d).join('\n'),
    grupos: d.grupos.map(g => ({
      nome: g.nome,
      topicos: g.topicos.map((t, i) => ({ t, ot: t, o: d.id + '_' + slug(g.nome) + '_' + i }))
    }))
  }));
  renderEdEditor();
  document.getElementById('ed-modal').classList.add('open');
}
function closeEditEdital() { document.getElementById('ed-modal').classList.remove('open'); const n = document.getElementById('ed-note'); if (n) n.style.display = 'none'; edW = null; }

function renderEdEditor() {
  const box = document.getElementById('ed-body');
  const top = box.scrollTop;
  if (!edW.length) {
    box.innerHTML = '<div class="rev-empty">Nenhuma matéria ainda. Clique em “＋ Matéria” para começar.</div>';
    return;
  }
  box.innerHTML = edW.map((d, di) => `
    <div class="ed-disc">
      <div class="ed-row">
        <input class="man-inp ed-disc-name" value="${escOpt(d.nome)}" placeholder="Nome da matéria" oninput="edW[${di}].nome=this.value">
        <button class="ed-ib" title="Subir" onclick="edMove(${di},-1,-1,-1)">↑</button>
        <button class="ed-ib" title="Descer" onclick="edMove(${di},-1,-1,1)">↓</button>
        <button class="ed-ib del" title="Remover matéria" onclick="edDel(${di},-1,-1)">🗑</button>
      </div>
      <div class="ed-row"><label class="xlbl" style="margin:0;white-space:nowrap">Prioridade</label>
        <select class="man-inp" style="max-width:170px;flex:none" onchange="edW[${di}].peso=parseInt(this.value)">${[5,4,3,2,1].map(n => `<option value="${n}"${(d.peso||3)===n?' selected':''}>${'★'.repeat(n)} ${['','mínima','baixa','média','alta','máxima'][n]}</option>`).join('')}</select>
      </div>
      <textarea class="man-inp" rows="2" placeholder="💡 Estratégia desta matéria" oninput="edW[${di}].dica=this.value" style="resize:vertical;font-size:12px">${escOpt(d.dica||'')}</textarea>
      <textarea class="man-inp" rows="4" placeholder="🧠 Bizus e macetes (um por linha, no formato: SIGLA — significado)" oninput="edW[${di}].bizus=this.value" style="resize:vertical;font-size:12px">${escOpt(d.bizus||'')}</textarea>
      ${d.grupos.map((g, gi) => `
        <div class="ed-group">
          <div class="ed-row">
            <input class="man-inp ed-group-name" value="${escOpt(g.nome)}" placeholder="Nome do grupo / bloco" oninput="edW[${di}].grupos[${gi}].nome=this.value">
            <button class="ed-ib" title="Subir" onclick="edMove(${di},${gi},-1,-1)">↑</button>
            <button class="ed-ib" title="Descer" onclick="edMove(${di},${gi},-1,1)">↓</button>
            <button class="ed-ib del" title="Remover grupo" onclick="edDel(${di},${gi},-1)">🗑</button>
          </div>
          ${g.topicos.map((t, ti) => `
            <div class="ed-row ed-topic">
              <input class="man-inp" value="${escOpt(t.t)}" placeholder="Tópico" oninput="edW[${di}].grupos[${gi}].topicos[${ti}].t=this.value">
              <button class="ed-ib" title="Subir" onclick="edMove(${di},${gi},${ti},-1)">↑</button>
              <button class="ed-ib" title="Descer" onclick="edMove(${di},${gi},${ti},1)">↓</button>
              <button class="ed-ib del" title="Remover tópico" onclick="edDel(${di},${gi},${ti})">🗑</button>
            </div>`).join('')}
          <div class="ed-row" style="gap:8px;flex-wrap:wrap">
            <button class="ed-add" onclick="edAddTopic(${di},${gi})">＋ Tópico</button>
            <button class="ed-add" onclick="edTogglePaste('${di}-${gi}')">📥 Colar vários</button>
          </div>
          <div class="ed-paste" id="edp-${di}-${gi}">
            <textarea class="man-inp" id="edpt-${di}-${gi}" placeholder="Cole aqui, um tópico por linha"></textarea>
            <button class="ed-add" style="border-style:solid" onclick="edPaste(${di},${gi})">Adicionar estes tópicos</button>
          </div>
        </div>`).join('')}
      <button class="ed-add" onclick="edAddGroup(${di})">＋ Grupo</button>
    </div>`).join('');
  box.scrollTop = top;
}
function edAddDisc() {
  edW.push({ id: null, on: null, nome: '', peso: 3, dica: '', bizus: '', grupos: [{ nome: 'Geral', topicos: [] }] });
  renderEdEditor();
  const box = document.getElementById('ed-body'); box.scrollTop = box.scrollHeight;
}
function edAddGroup(di) { edW[di].grupos.push({ nome: '', topicos: [] }); renderEdEditor(); }
function edAddTopic(di, gi) { edW[di].grupos[gi].topicos.push({ t: '', ot: null, o: null }); renderEdEditor(); }
function edTogglePaste(k) { const el = document.getElementById('edp-' + k); el.style.display = el.style.display === 'flex' ? 'none' : 'flex'; }
function edPaste(di, gi) {
  const txt = document.getElementById('edpt-' + di + '-' + gi).value;
  txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(t => edW[di].grupos[gi].topicos.push({ t, ot: null, o: null }));
  renderEdEditor();
}
function edArr(di, gi, ti) {
  if (gi < 0) return edW;
  if (ti < 0) return edW[di].grupos;
  return edW[di].grupos[gi].topicos;
}
function edIdx(di, gi, ti) { return gi < 0 ? di : ti < 0 ? gi : ti; }
function edMove(di, gi, ti, dir) {
  const arr = edArr(di, gi, ti), i = edIdx(di, gi, ti), j = i + dir;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  renderEdEditor();
}
function edDel(di, gi, ti) {
  const arr = edArr(di, gi, ti), i = edIdx(di, gi, ti);
  arr.splice(i, 1);
  renderEdEditor();
}

function saveEditEdital() {
  const usedIds = edW.filter(d => d.id).map(d => d.id), tidMap = {};
  const usedNames = [];
  const novo = [], newState = {};
  const renames = {};   // nome antigo da matéria -> { nome, tmap }
  const keptTids = {};

  edW.forEach(d => {
    let nome = (d.nome || '').trim(); if (!nome) return;
    let nm = nome, n = 2;
    while (usedNames.indexOf(nm.toLowerCase()) !== -1) nm = nome + ' (' + (n++) + ')';
    nome = nm; usedNames.push(nome.toLowerCase());
    let id = d.id;
    if (!id) { id = uniqueId(slugId(nome), usedIds); usedIds.push(id); }
    const grupos = [], slugs = [], tmap = {};
    d.grupos.forEach(g => {
      const tops = g.topicos.map(t => ({ t: (t.t || '').trim(), ot: t.ot, o: t.o })).filter(t => t.t);
      let gn = (g.nome || '').trim();
      if (!gn && !tops.length) return;
      if (!gn) gn = 'Geral';
      let base = gn, k = 2;
      while (slugs.indexOf(slug(gn)) !== -1) gn = base + ' (' + (k++) + ')';
      slugs.push(slug(gn));
      const topicos = [];
      tops.forEach((t, i) => {
        const tid = id + '_' + slug(gn) + '_' + i;
        if (t.o) tidMap[t.o] = tid;
        if (t.o && state[t.o]) { newState[tid] = state[t.o]; keptTids[t.o] = 1; }
        if (t.ot && t.ot !== t.t) tmap[t.ot] = t.t;
        topicos.push(t.t);
      });
      grupos.push({ nome: gn, topicos });
    });
    novo.push({ id, nome, peso: d.peso || 3, dica: (d.dica || '').trim(), bizus: (d.bizus || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean), grupos });
    if (d.on) renames[d.on] = { nome, tmap };
  });

  const lost = Object.keys(state).filter(k => !keptTids[k] && state[k] && (state[k].done || state[k].acertos || state[k].erros || state[k].questoes)).length;
  if (lost > 0 && !edConfirmed) { askConfirm(lost + ' tópico(s) com progresso serão removidos junto com as matérias/tópicos excluídos. Continuar?', () => { edConfirmed = true; saveEditEdital(); }, 'Remover e salvar'); return; }
  edConfirmed = false;

  const fix = r => {
    const m = renames[r.disc]; if (!m) return;
    r.disc = m.nome;
    if (r.topic && m.tmap[r.topic]) r.topic = m.tmap[r.topic];
  };
  historico.forEach(fix); revisoes.forEach(fix);

  snapshot('antes de alterar matérias');
  const nl = {}; Object.keys(store.kb.link).forEach(k => {
    const p = k.indexOf('|'), c = k.slice(0, p), t = k.slice(p + 1);
    if (c !== curId) { nl[k] = store.kb.link[k]; return; }
    if (tidMap[t]) nl[c + '|' + tidMap[t]] = store.kb.link[k];
  }); store.kb.link = nl;
  EDITAL = novo; state = newState;
  persist(); closeEditEdital(); refreshAll();
  showToast('✅', 'Matérias atualizadas!');
}

// ── BANCO DE BIZUS ──────────────────────────────────────
const BIZ = {
  'lingua-portuguesa': [
    `Crase (macete do "vou a / volto da") — Vou A, volto DA: crase HÁ. Vou A, volto DE: crase pra quê? Ex.: vou à praia (volto da praia); vou a Roma (volto de Roma).`,
    `Por que / porque / por quê / porquê — Por que: pergunta. Porque: resposta. Por quê: final de frase. Porquê: substantivo (vem com artigo: o porquê).`,
    `Mal x mau — Mal é o contrário de bem; mau é o contrário de bom.`,
    `Mas x mais — Mas = porém (adversidade); mais = quantidade.`,
    `Verbo haver no sentido de existir — É impessoal, fica sempre no singular: Havia muitos problemas; Deve haver soluções.`,
    `Verbo fazer indicando tempo — Também é impessoal: Faz dois anos que moro aqui.`,
    `Vírgula — Nunca separe sujeito do verbo nem verbo do complemento. Use para isolar aposto, vocativo, adjunto adverbial deslocado e orações intercaladas.`,
    `Colocação pronominal (palavras atrativas) — Negação, advérbio, pronome relativo/indefinido e conjunção subordinativa atraem o pronome para antes do verbo: Não me disse; Aqui se vive bem.`,
    `Acentuação — Todas as proparoxítonas são acentuadas. Paroxítonas levam acento quando terminam em L, N, R, X, PS, I(S), US, UM(NS), Ã(S), ÃO(S) e ditongo.`,
    `Conjunções adversativas — Mas, porém, contudo, todavia, entretanto, no entanto, não obstante: ideia de oposição.`,
    `Orações coordenadas sindéticas — Aditivas, adversativas, alternativas, conclusivas e explicativas.`,
    `Interpretação — A resposta está no texto: desconfie de alternativas com "sempre", "nunca", "apenas", "somente" e de ideias que o texto não afirmou (extrapolação).`
  ],
  'raciocinio-logico-matematico': [
    `Vera Fischer (condicional) — p → q só é FALSA quando V → F (Vera Fischer: V seguido de F).`,
    `Tabela do E e do OU — E só é verdadeiro se os dois forem verdadeiros. OU só é falso se os dois forem falsos.`,
    `Bicondicional (se e somente se) — Verdadeira quando os dois lados têm o mesmo valor lógico.`,
    `MANE (negação do condicional) — Mantém a primeira E Nega a segunda: ~(p → q) ≡ p ∧ ~q.`,
    `Equivalência do condicional — p → q ≡ ~q → ~p (contrapositiva) ≡ ~p ∨ q (nega a primeira, vira OU, mantém a segunda).`,
    `De Morgan — Negação de E vira OU e negação de OU vira E, negando as duas partes.`,
    `Quantificadores — Negação de "Todo A é B" é "Algum A não é B". Negação de "Algum A é B" é "Nenhum A é B".`,
    `Porcentagem rápida — 10% = divide por 10; 5% = metade de 10%; 1% = divide por 100. Aumento de 20% = multiplica por 1,2; desconto de 20% = multiplica por 0,8.`,
    `Descontos/aumentos sucessivos — Nunca some: multiplique os fatores.`,
    `Regra de três — Direta: multiplica cruzado. Inversa: multiplica em linha (inverte uma coluna).`,
    `Probabilidade — Casos favoráveis ÷ casos possíveis. "E" multiplica, "OU" soma.`,
    `Arranjo x combinação — A ordem importa? Sim: arranjo/permutação. Não: combinação.`
  ],
  'nocoes-de-informatica': [
    `DICA da segurança — Disponibilidade, Integridade, Confidencialidade, Autenticidade (pilares da segurança da informação).`,
    `Vírus x worm x trojan — Vírus precisa de hospedeiro; worm se propaga sozinho pela rede; trojan (cavalo de Troia) parece programa legítimo.`,
    `Ransomware e spyware — Ransomware sequestra dados e pede resgate; spyware espia o usuário; phishing é a isca (mensagem falsa para roubar dados).`,
    `Firewall x antivírus — Firewall filtra o tráfego da rede; antivírus detecta e remove malware. Um não substitui o outro.`,
    `Tipos de backup — Completo: tudo. Incremental: só o que mudou desde o último backup (qualquer tipo). Diferencial: o que mudou desde o último completo.`,
    `E-mail — SMTP envia (Sai); POP3 e IMAP recebem (Pegam).`,
    `Atalhos do Word (pt-BR) — Ctrl+N negrito, Ctrl+I itálico, Ctrl+S sublinhado, Ctrl+B salvar, Ctrl+C copiar, Ctrl+X recortar, Ctrl+V colar, Ctrl+Z desfazer, Ctrl+Y refazer.`,
    `Excel — Toda fórmula começa com =. Referência absoluta usa $ (F4 alterna). Funções-base: SOMA, MÉDIA, MÁXIMO, MÍNIMO, SE, PROCV, CONT.SE.`,
    `Navegador — Modo anônimo não esconde você do site, do provedor nem do empregador: só não guarda histórico local. Anônimo: Ctrl+Shift+N (Chrome), Ctrl+Shift+P (Firefox).`,
    `HTTPS — Cadeado indica conexão criptografada, não garante que o site seja confiável.`
  ],
  'direito-constitucional': [
    `SOCIDIVAPLU (art. 1º) — SOberania, CIdadania, DIgnidade da pessoa humana, VAlores sociais do trabalho e da livre iniciativa, PLUralismo político. Fundamentos da República.`,
    `Objetivos fundamentais (art. 3º) — Verbos: Construir, Garantir, Erradicar (e reduzir), Promover.`,
    `Poderes (art. 2º) — Legislativo, Executivo e Judiciário: independentes e harmônicos entre si.`,
    `LIMPE (art. 37) — Legalidade, Impessoalidade, Moralidade, Publicidade, Eficiência: princípios da administração pública.`,
    `Cláusulas pétreas (art. 60, §4º) — Forma federativa, Voto direto/secreto/universal/periódico, Separação de poderes, Direitos e garantias individuais.`,
    `Remédios constitucionais — HC: liberdade de locomoção. HD: informações pessoais. MS: direito líquido e certo (não protegido por HC/HD). MI: falta de norma regulamentadora. Ação popular: ato lesivo ao patrimônio público, moralidade, meio ambiente.`,
    `Gratuidade — HC e HD são gratuitos. Ação popular também é isenta de custas, salvo má-fé.`,
    `Casa é asilo inviolável (art. 5º, XI) — De DIA: consentimento, flagrante, desastre, socorro ou ordem judicial. De NOITE: tudo isso, menos ordem judicial.`,
    `Prisão (art. 5º, LXI) — Só em flagrante delito ou por ordem escrita e fundamentada de autoridade judiciária competente (exceto transgressão e crime militar).`,
    `Idades mínimas para candidatura — 35 anos: Presidente, Vice-Presidente e Senador. 30: Governador. 21: Deputado, Prefeito e Juiz de Paz. 18: Vereador.`,
    `Segurança pública (art. 144) — Polícia Federal, PRF, Polícia Ferroviária Federal, Polícias Civis, Polícias Militares e Bombeiros Militares, Polícias Penais.`,
    `Guarda municipal (art. 144, §8º) — Municípios podem criar guardas para proteção de seus bens, serviços e instalações.`
  ],
  'direito-administrativo': [
    `LIMPE — Legalidade, Impessoalidade, Moralidade, Publicidade, Eficiência.`,
    `COMFIFORMOB (elementos do ato) — COMpetência, FInalidade, FORMa, MOtivo, OBjeto. Competência, finalidade e forma são sempre vinculados; motivo e objeto podem ser discricionários.`,
    `PATI (atributos do ato) — Presunção de legitimidade, Autoexecutoriedade, Tipicidade, Imperatividade (e exigibilidade).`,
    `Anulação x revogação — Anulação: ilegalidade (Administração e Judiciário). Revogação: conveniência e oportunidade (só a Administração). Súmulas 346 e 473 do STF.`,
    `Poderes administrativos — Vinculado, discricionário, hierárquico, disciplinar, regulamentar e de polícia.`,
    `Responsabilidade civil do Estado (art. 37, §6º) — Objetiva (risco administrativo) para ação; em regra subjetiva para omissão. Direito de regresso contra o agente com dolo ou culpa.`,
    `Modalidades de licitação (Lei 14.133/2021) — Pregão, concorrência, concurso, leilão e diálogo competitivo (acabaram convite e tomada de preços).`,
    `Improbidade (Lei 8.429/92, após Lei 14.230/2021) — Art. 9: enriquecimento ilícito. Art. 10: prejuízo ao erário. Art. 11: violação de princípios. Agora só pune conduta DOLOSA.`,
    `Estabilidade — 3 anos de efetivo exercício e avaliação especial de desempenho (art. 41 CF).`,
    `Silêncio administrativo — Em regra não significa aprovação nem negativa: a Administração deve decidir.`
  ],
  'legislacao-de-transito-ctb': [
    `Pontos por gravidade — Leve 3, média 4, grave 5, gravíssima 7.`,
    `Multas base — Leve R$ 88,38; média R$ 130,16; grave R$ 195,23; gravíssima R$ 293,47 (confira se houve atualização).`,
    `Suspensão por pontos (Lei 14.071/2020) — 20 pontos se houver 2 ou mais gravíssimas; 30 pontos se 1 gravíssima; 40 pontos se nenhuma gravíssima (no período de 12 meses).`,
    `Categorias da CNH — A: moto. B: carro até 3.500 kg e 8 passageiros. C: carga acima de 3.500 kg. D: mais de 8 passageiros. E: combinação com reboque acima de 6.000 kg.`,
    `Idade e permissão — Habilitação a partir de 18 anos. Permissão para Dirigir (PPD) vale 1 ano; só vira CNH se não houver infração grave/gravíssima ou reincidência em média.`,
    `Velocidade em via urbana sem sinalização (30-40-60-80) — Local 30; coletora 40; arterial 60; trânsito rápido 80 km/h. Em rodovias confira o art. 61 atualizado.`,
    `Álcool: infração x crime — Infração (art. 165): qualquer concentração, multa gravíssima x10 e suspensão de 12 meses. Crime (art. 306): a partir de 0,3 mg/L de ar alveolar (6 dg/L de sangue) ou sinais de alteração. Recusar o teste (art. 165-A) tem a mesma penalidade administrativa.`,
    `Infrações gravíssimas clássicas — Avançar sinal vermelho (7 pontos); dirigir sem CNH (multa x3); embriaguez. Cinto de segurança é grave (5 pontos); celular ao volante é média (4 pontos).`,
    `Crimes de trânsito — Homicídio culposo (art. 302): detenção 2 a 4 anos + suspensão/proibição. Lesão culposa: 6 meses a 2 anos. Omissão de socorro (art. 304) e fuga do local (art. 305): 6 meses a 1 ano. Racha (art. 308): 6 meses a 3 anos.`,
    `Sistema Nacional de Trânsito — CONTRAN (órgão máximo normativo), CETRAN/CONTRANDIFE, órgãos executivos de trânsito e rodoviários, PRF, PM (conforme convênio), JARI (recursos).`,
    `Dica de prova — Questão de CTB costuma trocar número (pontos, prazos, velocidades) e verbo (pode x deve). Leia o artigo ao lado da questão.`
  ],
  'direito-penal': [
    `Crime = fato típico + ilícito + culpável — Fato típico: conduta, resultado, nexo causal e tipicidade. Culpabilidade: imputabilidade, potencial consciência da ilicitude e exigibilidade de conduta diversa.`,
    `Excludentes de ilicitude — Legítima defesa, estado de necessidade, estrito cumprimento do dever legal e exercício regular de direito.`,
    `Legítima defesa — Agressão injusta, atual ou iminente + uso moderado dos meios necessários.`,
    `Culpa: imprudência, negligência, imperícia — Imprudência: age de forma perigosa (ação). Negligência: deixa de tomar cuidado (omissão). Imperícia: falta de técnica na profissão.`,
    `Menoridade penal — Menores de 18 anos são inimputáveis.`,
    `Roubo x extorsão — Roubo: o agente subtrai com violência ou grave ameaça. Extorsão: obriga a vítima a fazer ou deixar de fazer algo (a colaboração da vítima é necessária).`,
    `Latrocínio — Roubo seguido de morte (hediondo).`,
    `Corrupção passiva x ativa — Passiva: funcionário solicita, recebe ou aceita promessa. Ativa: particular oferece ou promete.`,
    `Funcionário público (art. 327) — Quem exerce cargo, emprego ou função pública, mesmo transitoriamente ou sem remuneração.`
  ],
  'direito-processual-penal': [
    `Flagrante (art. 302) — Próprio: cometendo ou acabou de cometer. Impróprio: perseguido logo após. Presumido: encontrado logo depois com instrumentos ou objetos do crime.`,
    `Quem pode prender em flagrante — Qualquer do povo PODE; autoridade policial e seus agentes DEVEM.`,
    `Audiência de custódia — Preso deve ser apresentado ao juiz em até 24 horas.`,
    `Inquérito policial — Inquisitivo, escrito e sigiloso; é dispensável. Prazo: 10 dias se preso, 30 dias se solto (regra do CPP).`,
    `Preventiva — Indícios de autoria e prova da materialidade + garantia da ordem pública/econômica, conveniência da instrução ou aplicação da lei penal.`,
    `Ação penal — Pública incondicionada (regra), pública condicionada à representação e privada.`
  ],
  'direitos-humanos': [
    `Gerações de direitos — 1ª: liberdade; 2ª: igualdade; 3ª: fraternidade/solidariedade.`,
    `Datas e tratados — DUDH: 1948. Pacto de São José da Costa Rica (CADH): 1969, com Corte Interamericana. Convenção da ONU contra a Tortura: 1984.`,
    `Status dos tratados de direitos humanos — Aprovados com quórum de emenda (3/5, dois turnos, nas duas Casas): valor de emenda constitucional. Sem esse quórum: supralegais.`,
    `Tortura — Lei 9.455/97; crime inafiançável e insuscetível de graça ou anistia (CF, art. 5º, XLIII).`
  ],
  'legislacao-especial': [
    `Lei de Drogas (11.343/06) — Porte para consumo pessoal (art. 28): advertência, prestação de serviços, medida educativa; sem prisão. Tráfico (art. 33): 5 a 15 anos; pode ter redução de 1/6 a 2/3 (tráfico privilegiado).`,
    `Estatuto do Desarmamento (10.826/03) — Posse (em casa ou no trabalho, do titular): art. 12, detenção 1 a 3 anos. Porte ilegal de uso permitido (art. 14): reclusão 2 a 4 anos. Uso restrito (art. 16): 3 a 6 anos.`,
    `Abuso de autoridade (13.869/19) — Exige finalidade específica: prejudicar outrem, beneficiar a si ou a terceiro, ou mero capricho ou satisfação pessoal. Ação penal pública incondicionada.`,
    `Organização criminosa (12.850/13) — 4 ou mais pessoas, estruturalmente ordenadas, com divisão de tarefas, para crimes com pena máxima acima de 4 anos ou de caráter transnacional.`,
    `Crimes hediondos e equiparados — Tortura, tráfico e terrorismo são inafiançáveis e insuscetíveis de graça e anistia (CF, art. 5º, XLIII).`
  ],
  'fisica': [
    `MRU e MRUV — MRU: S = S0 + v·t. MRUV: v = v0 + a·t; S = S0 + v0·t + a·t²/2; Torricelli: v² = v0² + 2·a·ΔS.`,
    `km/h para m/s — Divide por 3,6 (e m/s para km/h multiplica por 3,6).`,
    `2ª lei de Newton — F = m·a. Ação e reação atuam em corpos diferentes, por isso não se anulam.`,
    `Energia — Cinética: m·v²/2. Potencial gravitacional: m·g·h. Trabalho: F·d·cosθ. Potência: trabalho ÷ tempo.`,
    `Frenagem — A distância de frenagem cresce com o quadrado da velocidade: dobrou a velocidade, a distância quadruplica.`
  ],
  'etica-no-servico-publico': [
    `Comissão de Ética (Decreto 1.171/94) — A pena aplicável pela comissão é a censura.`,
    `Sigilo na LAI (Lei 12.527/11) — Ultrassecreto 25 anos; secreto 15 anos; reservado 5 anos.`
  ],
  'geopolitica': [
    `Faixa de fronteira — 150 km de largura ao longo das fronteiras terrestres (CF, art. 20, §2º).`,
    `Mar — Mar territorial 12 milhas; zona contígua 24 milhas; zona econômica exclusiva 200 milhas.`,
    `Numeração das BRs (PRF) — 0xx radiais (partem de Brasília); 1xx longitudinais (norte-sul); 2xx transversais (leste-oeste); 3xx diagonais; 4xx de ligação.`
  ],
  'direito-do-consumidor': [
    `Prazos de vício (decadência) — Produto/serviço não durável: 30 dias. Durável: 90 dias (art. 26).`,
    `Fato do produto ou serviço — Prescrição em 5 anos (art. 27).`,
    `Arrependimento — 7 dias para desistir de compra feita fora do estabelecimento, como internet e telefone (art. 49), com devolução de tudo.`,
    `Inversão do ônus da prova — A critério do juiz, quando houver verossimilhança da alegação OU hipossuficiência do consumidor.`,
    `Repetição do indébito — Cobrança indevida paga: devolve em dobro, salvo engano justificável (art. 42, parágrafo único).`,
    `Responsabilidade — Objetiva do fornecedor; a do profissional liberal é subjetiva (verificação de culpa).`,
    `Consumidor por equiparação — Toda a coletividade de pessoas, vítimas do evento e expostas às práticas comerciais (arts. 2º, p.ú., 17 e 29).`,
    `Cadastros de inadimplentes — Informação negativativa por no máximo 5 anos.`,
    `Oferta — A oferta suficientemente precisa vincula o fornecedor (art. 30).`,
    `Superendividamento (Lei 14.181/21) — Garante o mínimo existencial e prevê conciliação em bloco com os credores.`
  ],
  'nocoes-de-direito-civil': [
    `Incapacidade — Absolutamente incapazes: menores de 16 anos. Relativamente: de 16 a 18, ébrios habituais, viciados em tóxicos, quem não pode exprimir vontade e pródigos.`,
    `Defeitos do negócio jurídico — Erro, dolo, coação, lesão, estado de perigo e fraude contra credores (anulável). Simulação gera nulidade.`
  ],
  'legislacao-especifica-da-guarda-municipal': [
    `Lei 13.022/14, art. 3º — Princípios: proteção dos direitos humanos, preservação da vida, patrulhamento preventivo, compromisso com a evolução social da comunidade e uso progressivo da força.`,
    `Guarda protege bens, serviços e instalações — Foco da guarda municipal (CF, art. 144, §8º): patrimônio do município, sem competência de polícia judiciária.`,
    `Uso da força — Legalidade, necessidade e proporcionalidade (Lei 13.060/14: instrumentos de menor potencial ofensivo).`,
    `Flagrante — Qualquer do povo pode prender em flagrante; o agente de segurança deve.`,
    `SUSP — Guardas municipais integram operacionalmente o Sistema Único de Segurança Pública (Lei 13.675/18).`
  ],
  'conhecimentos-gerais-e-atualidades': [
    `Atualidades — Leia resumos dos últimos 12 meses e treine com questões antigas da banca. Foque em segurança pública, economia, meio ambiente e política.`,
    `Fusos do Brasil — 4 fusos: -2 (ilhas oceânicas), -3 (Brasília), -4 (AM, MT, MS, RO, RR) e -5 (AC e sul do AM).`
  ],
  'administracao-geral-e-publica': [
    `PODC — Planejar, Organizar, Dirigir, Controlar: funções da administração.`,
    `Eficiência x eficácia x efetividade — Eficiência: fazer certo (meios). Eficácia: atingir o objetivo (fins). Efetividade: impacto e resultado duradouro.`
  ],
  'arquivologia-e-gestao-documental': [
    `Três idades — Corrente (uso frequente), intermediária (uso eventual) e permanente (valor histórico).`,
    `Princípios — Proveniência (respeito aos fundos) e organicidade; ordem original preservada.`,
    `Tabela de temporalidade — Define prazos de guarda e a destinação final: eliminação ou guarda permanente.`
  ],
  'legislacao-aplicada-ao-servidor': [
    `Penalidades (Lei 8.112/90) — Advertência, suspensão (até 90 dias), demissão, cassação de aposentadoria ou disponibilidade, destituição de cargo em comissão e de função comissionada.`,
    `Prescrição disciplinar — Advertência: 180 dias. Suspensão: 2 anos. Demissão, cassação e destituição: 5 anos.`,
    `Estágio probatório — A Constituição fala em 3 anos de efetivo exercício (art. 41); cuidado com o texto antigo de 24 meses.`
  ],
  'historia-do-brasil': [
    `República Velha (1889-1930) — Política do café com leite (SP e MG se alternam), coronelismo e voto de cabresto.`,
    `Era Vargas — Governo Provisório 1930-34; Constitucional 1934-37; Estado Novo 1937-45.`,
    `Regime militar — Golpe de 1964; AI-5 em 1968; redemocratização com Diretas Já e Constituição de 1988.`,
    `Constituições do Brasil — 1824, 1891, 1934, 1937, 1946, 1967 (e emenda de 1969) e 1988.`
  ],
  'historia-do-maranhao': [
    `França Equinocial — 1612, expedição de Daniel de La Touche; fundação de São Luís em 8 de setembro de 1612.`,
    `Guaxenduba — Batalha de 19 de novembro de 1614 que levou à expulsão dos franceses.`,
    `Invasão holandesa — Holandeses ocuparam São Luís de 1641 a 1644.`,
    `Revolta de Beckman — 1684, contra o monopólio da Companhia de Comércio do Maranhão e Grão-Pará (criada em 1682).`,
    `Independência — O Maranhão aderiu em 28 de julho de 1823; a Batalha do Jenipapo (13 de março de 1823, no Piauí) opôs tropas fiéis a Portugal.`,
    `Balaiada — 1838-1841; lideranças Manuel Balaio, Raimundo Gomes e Cosme Bento; reprimida por Caxias.`
  ],
  'geografia-do-brasil': [
    `Estados e fusos — 26 estados + DF (27 unidades); 4 fusos horários.`,
    `Extremos — Maior estado: Amazonas. Menor: Sergipe. Mais populoso: São Paulo.`
  ],
  'geografia-do-maranhao': [
    `Limites — Piauí a leste, Tocantins ao sul e sudoeste, Pará a oeste e Oceano Atlântico ao norte.`,
    `Vegetação — Amazônia a oeste, Cerrado ao sul e centro, Caatinga a leste e Cocais na transição.`,
    `Rios — Limítrofes: Parnaíba, Gurupi e Tocantins. Genuinamente maranhenses: Mearim, Itapecuru, Pindaré, Munim, entre outros.`,
    `Parques nacionais — Lençóis Maranhenses e Chapada das Mesas.`
  ],
  'legislacao-pertinente-a-pmma': [
    `Decreto 88.777/83 — É o R-200 (regulamento para as polícias e corpos de bombeiros militares).`,
    `Decreto-Lei 1.001/69 — Código Penal Militar (CPM).`
  ]
};
const BIZ_ALIAS = {
  'matematica-e-raciocinio-logico': 'raciocinio-logico-matematico',
  'nocoes-de-administracao-publica': 'administracao-geral-e-publica'
};
function bizusFor(d) {
  if (Array.isArray(d.bizus)) return d.bizus;
  let k = BIZ_ALIAS[d.id] || d.id;
  if (!BIZ[k] && k.indexOf('nocoes-de-informatica') === 0) k = 'nocoes-de-informatica';
  return BIZ[k] || [];
}
function bizItemHtml(s) {
  const i = s.indexOf(' — ');
  return i > 0 ? '<b>' + escOpt(s.slice(0, i)) + '</b> — ' + escOpt(s.slice(i + 3)) : escOpt(s);
}
function bizusHtml(d) {
  const b = bizusFor(d); if (!b.length) return '';
  return '<details class="biz-box"><summary>🧠 Banco de bizus (' + b.length + ')</summary><ul>' + b.map(s => '<li>' + bizItemHtml(s) + '</li>').join('') + '</ul></details>';
}
function renderBizus() {
  const el = document.getElementById('biz-list'); if (!el) return;
  const q = normTopic((document.getElementById('biz-search') || {}).value || '');
  let n = 0;
  const html = EDITAL.map(d => {
    const items = bizusFor(d).filter(s => !q || normTopic(s + ' ' + d.nome).indexOf(q) !== -1);
    if (!items.length) return '';
    n += items.length;
    return '<div class="biz-disc"><h3>' + escOpt(d.nome) + ' ' + pesoBadge(d) + '</h3><ul class="biz-box" style="border:none;padding:0;margin:0;background:none"><ul style="list-style:none;display:flex;flex-direction:column;gap:6px">' + items.map(s => '<li class="biz-li" style="font-size:12.5px;line-height:1.55;color:#78350f;padding-left:12px;border-left:3px solid #fcd34d">' + bizItemHtml(s) + '</li>').join('') + '</ul></ul></div>';
  }).join('');
  el.innerHTML = html || '<div class="rev-empty">Nenhum bizu encontrado' + (q ? ' para essa busca' : ' neste concurso') + '.<br>Use ✏️ Editar matérias para adicionar os seus.</div>';
}

// ── PRIORIDADE, ESTRATÉGIA, MODELO DE REVISÃO ───────────
function pesoBadge(d) { const p = d.peso || 0; return p ? '<span class="peso-b" title="Prioridade de estudo">' + '★'.repeat(p) + '</span>' : ''; }
function renderEstrategia() {
  const el = document.getElementById('est-box'); if (!el) return;
  const t = (CONCURSO_INFO.estrategia || '').trim();
  el.innerHTML = t ? '<details class="est-box" open><summary>🎯 Estratégia: ' + escOpt(CONCURSO_INFO.concurso) + '</summary><div>' + escOpt(t) + '</div></details>' : '';
}
function renderPlano() {
  const el = document.getElementById('plano-ataque'); if (!el) return;
  if (!EDITAL.length) { el.innerHTML = ''; return; }
  const rows = EDITAL.map((d, i) => {
    const s = getDiscStats(d), concl = s.totalTopicos ? s.concluidos / s.totalTopicos : 0, peso = d.peso || 3;
    const erro = s.total > 0 ? (1 - s.pct / 100) : 0.3;
    return { d, s, concl, peso, score: peso * (1 - concl) + peso * erro * 0.5 };
  }).filter(r => r.concl < 1).sort((a, b) => b.score - a.score).slice(0, 5);
  if (!rows.length) { el.innerHTML = '<div class="sec-lbl">🎯 Plano de ataque</div><div class="pro-note"><div class="hint-icon">🏁</div><div>Todas as matérias concluídas. Agora é revisão, questões e simulados.</div></div>'; return; }
  el.innerHTML = '<div class="sec-lbl">🎯 Plano de ataque: o que estudar agora</div><div class="plano">' + rows.map((r, n) =>
    `<div class="plano-row" onclick="switchTab('edital');goDisc('${r.d.id}')">
      <div class="plano-n">${n + 1}</div>
      <div class="plano-main"><div class="plano-nm">${escOpt(r.d.nome)} ${pesoBadge(r.d)}</div>
        <div class="plano-sub">${Math.round(r.concl * 100)}% concluído · ${r.s.total > 0 ? r.s.pct + '% de acerto' : 'sem questões ainda'}</div>
        <div class="plano-bar"><div class="plano-fill" style="width:${Math.round(r.concl * 100)}%"></div></div></div>
    </div>`).join('') + '</div><div style="font-size:11px;color:var(--text-soft);margin-top:6px">Ordenado por prioridade da matéria × quanto falta concluir × taxa de erro.</div>';
}
function setRevModel(days) {
  clearRevBtns();
  document.querySelectorAll('[data-days]').forEach(b => { if (days.indexOf(parseInt(b.dataset.days)) !== -1) b.classList.add('done'); });
  updateRevSelected();
}

// Conteúdo base dos concursos pré-cadastrados (a partir dos editais anteriores; confirme no edital novo)
function D(nome, peso, dica, grupos) {
  return { id: slugId(nome), nome, peso, dica, grupos: Object.keys(grupos).map(g => ({ nome: g, topicos: grupos[g] })) };
}
const B = {
  port: () => D('Língua Portuguesa', 5, 'Maior volume de questões em quase todos os editais. Interpretação todos os dias (texto + questões) e gramática por regra, sempre fechando com questões da banca. Meta mínima: 30 questões por semana.', {
    'Interpretação e tipologia textual': ['Compreensão e interpretação de textos', 'Tipologia e gêneros textuais', 'Coesão e coerência', 'Ortografia oficial e acentuação gráfica'],
    'Gramática aplicada': ['Classes de palavras', 'Sintaxe do período: coordenação e subordinação', 'Concordância verbal e nominal', 'Regência verbal e nominal e crase', 'Pontuação', 'Colocação pronominal', 'Emprego de tempos e modos verbais'],
    'Reescrita e semântica': ['Significação das palavras', 'Reescrita de frases e parágrafos', 'Substituição e reorganização de trechos'] }),
  rl: (nome) => D(nome || 'Raciocínio Lógico-Matemático', 4, 'Comece pelo que mais cai: proposições, equivalências e negações, porcentagem, razão/proporção e regra de três. Resolva sempre no papel. Se a banca for Cebraspe (certo/errado), não chute sem segurança: item errado anula item certo.', {
    'Lógica': ['Proposições e conectivos', 'Equivalências e negações', 'Argumentação e diagramas lógicos', 'Verdades e mentiras'],
    'Matemática básica': ['Porcentagem, razão e proporção', 'Regra de três', 'Conjuntos', 'Equações e problemas'],
    'Contagem e probabilidade': ['Análise combinatória', 'Probabilidade', 'Sequências'] }),
  info: (peso) => D('Noções de Informática', peso || 3, 'Pontos baratos: faça muitas questões. Foque em segurança da informação, atalhos e fórmulas básicas de Excel, Word e navegadores.', {
    'Sistemas e aplicativos': ['Windows e Linux: arquivos e pastas', 'Editor de texto, planilha e apresentação (Word, Excel, PowerPoint e LibreOffice)'],
    'Internet e redes': ['Conceitos de Internet e intranet', 'Navegadores e correio eletrônico', 'Redes de computadores', 'Computação em nuvem'],
    'Segurança': ['Vírus, worms e pragas virtuais', 'Antivírus, firewall e backup', 'Golpes: phishing, ransomware e engenharia social'] }),
  const: (peso) => D('Direito Constitucional', peso || 4, 'Foque na letra da Constituição: art. 5º (direitos fundamentais), art. 37 (administração pública) e art. 144 (segurança pública) são os mais cobrados. Leia o texto junto com questões.', {
    'Fundamentos': ['Princípios fundamentais (arts. 1º a 4º)', 'Direitos e garantias individuais e coletivos (art. 5º)', 'Direitos sociais, nacionalidade e direitos políticos'],
    'Organização do Estado': ['Organização político-administrativa', 'União, Estados, Distrito Federal e Municípios', 'Administração pública (art. 37)', 'Servidores públicos'],
    'Poderes e defesa': ['Poder Legislativo', 'Poder Executivo', 'Poder Judiciário e funções essenciais à Justiça', 'Defesa do Estado e segurança pública (art. 144)'] }),
  adm: () => D('Direito Administrativo', 4, 'Domine princípios, atos administrativos, poderes e responsabilidade civil. Estude as leis atualizadas: Lei 14.133/2021 (licitações) e Lei 8.429/92 com as mudanças da Lei 14.230/2021.', {
    'Fundamentos': ['Princípios da administração pública', 'Organização administrativa: direta e indireta', 'Poderes administrativos'],
    'Atos e agentes': ['Atos administrativos', 'Agentes públicos', 'Responsabilidade civil do Estado'],
    'Contratação e controle': ['Licitações e contratos (Lei 14.133/2021)', 'Improbidade administrativa', 'Processo administrativo (Lei 9.784/99)', 'Controle da administração'] }),
  ctb: () => D('Legislação de Trânsito (CTB)', 5, 'Matéria que mais decide a prova. Leia o CTB artigo por artigo junto com questões, sempre na versão atualizada. Decore pontuação por gravidade (leve 3, média 4, grave 5, gravíssima 7), prazos e competências. Mantenha um caderno de atualização das resoluções do CONTRAN.', {
    'Sistema e normas de circulação': ['Sistema Nacional de Trânsito e competências', 'Normas gerais de circulação e conduta', 'Pedestres e ciclistas', 'Veículos: registro, licenciamento e equipamentos', 'Sinalização de trânsito'],
    'Habilitação e penalidades': ['Habilitação (CNH) e condutores', 'Infrações e penalidades', 'Medidas administrativas', 'Pontuação e suspensão ou cassação do direito de dirigir'],
    'Crimes e processo': ['Crimes de trânsito', 'Processo administrativo: autuação, defesa e recursos'],
    'Resoluções do CONTRAN': ['Habilitação e fiscalização', 'Veículos e equipamentos', 'Sinalização e processo administrativo'] }),
  penal: (peso) => D('Direito Penal', peso || 4, 'Comece por teoria do crime e aplicação da lei penal; depois crimes em espécie (pessoa, patrimônio, administração pública). Leia o Código Penal junto com questões.', {
    'Parte geral': ['Aplicação da lei penal', 'Teoria do crime: fato típico, ilicitude e culpabilidade', 'Concurso de pessoas', 'Penas'],
    'Crimes em espécie': ['Crimes contra a pessoa', 'Crimes contra o patrimônio', 'Crimes contra a administração pública'] }),
  proc: (peso) => D('Direito Processual Penal', peso || 4, 'Foque em inquérito policial, prisões e medidas cautelares, provas e ação penal. Leia o CPP com questões.', {
    'Investigação e ação': ['Inquérito policial', 'Ação penal', 'Competência'],
    'Provas e prisões': ['Provas', 'Prisão em flagrante, preventiva e temporária', 'Medidas cautelares'] }),
  dh: () => D('Direitos Humanos', 3, 'Estude os tratados mais cobrados (Declaração Universal, Pacto de São José e Convenção contra a Tortura) e a atuação policial com respeito aos direitos humanos.', {
    'Fundamentos': ['Teoria geral e gerações de direitos', 'Declaração Universal dos Direitos Humanos'],
    'Sistemas de proteção': ['Sistema interamericano e Pacto de São José', 'Convenção contra a Tortura', 'Direitos humanos e segurança pública no Brasil'] }),
  gm: (extra) => D('Legislação Específica da Guarda Municipal', 5, 'É o que diferencia o guarda dos demais candidatos. Leia o Estatuto Geral das Guardas Municipais inteiro e a lei municipal de criação, e faça questões da banca.', {
    'Legislação federal': ['Lei 13.022/2014: Estatuto Geral das Guardas Municipais', 'Uso de instrumentos de menor potencial ofensivo (Lei 13.060/2014)', 'Abuso de autoridade (Lei 13.869/2019)', 'CTB: atribuições do agente de trânsito municipal'],
    'Legislação municipal': extra }),
  gerais: () => D('Conhecimentos Gerais e Atualidades', 3, 'Leia resumos de atualidades dos últimos 12 meses e dados básicos do estado e do município. Revise por questões antigas da banca.', {
    'Estado e município': ['História e geografia do Maranhão e do Piauí (conforme o concurso)', 'Aspectos do município da prova'],
    'Atualidades': ['Segurança pública', 'Política, economia e meio ambiente', 'Cidadania e direitos humanos básicos'] })
};

const PRESET_CONTENT = {
  'detran-ma': {
    cargo: 'Assistente de Trânsito (referência: edital 2017)', banca: 'FCC (último edital, 2017)',
    estrategia: '• No edital anterior a parte específica (CTB + Legislação Institucional) pesava mais e decidia o desempate: comece por ela.\n• Último edital é de 2017 (FCC). Já há comissão formada e previsão na LOA 2026: acompanhe o site do Detran-MA e o Diário Oficial uma vez por semana.\n• FCC: lei seca com muitas questões, alternativas parecidas. Não há perda por erro, então responda tudo.\n• Ciclo sugerido (6 a 10 meses): meses 1 a 3 Português e CTB; 4 a 7 demais matérias com questões; 2 últimos meses simulados e revisão.\n• Estude o CTB e as resoluções na versão atualizada até a data do edital.\n• Matérias abaixo seguem a estrutura do edital 2017. Confirme tópicos e pesos no edital novo.',
    disc: () => [B.port(), B.rl('Raciocínio Lógico-Matemático'), B.info(3), B.const(3), B.adm(),
      D('Noções de Administração Pública', 2, 'Poucos tópicos e fáceis de pontuar. Foque em atendimento ao público, gestão de processos e ética.', { 'Administração pública': ['Princípios e modelos de administração pública', 'Atendimento ao público e qualidade no serviço', 'Gestão de processos e documentos', 'Ética no serviço público'] }),
      B.ctb(),
      D('Legislação Institucional (Detran-MA)', 4, 'Pontos fáceis: leia a lei seca e faça questões. Confirme no edital novo quais leis estaduais entram.', { 'Legislação estadual': ['Constituição do Estado do Maranhão', 'Estatuto dos servidores públicos do Maranhão', 'Lei de criação, estrutura e regimento do Detran-MA', 'Código de ética do servidor'] }),
      D('Engenharia de Tráfego (só para Analista)', 3, 'Só estude se o cargo for Analista, depois de consolidar CTB e legislação institucional.', { 'Engenharia de tráfego': ['Fundamentos de engenharia de tráfego', 'Sinalização viária', 'Segurança viária e acidentes'] })]
  },
  'procon-ma': {
    cargo: 'Fiscal de Defesa do Consumidor (referência: edital 2017)', banca: 'FCC (último edital, 2017)',
    estrategia: '• Último concurso em 2017 (FCC, 10 vagas de Fiscal de Defesa do Consumidor). Há comissão formada e previsão no orçamento 2026, banca ainda a definir.\n• Direito do Consumidor (CDC) é a matéria-fim: domine o CDC inteiro e a Lei do Superendividamento.\n• Português e Direito Constitucional/Administrativo completam a base.\n• Estrutura abaixo é estimada a partir do perfil do cargo e da banca. Confira no edital novo e ajuste as matérias pelo botão Editar matérias.',
    disc: () => [B.port(), B.rl('Raciocínio Lógico-Matemático'), B.info(2),
      D('Direito do Consumidor', 5, 'Matéria-fim do cargo. Leia o CDC (Lei 8.078/90) com questões. Atenção a vício x fato do produto, prazos de decadência e prescrição, práticas abusivas, cláusulas abusivas e sanções administrativas.', {
        'Princípios e direitos': ['Política Nacional das Relações de Consumo e princípios', 'Direitos básicos do consumidor', 'Conceitos: consumidor, fornecedor, produto e serviço'],
        'Responsabilidade e prazos': ['Responsabilidade por fato do produto e do serviço', 'Responsabilidade por vício do produto e do serviço', 'Decadência e prescrição'],
        'Práticas e contratos': ['Oferta e publicidade', 'Práticas abusivas', 'Cobrança de dívidas e bancos de dados', 'Proteção contratual e cláusulas abusivas'],
        'Defesa e sanções': ['Sanções administrativas e Sistema Nacional de Defesa do Consumidor (Decreto 2.181/97)', 'Superendividamento (Lei 14.181/2021)', 'Defesa do consumidor em juízo'] }),
      B.const(3), B.adm(),
      D('Noções de Direito Civil', 3, 'Foque em contratos, negócios jurídicos e responsabilidade civil, que conversam com o CDC.', { 'Direito civil': ['Pessoas e bens', 'Fatos e negócios jurídicos', 'Obrigações e contratos', 'Responsabilidade civil'] }),
      D('Legislação Institucional (Procon-MA)', 3, 'Costuma ser curta e de pontos fáceis. Confirme no edital quais leis estaduais entram.', { 'Legislação estadual': ['Lei de criação e estrutura do Procon-MA', 'Estatuto dos servidores públicos do Maranhão', 'Constituição do Estado do Maranhão'] })]
  },
  'gc-imperatriz': {
    banca: 'Fundação Sousândrade (último edital, 2018)',
    estrategia: '• Último edital em 2018 (Fundação Sousândrade, 50 vagas + cadastro reserva, nível médio). Sem edital novo confirmado: acompanhe o site da Prefeitura de Imperatriz.\n• Etapas do edital anterior: prova objetiva, investigação social, teste de aptidão física (TAF), exames médicos, avaliação psicológica e curso de formação. Comece o preparo físico desde já.\n• Prioridade: Português, Matemática e Legislação Específica da Guarda (Lei 13.022/2014 e lei municipal de criação).\n• Estrutura abaixo é estimada com base em editais de guarda municipal. Confirme as matérias no edital novo.',
    disc: () => [B.port(), B.rl('Matemática e Raciocínio Lógico'), B.gerais(), B.info(2), B.const(3),
      B.penal(3), B.proc(2),
      B.gm(['Lei municipal nº 1.694/2017: criação da Guarda Municipal de Imperatriz', 'Estatuto dos servidores municipais de Imperatriz'])]
  },
  'gc-teresina': {
    banca: 'Funatec (último edital, 2024, suspenso)',
    estrategia: '• Último edital em 2024 (Funatec) foi suspenso pelo TCE-PI. O secretário de segurança anunciou novo concurso para 2026 com cerca de 300 vagas, mas a Prefeitura diz depender de orçamento: acompanhe o Diário Oficial de Teresina.\n• Edital anterior: Legislação Municipal tinha 10 questões, e o concurso tinha 6 etapas (incluindo TAF). Remuneração inicial citada: R$ 2.115,82.\n• Prioridade: Português, Matemática, Legislação Municipal e Legislação Específica da Guarda.\n• Estrutura abaixo é estimada. Confirme as matérias no edital novo.',
    disc: () => [B.port(), B.rl('Matemática e Raciocínio Lógico'), B.gerais(), B.info(2), B.const(3),
      B.penal(3), B.proc(2), B.dh(),
      D('Legislação Municipal (Teresina)', 4, 'Teve 10 questões no edital anterior: é pontuação barata. Leia a lei seca e faça questões.', { 'Legislação municipal': ['Lei Orgânica do Município de Teresina', 'Estatuto dos servidores municipais de Teresina', 'Lei de criação e regulamento da Guarda Civil Municipal de Teresina'] }),
      B.gm(['Regulamento da Guarda Civil Municipal de Teresina'])]
  },
  'prf-administrativo': {
    cargo: 'Agente Administrativo (nível médio)', banca: 'Cebraspe (provável)',
    estrategia: '• A PRF pediu autorização para 264 vagas de Agente Administrativo (nível médio). Sem edital publicado até agora. Cebraspe é a banca mais provável.\n• Cebraspe usa certo/errado: item errado anula item certo. Só marque quando tiver segurança.\n• Longo prazo: use o tempo para construir base sólida em Português, Direito Constitucional e Administrativo e Raciocínio Lógico, com questões todos os dias.\n• Estrutura abaixo é estimada com base no perfil do cargo. Ajuste quando o edital sair.',
    disc: () => [B.port(), B.rl('Raciocínio Lógico-Matemático'), B.info(3), B.const(4), B.adm(),
      D('Administração Geral e Pública', 3, 'Foque em funções administrativas, gestão de pessoas, processos e atendimento.', { 'Administração': ['Funções da administração e processo administrativo', 'Gestão de pessoas e de processos', 'Atendimento ao público e qualidade'] }),
      D('Arquivologia e Gestão Documental', 3, 'Matéria curta e previsível: princípios, ciclo de vida dos documentos e classificação.', { 'Arquivologia': ['Conceitos e princípios arquivísticos', 'Ciclo de vida e tabela de temporalidade', 'Classificação e gestão de documentos'] }),
      D('Legislação Aplicada ao Servidor', 3, 'Leia a Lei 8.112/90 com questões: direitos, deveres, regime disciplinar e responsabilidades.', { 'Legislação': ['Lei 8.112/90: regime jurídico dos servidores federais', 'Ética no serviço público (Decreto 1.171/94)', 'Lei de Acesso à Informação (Lei 12.527/2011)'] })]
  },
  'prf-policial': {
    cargo: 'Policial Rodoviário Federal', banca: 'Cebraspe (provável)',
    estrategia: '• Último concurso em 2021 (Cebraspe, 1.500 vagas, validade prorrogada até junho de 2026). A PRF pediu autorização para novas vagas de Policial (cerca de 269). Requisitos: nível superior em qualquer área e CNH categoria B ou superior.\n• Prova objetiva em três blocos de disciplinas, no estilo certo/errado: item errado anula item certo. Tem também prova discursiva, TAF, avaliação de saúde, psicológica, títulos e investigação social, e depois o curso de formação.\n• Mais longo prazo = tempo para fazer certo. Ano 1: base (Português, Constitucional, Administrativo, Raciocínio Lógico, CTB) + TAF. Ano 2: Penal, Processual Penal, Legislação Especial, Física e muita questão. Últimos meses: simulados Cebraspe e discursiva.\n• Legislação de Trânsito e Português são as matérias mais valiosas para quem quer passar: não deixe nenhuma abaixo de 70% de acerto.\n• Estrutura abaixo segue o formato dos editais anteriores da PRF. Confirme no edital novo.',
    disc: () => [B.port(), B.rl('Raciocínio Lógico-Matemático'), B.info(3),
      D('Física', 3, 'Poucas questões, mas dá para garantir pontos: cinemática, dinâmica e energia. Treine fórmulas e problemas curtos.', { 'Mecânica': ['Cinemática', 'Leis de Newton e dinâmica', 'Trabalho, energia e potência', 'Quantidade de movimento e impulso'] }),
      D('Ética no Serviço Público', 2, 'Matéria curta: Decreto 1.171/94 e deveres do servidor.', { 'Ética': ['Código de Ética Profissional do Servidor (Decreto 1.171/94)', 'Deveres e proibições do servidor', 'Cidadania e conduta profissional'] }),
      B.ctb(),
      D('Legislação Especial', 4, 'Leia as leis secas mais cobradas pelo Cebraspe e treine certo/errado com atenção a detalhes (verbos, prazos, exceções).', { 'Leis penais especiais': ['Lei de Drogas (Lei 11.343/2006)', 'Estatuto do Desarmamento (Lei 10.826/2003)', 'Abuso de autoridade (Lei 13.869/2019)', 'Organizações criminosas (Lei 12.850/2013)', 'Tortura e crimes hediondos'] }),
      D('Geopolítica', 2, 'Poucos pontos: leia resumos e questões antigas sobre território, fronteiras e integração.', { 'Geopolítica': ['Organização do território brasileiro', 'Fronteiras e rodovias federais', 'Questões geopolíticas contemporâneas'] }),
      B.const(4), B.adm(), B.penal(4), B.proc(4), B.dh()]
  }
};

function applyPresetContent() {
  Object.keys(PRESET_CONTENT).forEach(id => {
    const c = store.concursos[id]; if (!c || c.contentV >= 2) return;
    const pc = PRESET_CONTENT[id];
    if (!c.edital || !c.edital.length) c.edital = pc.disc();
    ['cargo', 'banca', 'estrategia'].forEach(k => { if (!c.info[k] && pc[k]) c.info[k] = pc[k]; });
    c.contentV = 2;
  });
}

// ══ RUMO À POSSE: Hoje, Prova, Simulados, Erros ══════════
let simulados = [], erros = [], plano = {};
const FRASES = [
  'Constância vence talento: faça o de hoje, mesmo que seja pouco.',
  'Questões são o treino de jogo. Teoria sem questão não aprova.',
  'Revisar hoje é o que garante lembrar na prova.',
  'Não precisa estar motivado, precisa estar em movimento.',
  'Erro registrado é ponto garantido na próxima vez.',
  'Cada tópico concluído é um passo a menos até a posse.',
  'Descanso também faz parte do plano. Durma bem.',
  'Quem estuda um pouco todo dia passa quem estuda muito de vez em quando.',
  'Priorize as matérias de maior peso e as mais fracas.',
  'Simulado mostra onde você está. Use-o para ajustar a rota.',
  'Foco total em 50 minutos vale mais que 3 horas distraído.',
  'A prova é um dia. A preparação é uma decisão diária.',
  'Lei seca lida com questão fica na memória.',
  'Comece pelo mais difícil enquanto a cabeça está fresca.',
  'Todo mundo que passou já pensou em desistir. Continue.',
  'Acompanhe seu aproveitamento: o que se mede melhora.',
  'Hoje você está mais perto do que ontem.',
  'Pouco todo dia, muito no fim do ano.',
  'Quando bater o cansaço, revise em vez de parar.',
  'Seu futuro agradece o estudo de hoje.'
];
const MOTIVOS = ['Não sabia o conteúdo', 'Esqueci ou confundi', 'Falta de atenção', 'Interpretação', 'Pegadinha da banca', 'Chute errado', 'Falta de tempo'];
const DSEM = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function addDaysD(n) { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + n); return d; }
function fmtBR(key) { return new Date(key + 'T00:00:00').toLocaleDateString('pt-BR'); }
function daysTo(key) { if (!key) return null; const p = new Date(key + 'T00:00:00'), t = new Date(); t.setHours(0,0,0,0); return Math.round((p - t) / 86400000); }
function hoursOn(key) { return historico.reduce((s, r) => s + (r.date === key ? (r.horas || 0) : 0), 0); }
function weekHours(nome) { const w = getWeekStart(); return historico.reduce((s, r) => s + (r.date >= w && (!nome || r.disc === nome) ? (r.horas || 0) : 0), 0); }
function fmtH(h) { const m = Math.round(h * 60); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); }
function studiedDay(key) { return historico.some(r => r.date === key && ((r.horas || 0) > 0 || (r.questoes || 0) > 0)); }
function calcStreak() { let s = 0, d = addDaysD(0); if (!studiedDay(dateToKey(d))) d.setDate(d.getDate() - 1); while (studiedDay(dateToKey(d))) { s++; d.setDate(d.getDate() - 1); } return s; }
function bestStreak() {
  const ds = Array.from(new Set(historico.filter(r => (r.horas || 0) > 0 || (r.questoes || 0) > 0).map(r => r.date))).sort();
  let best = 0, cur = 0, prev = null;
  ds.forEach(k => { const t = new Date(k + 'T00:00:00').getTime(); cur = (prev !== null && Math.round((t - prev) / 86400000) === 1) ? cur + 1 : 1; prev = t; if (cur > best) best = cur; });
  return best;
}

function discProg(d, st, cid) {
  cid = cid || curId; let c = 0, t = 0;
  d.grupos.forEach(g => g.topicos.forEach((tp, i) => { t++; const x = tsOf(cid, d.id + '_' + slug(g.nome) + '_' + i); if (x && x.done) c++; }));
  return { c, t };
}
function concProg(c) {
  let t = 0, k = 0; (c.edital || []).forEach(d => { const p = discProg(d, null, c.id); t += p.t; k += p.c; });
  return t ? Math.round(k / t * 100) : 0;
}
function nextTopic(d) {
  for (const g of d.grupos) for (let i = 0; i < g.topicos.length; i++) { const x = getTS(d.id + '_' + slug(g.nome) + '_' + i); if (!x || !x.done) return g.topicos[i]; }
  return '';
}
function topPrior(n) {
  return EDITAL.map((d, i) => {
    const s = getDiscStats(d), p = discProg(d, state), concl = p.t ? p.c / p.t : 0, peso = d.peso || 3;
    const erro = s.total > 0 ? (1 - s.pct / 100) : 0.3;
    return { i, d, s, concl, peso, score: peso * (1 - concl) + peso * erro * 0.5 };
  }).filter(r => r.concl < 1).sort((a, b) => b.score - a.score).slice(0, n);
}
function startStudy(i) {
  const d = EDITAL[i]; if (!d) return;
  switchTab('estudos');
  const sel = document.getElementById('crono-disc'); sel.value = d.nome; if (sel.value !== d.nome) return;
  onCronoDiscChange();
  const nt = nextTopic(d); if (nt) { const ts = document.getElementById('crono-topic'); if (ts) ts.value = nt; }
  setTimeout(() => sel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}
function setMetaDia(v) { plano.metaDia = Math.max(0.5, parseFloat(v) || 2); persist(); renderHoje(); }
function setHorasSemana(v) { plano.horasSemana = Math.max(1, parseFloat(v) || 10); persist(); renderHoje(); }
function hjRev(id) { toggleRevDone(id); renderHoje(); }


function renderHoje() {
  if (!document.getElementById('hj-kpis')) return;
  const hr = new Date().getHours(), tk = todayKey(), meta = plano.metaDia || 2, hoje = hoursOn(tk);
  document.getElementById('hj-hi').textContent = (hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite') + '! Foco em ' + (CONCURSO_INFO.concurso || 'seu concurso');
  document.getElementById('hj-sub').textContent = FRASES[Math.floor(Date.now() / 86400000) % FRASES.length];
  const dd = daysTo(CONCURSO_INFO.dataProva), n = document.getElementById('hj-cd-n'), l = document.getElementById('hj-cd-l');
  if (dd === null) { n.textContent = '＋'; l.textContent = 'Definir data da prova'; }
  else if (dd > 0) { n.textContent = dd; l.textContent = (dd === 1 ? 'dia' : 'dias') + ' para a prova · ' + fmtBR(CONCURSO_INFO.dataProva); }
  else if (dd === 0) { n.textContent = 'HOJE'; l.textContent = 'É dia de prova! Confie no preparo.'; }
  else { n.textContent = '✔'; l.textContent = 'Prova realizada'; }

  // KPIs
  let tot = 0, conc = 0; EDITAL.forEach(d => { const s = getDiscStats(d); tot += s.totalTopicos; conc += s.concluidos; });
  const ac = historico.reduce((s, r) => s + (r.acertos || 0), 0), er = historico.reduce((s, r) => s + (r.erros || 0), 0);
  const totH = historico.reduce((s, r) => s + (r.horas || 0), 0), st = calcStreak();
  document.getElementById('hj-kpis').innerHTML =
    `<div class="kpi"><div class="v">🔥 ${st}</div><div class="t">Dias seguidos</div><div class="s">Recorde: ${bestStreak()} dias</div></div>
     <div class="kpi"><div class="v">${fmtH(weekHours())}</div><div class="t">Horas na semana</div><div class="s">Total: ${fmtH(totH)}</div></div>
     <div class="kpi"><div class="v">${ac + er > 0 ? Math.round(ac / (ac + er) * 100) + '%' : '—'}</div><div class="t">Aproveitamento</div><div class="s">${ac + er} questões</div></div>
     <div class="kpi"><div class="v">${tot ? Math.round(conc / tot * 100) : 0}%</div><div class="t">Edital concluído</div><div class="s">${conc}/${tot} tópicos</div></div>`;

  // meta de hoje
  document.getElementById('hj-meta').innerHTML =
    `<div style="display:flex;align-items:baseline;gap:8px"><span class="kbig">${fmtH(hoje)}</span><span style="font-size:12px;color:var(--text-soft)">de ${meta}h hoje</span></div>
     <div class="bar"><i style="width:${Math.min(100, hoje / meta * 100)}%"></i></div>
     ${hoje >= meta ? '<div class="okmsg">✅ Meta batida! Faça questões e revise.</div>' : '<div style="font-size:11px;color:var(--text-soft)">Faltam ' + fmtH(meta - hoje) + ' para bater a meta.</div>'}
     <div style="display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-mid)">Meta diária (h)<input type="number" min="0.5" step="0.5" class="man-inp" style="max-width:90px" value="${meta}" onchange="setMetaDia(this.value)"></div>`;

  // últimos 7 dias
  const days = []; for (let i = 6; i >= 0; i--) { const d = addDaysD(-i), k = dateToKey(d); days.push({ k, h: hoursOn(k), w: DSEM[d.getDay()] }); }
  const mx = Math.max(meta, ...days.map(x => x.h), 0.5);
  document.getElementById('hj-week').innerHTML =
    `<div class="week">${days.map(x => `<div class="d${x.h > 0 ? ' on' : ''}" title="${fmtBR(x.k)}: ${fmtH(x.h)}"><i style="height:${Math.max(4, x.h / mx * 60)}px"></i>${x.w}</div>`).join('')}</div>
     <div style="font-size:12px;color:var(--text-mid)">${st > 0 ? '🔥 ' + st + ' dia(s) seguidos estudando. Não quebre a corrente!' : 'Estude hoje para começar sua sequência.'}</div>`;

  // revisões
  const due = revisoes.filter(r => !r.done && r.revDate <= tk).sort((a, b) => a.revDate < b.revDate ? -1 : 1);
  const notifOn = plano.notif && 'Notification' in window && Notification.permission === 'granted';
  document.getElementById('hj-revs').innerHTML =
    (due.length ? due.slice(0, 6).map(r => `<div class="row-i"><div class="main"><div class="nm">${escOpt(r.topic || r.disc)}</div><div class="sb">${escOpt(r.disc)} ${r.revDate < tk ? '<span class="chip red">atrasada</span>' : '<span class="chip yel">hoje</span>'}</div></div><button class="mini-btn ok" onclick="hjRev(${r.id})">✓ Feita</button></div>`).join('') + (due.length > 6 ? `<div style="font-size:11px;color:var(--text-soft)">+${due.length - 6} na aba Revisões</div>` : '')
      : '<div style="font-size:12px;color:var(--text-soft)">Nenhuma revisão pendente hoje. 🎉 Agende pelo cronômetro (⚡ Modelo 1-7-30).</div>') +
    (notifOn ? '' : '<button class="mini-btn" style="align-self:flex-start" onclick="ativarLembrete()">🔔 Avisar das revisões ao abrir o app</button>');

  // estudar agora
  const tp = topPrior(3);
  document.getElementById('hj-next').innerHTML = tp.length ? tp.map(r => {
    const nt = nextTopic(r.d);
    return `<div class="row-i"><div class="main"><div class="nm">${escOpt(r.d.nome)} ${pesoBadge(r.d)}</div><div class="sb">${nt ? 'Próximo: ' + escOpt(nt) : Math.round(r.concl * 100) + '% concluído'}</div></div><button class="mini-btn pri" onclick="startStudy(${r.i})">▶ Estudar</button></div>`;
  }).join('') + '<div style="font-size:11px;color:var(--text-soft)">Sugestão por prioridade da matéria, o que falta e sua taxa de erro.</div>'
    : '<div style="font-size:12px;color:var(--text-soft)">Cadastre as matérias em Edital → Editar matérias.</div>';

  // meta semanal por matéria
  const hs = plano.horasSemana || 10;
  const rows = EDITAL.map(d => { const p = discProg(d, state), concl = p.t ? p.c / p.t : 0; return { d, w: (d.peso || 3) * (1.3 - concl) }; });
  const sw = rows.reduce((a, r) => a + r.w, 0) || 1;
  document.getElementById('hj-plano').innerHTML = rows.length
    ? `<div style="display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-mid)">Horas por semana disponíveis<input type="number" min="1" step="1" class="man-inp" style="max-width:90px" value="${hs}" onchange="setHorasSemana(this.value)"></div>` +
      rows.map(r => { const alvo = hs * r.w / sw, fez = weekHours(r.d.nome), pc = Math.min(100, fez / alvo * 100);
        return `<div class="row-i"><div class="main"><div class="nm">${escOpt(r.d.nome)} ${pesoBadge(r.d)}</div><div class="bar" style="margin-top:6px"><i style="width:${pc}%"></i></div></div><div style="font-size:12px;font-weight:800;color:${fez >= alvo ? '#15803d' : 'var(--navy)'};white-space:nowrap">${fmtH(fez)} / ${fmtH(alvo)}</div></div>`; }).join('') +
      '<div style="font-size:11px;color:var(--text-soft)">As horas são distribuídas pela prioridade e pelo que ainda falta concluir. A semana começa no domingo.</div>'
    : '<div style="font-size:12px;color:var(--text-soft)">Sem matérias cadastradas.</div>';

  // meus concursos
  const ord = PRAZOS.map(p => p.k);
  // nota = última nota de simulado deste concurso (vs. nota de corte, se informada)
  function notaCartao(c) { return notaTexto(c); }   // lógica em 207-cartoes-escolha-nota.js
  const ids = Object.keys(store.concursos).filter(id => isEscolhido(id)).sort((a, b) => {
    const A = store.concursos[a].info, B = store.concursos[b].info;
    return ord.indexOf(A.prazo || '') - ord.indexOf(B.prazo || '') || (A.concurso || '').localeCompare(B.concurso || '');
  });
  document.getElementById('hj-concs').innerHTML = ids.map(id => {
    const c = store.concursos[id], inf = c.info, d2 = daysTo(inf.dataProva), pz = PRAZOS.find(p => p.k === (inf.prazo || ''));
    return `<div class="row-i conc-row${id === curId ? ' cur' : ''}" onclick="switchConcurso('${id}');switchTab('hoje')">
      <div class="main"><div class="nm">${escOpt(inf.concurso || 'Sem nome')}</div><div class="sb">${pz ? pz.l : ''} · ${concProg(c)}% do edital · <b>${notaCartao(c)}</b></div><div class="bar" style="margin-top:6px"><i style="width:${concProg(c)}%"></i></div>${provaBtn(c)}</div>
      <div style="text-align:right;white-space:nowrap">${provaFinal(c) ? provaChip(c) : d2 === null ? '<span class="chip">sem data</span>' : d2 > 0 ? `<div style="font-family:Nunito;font-weight:900;font-size:20px;color:var(--navy)">${d2}</div><div style="font-size:9px;color:var(--text-soft);font-weight:700">DIAS</div>` : d2 === 0 ? '<span class="chip red">HOJE</span>' : '<span class="chip grn">realizada</span>'}</div></div>`;
  }).join('');


  renderHojeCron();
  renderReco();
  // lembrete de backup
  const ult = store.lastBackup || 0, dBk = ult ? Math.floor((Date.now() - ult) / 86400000) : 999;
  document.getElementById('hj-backup').innerHTML = (historico.length || Object.keys(state).length) && dBk >= 7
    ? `<div class="pro-note"><div class="hint-icon">💾</div><div><b>${ult ? 'Último backup há ' + dBk + ' dias.' : 'Você ainda não fez backup.'}</b> Seus dados ficam só neste aparelho: exporte ou compartilhe um backup para não perder o progresso. <button class="mini-btn" style="margin-left:6px" onclick="openBackupModal()">Fazer backup</button></div></div>` : '';
}

// ── DATA DA PROVA (por data ou por quantidade de dias) ──
function cmDias() { const n = parseInt(document.getElementById('cm-dias').value); if (n > 0) document.getElementById('cm-data').value = dateToKey(addDaysD(n)); }
function pvPrev() {
  const v = document.getElementById('pv-data').value, el = document.getElementById('pv-prev');
  if (!v) { el.textContent = ''; return; }
  const d = daysTo(v), dt = new Date(v + 'T00:00:00');
  el.textContent = 'Prova em ' + dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) + (d > 0 ? ' (faltam ' + d + ' dias)' : d === 0 ? ' (é hoje)' : ' (já passou)');
}
function pvDias() { const n = parseInt(document.getElementById('pv-dias').value); document.getElementById('pv-data').value = n > 0 ? dateToKey(addDaysD(n)) : ''; pvPrev(); }
function openProva() {
  document.getElementById('pv-sub').textContent = CONCURSO_INFO.concurso || '';
  document.getElementById('pv-data').value = CONCURSO_INFO.dataProva || '';
  document.getElementById('pv-dias').value = '';
  pvPrev(); document.getElementById('prova-modal').classList.add('open');
}
function closeProva() { document.getElementById('prova-modal').classList.remove('open'); }
function saveProva() {
  const v = document.getElementById('pv-data').value;
  if (!v) { showToast('⚠️', 'Informe a data ou quantos dias faltam.'); return; }
  CONCURSO_INFO.dataProva = v; persist(); renderSidebar(); renderHoje(); closeProva();
  const d = daysTo(v); showToast('📅', d > 0 ? 'Contagem iniciada: faltam ' + d + ' dias!' : 'Data salva.');
}
function clearProva() { CONCURSO_INFO.dataProva = ''; persist(); renderSidebar(); renderHoje(); closeProva(); showToast('🗑️', 'Data removida.'); }
function restorePresets() {
  let n = 0; store.seeded = store.seeded || [];
  PRESETS.forEach(pr => {
    if (!store.concursos[pr.id]) { store.concursos[pr.id] = { id: pr.id, chosen: false, info: clone(pr.info), edital: [], data: { state: {}, historico: [], revisoes: [], simulados: [], erros: [], plano: {} }, contentV: 0 }; n++; }
    if (store.seeded.indexOf(pr.id) === -1) store.seeded.push(pr.id);
  });
  applyPresetContent(); persist(); refreshAll();
  showToast('♻️', n ? n + ' concurso(s) recuperado(s)!' : 'Todos os pré-cadastrados já estão aqui.');
}
function openMais() { document.getElementById('mais-modal').classList.add('open'); }
function closeMais() { document.getElementById('mais-modal').classList.remove('open'); }

// ── SIMULADOS ──
function simScore(s) { const net = s.tipo === 'ce' ? s.ac - s.er : s.ac; return Math.max(0, Math.round(net / s.total * 1000) / 10); }
function addSimulado() {
  const nome = document.getElementById('sm-nome').value.trim() || ('Simulado ' + (simulados.length + 1));
  const date = document.getElementById('sm-data').value || todayKey(), tipo = document.getElementById('sm-tipo').value;
  const total = parseInt(document.getElementById('sm-total').value) || 0, ac = parseInt(document.getElementById('sm-ac').value) || 0, er = parseInt(document.getElementById('sm-er').value) || 0;
  const tempo = parseInt(document.getElementById('sm-tempo').value) || 0;
  if (total < 1) { showToast('⚠️', 'Informe o total de questões.'); return; }
  if (ac + er > total) { showToast('⚠️', 'Acertos + erros passam do total.'); return; }
  simulados.push({ id: Date.now(), nome, date, tipo, total, ac, er, tempo });
  ['sm-nome', 'sm-total', 'sm-ac', 'sm-er', 'sm-tempo'].forEach(id => document.getElementById(id).value = '');
  persist(); renderSimulados(); showToast('✅', 'Simulado salvo!');
}
async function delSimulado(id) {
  if (!(await askConfirm('Excluir este simulado?', 'Excluir'))) return;
  simulados = simulados.filter(s => s.id !== id); persist(); renderSimulados();
}
function svgLine(pts, corte) {
  const W = 640, H = 210, pl = 36, pr = 14, pt = 14, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  const X = i => pl + (pts.length === 1 ? iw / 2 : i * iw / (pts.length - 1)), Y = v => pt + ih * (1 - v / 100);
  let g = '';
  [0, 25, 50, 75, 100].forEach(v => { g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e2e5f0"/><text x="${pl - 6}" y="${Y(v) + 3}" font-size="10" text-anchor="end" fill="#8a90b8">${v}%</text>`; });
  if (corte) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(corte)}" y2="${Y(corte)}" stroke="#C8102E" stroke-dasharray="5 4"/><text x="${W - pr}" y="${Y(corte) - 5}" font-size="10" text-anchor="end" fill="#C8102E" font-weight="700">meta ${corte}%</text>`;
  const poly = pts.map((p, i) => X(i) + ',' + Y(p.y)).join(' ');
  const area = pts.length > 1 ? `<polygon points="${pl},${Y(0)} ${poly} ${X(pts.length - 1)},${Y(0)}" fill="rgba(125,207,176,.2)"/>` : '';
  const dots = pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.y)}" r="4.5" fill="#0D134C"/><text x="${X(i)}" y="${Y(p.y) - 9}" font-size="10" text-anchor="middle" fill="#0D134C" font-weight="700">${p.y}</text>` + (pts.length <= 8 || i === 0 || i === pts.length - 1 ? `<text x="${X(i)}" y="${H - 8}" font-size="9" text-anchor="middle" fill="#8a90b8">${p.x}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${g}${area}<polyline points="${poly}" fill="none" stroke="#0D134C" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>`;
}
function renderSimulados() {
  if (!document.getElementById('sm-kpis')) return;
  const dt = document.getElementById('sm-data'); if (dt && !dt.value) dt.value = todayKey();
  const lista = simulados.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);
  const sc = lista.map(simScore), corte = CONCURSO_INFO.notaCorte || 0;
  const ult3 = sc.slice(-3), media = ult3.length ? Math.round(ult3.reduce((a, b) => a + b, 0) / ult3.length * 10) / 10 : null;
  const melhor = sc.length ? Math.max(...sc) : null;
  const tend = sc.length >= 2 ? Math.round((sc[sc.length - 1] - sc[sc.length - 2]) * 10) / 10 : null;
  document.getElementById('sm-kpis').innerHTML =
    `<div class="kpi"><div class="v">${lista.length}</div><div class="t">Simulados feitos</div></div>
     <div class="kpi"><div class="v">${media !== null ? media + '%' : '—'}</div><div class="t">Média dos 3 últimos</div><div class="s">${tend === null ? '' : tend >= 0 ? '▲ +' + tend + ' pts vs. anterior' : '▼ ' + tend + ' pts vs. anterior'}</div></div>
     <div class="kpi"><div class="v">${melhor !== null ? melhor + '%' : '—'}</div><div class="t">Melhor resultado</div></div>
     <div class="kpi"><div class="v">${corte ? corte + '%' : '—'}</div><div class="t">Meta / nota de corte</div><div class="s">${corte && media !== null ? (media >= corte ? '✅ Acima da meta' : 'Faltam ' + Math.round((corte - media) * 10) / 10 + ' pts') : 'Defina em ✏️ Editar concurso'}</div></div>`;
  document.getElementById('sm-chart').innerHTML = lista.length ? svgLine(lista.map((s, i) => ({ x: s.date.slice(8) + '/' + s.date.slice(5, 7), y: sc[i] })), corte) : '<div class="rev-empty">Registre seu primeiro simulado para ver a evolução.</div>';
  document.getElementById('sm-list').innerHTML = lista.length ? lista.slice().reverse().map(s => {
    const p = simScore(s), br = s.total - s.ac - s.er;
    return `<div class="row-i"><div class="main"><div class="nm">${escOpt(s.nome)}</div><div class="sb">${fmtBR(s.date)} · ${s.ac} acertos · ${s.er} erros · ${br} em branco · ${s.tipo === 'ce' ? 'Certo/Errado' : 'Múltipla escolha'}${s.tempo ? ' · ' + s.tempo + ' min' : ''}</div></div><span class="chip ${corte && p >= corte ? 'grn' : 'yel'}" style="font-size:12px">${p}%</span><button class="mini-btn no" onclick="delSimulado(${s.id})">🗑</button></div>`;
  }).join('') : '<div style="font-size:12px;color:var(--text-soft)">Nenhum simulado ainda.</div>';
}

// ── CADERNO DE ERROS ──
let erroAtual = null, erroRevelado = false;


function toggleDominado(id) { const e = erros.find(x => x.id === id); if (e) { e.dominado = !e.dominado; e.ok = e.dominado ? Math.max(e.ok, 2) : 0; persist(); renderErros(); } }
async function delErro(id) { if (!(await askConfirm('Excluir este erro do caderno?', 'Excluir'))) return; erros = erros.filter(e => e.id !== id); persist(); renderErros(); }
function escolherErro() {
  const tk = todayKey(), pend = erros.filter(e => !e.dominado); if (!pend.length) return null;
  const fresh = pend.filter(e => e.ult !== tk), pool = fresh.length ? fresh : pend;
  return pool.slice().sort((a, b) => (a.ok - b.ok) || (a.ult < b.ult ? -1 : 1))[0];
}



function normS(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
// ══ IMPORTAR EDITAL ═════════════════════════════════════
const DISC_KEYS = /^(lingua portuguesa|portugues|redacao|raciocinio|matematica|informatica|nocoes?\b|direito\b|direitos\b|legislacao|conhecimentos? (gerais|basicos|especificos|pedagogicos|de|sobre)|atualidades|historia|geografia|etica|fisica|quimica|biologia|administracao|contabilidade|arquivologia|ingles|espanhol|lingua (inglesa|estrangeira)|geopolitica|estatistica|economia|atendimento|criminologia|medicina legal|nocao)/;
const GRP_KEYS = /^(conhecimentos (basicos|gerais|especificos)|parte [ivx\d]+|nivel (medio|superior)|prova (objetiva|discursiva)|bloco [ivx\d]+|modulo [ivx\d]+)\b/;
const ITEM_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3}[.)]?|[a-z]\)|[•\-–—·▪●○◦])\s+/i;
const NOISE_RE = /^(p[aá]gina|p[aá]g\.?)\s*\d+|^\d{1,3}$|^\d+\s*\/\s*\d+$|^www\.|^https?:|^-+\s*\d+\s*-+$/i;
const T_MIN = /^(de|da|do|das|dos|e|em|para|a|o|as|os|no|na|nos|nas|ao|aos|com|por)$/;
function titulo(s) { if (s !== s.toUpperCase()) return s; return s.toLowerCase().split(' ').map((w, i) => (i > 0 && T_MIN.test(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
function normHead(s) { return s.replace(/^[IVXLC]+\s*[-–.)]\s+/, '').replace(/^\d+\s*[-–.)]\s+/, '').replace(/[\s:.\-–]+$/, '').trim(); }
function isHead(l, next) {
  if (!l || l.length > 110 || ITEM_RE.test(l)) return false;
  const c = normHead(l); if (c.length < 4) return false;
  const letters = c.replace(/[^A-Za-zÀ-ÿ]/g, ''); if (letters.length < 4) return false;
  const up = letters.replace(/[^A-ZÀ-Ý]/g, '').length / letters.length;
  if (up >= 0.85 && c.split(' ').length <= 12) return true;
  const n = normS(c), words = c.split(' ').length;
  return DISC_KEYS.test(n) && words <= 8 && !/[;,]$/.test(l) && (/:$/.test(l) || (!!next && ITEM_RE.test(next)));
}
function parseEdital(raw) {
  let t = String(raw || '').replace(/\r/g, '').replace(/\u00ad/g, '').replace(/[ \t\u00a0]+/g, ' ');
  const re = /conte[úu]dos? program[áa]ticos?/gi, idx = []; let m;
  while ((m = re.exec(t))) idx.push(m.index);
  if (idx.length) {
    let best = idx[0], bs = -1;
    idx.forEach(i => {
      const w = t.slice(i, i + 20000).split('\n').map(x => x.trim()); let sc = 0;
      w.forEach((l, k) => { if (ITEM_RE.test(l)) sc++; else if (isHead(l, w[k + 1])) sc += 2; });
      if (sc > bs) { bs = sc; best = i; }
    });
    t = t.slice(best);
    const stop = t.slice(400).search(/\n\s*ANEXO\s+[IVXLC\d]+/i); if (stop > 0) t = t.slice(0, 400 + stop);
  }
  t = t.replace(/([.;])\s+(\d{1,2}(?:\.\d{1,2})*)\s+(?=[A-ZÀ-Ý])/g, '$1\n$2 ');
  const lines = t.split('\n').map(s => s.trim()).filter(s => s && !NOISE_RE.test(s));
  const discs = []; let cur = null, grp = 'Conteúdo', last = null;
  const startDisc = nome => {
    nome = titulo(normHead(nome)); if (!nome) return;
    cur = discs.find(d => normS(d.nome) === normS(nome));
    if (!cur) { cur = { nome, tops: [], grp }; discs.push(cur); }
    last = null;
  };
  const addText = s => {
    if (ITEM_RE.test(s)) { last = { t: s.replace(ITEM_RE, '').trim() }; cur.tops.push(last); }
    else if (last && !/[.;]$/.test(last.t) && (/^[a-zà-ÿ(,]/.test(s) || /[,\-–(]$/.test(last.t) || /\b(de|da|do|das|dos|e|em|para|com|ou|a|o|à|ao|no|na|por|sobre|entre|que)$/i.test(last.t) || last.t.length > 90)) { last.t += ' ' + s; }
    else { last = { t: s }; cur.tops.push(last); }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1] || '';
    if (GRP_KEYS.test(normS(normHead(l))) && l.length < 70 && !ITEM_RE.test(l)) { grp = titulo(normHead(l)); cur = null; last = null; continue; }
    const inl = l.match(/^([A-ZÀ-Ý][A-ZÀ-Ý0-9 ,\/\-–()ªº.&]{3,80}?):\s+(\S.*)$/) || l.match(/^([A-ZÀ-Ý][^:;.\d]{3,70}):\s+(\S.*)$/);
    if (inl && (isHead(inl[1] + ':', ' 1 x') || DISC_KEYS.test(normS(inl[1]))) && inl[1].split(' ').length <= 9) { startDisc(inl[1]); addText(inl[2]); continue; }
    if (isHead(l, next)) { startDisc(l); continue; }
    if (!cur) continue;
    addText(l);
  }
  const out = [];
  discs.forEach(d => {
    const tops = [], seen = {};
    d.tops.forEach(o => {
      const s = o.t.replace(/\s+/g, ' ').replace(/-\s+(?=[a-zà-ÿ])/g, '').trim();
      let parts = [s];
      const nFr = (s.match(/\.\s+(?=[A-ZÀ-Ý])/g) || []).length;
      if (s.length > 160 && s.indexOf(';') > -1) parts = s.split(/;\s*/);
      else if (nFr >= 2 || s.length > 160) parts = s.split(/\.\s+(?=[A-ZÀ-Ý])/);
      parts.forEach(x => {
        x = x.replace(/[;.\s]+$/, '').trim();
        if (x.length < 5 || x.length > 400) return;
        x = x.charAt(0).toUpperCase() + x.slice(1);
        const k = normS(x); if (seen[k]) return; seen[k] = 1; tops.push(x);
      });
    });
    if (tops.length) out.push({ nome: d.nome, grupos: [{ nome: d.grp || 'Conteúdo', topicos: tops.slice(0, 200) }] });
  });
  return out;
}
async function carregarPdfJs() {
  if (window.__PDFJS_B64) {   // arquivo único: o leitor de PDF vem embutido (não precisa da pasta pdfjs/)
    const bin = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
    const url = c => URL.createObjectURL(new Blob([bin(c)], { type: 'text/javascript' }));
    const pdfjs = await import(url(window.__PDFJS_B64.lib));
    pdfjs.GlobalWorkerOptions.workerSrc = url(window.__PDFJS_B64.worker);
    return pdfjs;
  }
  const pdfjs = await import('./pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', location.href).href;
  return pdfjs;
}
async function pdfToText(file) {
  const pdfjs = await carregarPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    let lastY = null, line = '';
    tc.items.forEach(it => {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) { out += line.trim() + '\n'; line = ''; }
      line += it.str + (it.hasEOL ? '\n' : ' '); lastY = y;
    });
    out += line.trim() + '\n\f';
  }
  pdfToText.paginas = doc.numPages;
  return out;
}
function openImp() { document.getElementById('imp-status').textContent = window.__PDFJS_B64 ? 'Leitor de PDF: embutido neste arquivo ✅' : 'Leitor de PDF: usa a pasta pdfjs/ (só funciona com o app hospedado ou o pacote completo).'; document.getElementById('imp-modal').classList.add('open'); }
function closeImp() { document.getElementById('imp-modal').classList.remove('open'); }
async function impFile(inp) {
  const f = inp.files[0]; if (!f) return;
  inp.value = '';   // permite escolher o MESMO arquivo de novo depois
  const st = document.getElementById('imp-status'); st.textContent = 'Lendo ' + f.name + '...';
  try {
    const txt = (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') ? await pdfToText(f) : await f.text();
    document.getElementById('imp-text').value = txt;
    const pag = pdfToText.paginas || 1, pouco = /\.pdf$/i.test(f.name) && txt.replace(/\s/g, '').length / pag < 200;
    st.textContent = pouco ? '⚠️ Quase não há texto neste PDF: ele deve ser uma imagem escaneada. Use um PDF com texto selecionável ou cole o texto.' : '✅ ' + txt.length.toLocaleString('pt-BR') + ' caracteres lidos. Clique em Analisar edital.';
  } catch (e) {
    st.textContent = '⚠️ Não consegui ler este arquivo' + (e && e.message ? ' (' + String(e.message).slice(0, 80) + ')' : '') + '. Você pode colar o texto do edital na caixa abaixo: isso funciona em qualquer modo.';
  }
}
let IMPC = null;
function impAnalisar() {
  const txt = document.getElementById('imp-text').value.trim();
  if (txt.length < 80) { showToast('⚠️', 'Envie o PDF ou cole o texto do edital.'); return; }
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de importar.'); return; }
  if (typeof EditalLeitor === 'undefined') { showToast('⚠️', 'Arquivos de apoio não carregaram. Use o rumo-a-posse.html (arquivo único) ou publique a pasta app.'); return; }
  const A = EditalLeitor.analisar(txt);
  IMPC = { A, txt, marc: {}, nomes: {}, ampla: false };
  A.certas.forEach(m => { IMPC.marc[m.id] = true; IMPC.nomes[m.id] = m.nome; });
  A.duvidas.forEach(m => { IMPC.marc[m.id] = false; IMPC.nomes[m.id] = m.nome; });
  document.getElementById('imp-modal').classList.remove('open'); renderImpConf(); document.getElementById('imp-conf').classList.add('open');
}
function _ic(s) { return _xe(s); }
function impCard(m, certa) {
  return `<div class="ic-card${certa ? ' certa' : ' duvida'}"><div class="ic-top"><input type="checkbox" id="ck-${m.id}"${IMPC.marc[m.id] ? ' checked' : ''} onchange="impToggle('${m.id}',this.checked)" aria-label="Incluir"><input class="man-inp ic-nome" value="${_ic(IMPC.nomes[m.id])}" onchange="impNome('${m.id}',this.value)" aria-label="Nome da matéria"></div>
    <div class="ic-chips"><span class="chip">${m.topicos.length} tópicos</span>${m.grupo && m.grupo !== 'Conteúdo' ? '<span class="chip">' + _ic(m.grupo) + '</span>' : ''}${m.cargo ? '<span class="chip yel">' + _ic(m.cargo) + '</span>' : ''}</div>
    ${certa ? '<div class="ic-why">✔ ' + m.motivos.map(_ic).join(' · ') + '</div>' : '<div class="ic-why falta">❓ ' + m.faltas.map(_ic).join(' · ') + '</div>'}
    <details class="ic-det"><summary>Ver os ${m.topicos.length} tópicos</summary><ol>${m.topicos.map(t => '<li>' + _ic(t) + '</li>').join('')}</ol></details></div>`;
}
function renderImpConf() {
  const A = IMPC.A, r = A.resumo, ign = A.ignorados;
  document.getElementById('ic-resumo').innerHTML = (IMPC.ampla ? '<b>Leitura ampla:</b> tudo o que parece matéria, sem as provas de segurança. ' : '') + `Li ${r.paginas > 1 ? r.paginas + ' páginas' : 'o texto'}: <b>${A.certas.length}</b> matéria(s) com certeza, <b>${A.duvidas.length}</b> para você conferir e <b>${r.ignorados}</b> título(s) removido(s) por não serem matéria.`;
  document.getElementById('ic-avisos').innerHTML = A.avisos.map(a => '<div class="rx-note" style="margin-bottom:8px">⚠️ ' + _ic(a) + '</div>').join('');
  document.getElementById('ic-certas').innerHTML = A.certas.length ? '<div class="ic-h">✅ Matérias com certeza <small>(já marcadas)</small></div>' + A.certas.map(m => impCard(m, true)).join('') : '<div class="rx-note">Nenhuma matéria passou em todas as provas de segurança.' + (IMPC.ampla ? '' : ' <button class="mini-btn" onclick="impAmpla()">Ver leitura ampla</button>') + '</div>';
  document.getElementById('ic-duvidas').innerHTML = A.duvidas.length ? '<div class="ic-h">❓ Para você conferir <small>(desmarcadas: marque só as que forem matéria)</small></div>' + A.duvidas.map(m => impCard(m, false)).join('') : '';
  document.getElementById('ic-ign-l').innerHTML = ign.length ? ign.map(x => '<div class="ic-ig"><b>' + _ic(x.texto) + '</b><small>' + _ic(x.motivo) + '</small></div>').join('') + (r.ignorados > ign.length ? '<small>…e mais ' + (r.ignorados - ign.length) + '</small>' : '') : '<small>Nada foi removido.</small>';
  document.getElementById('ic-ign').style.display = ign.length ? '' : 'none'; impConfBotao();
}
function impConfBotao() { const n = Object.keys(IMPC.marc).filter(k => IMPC.marc[k]).length, b = document.getElementById('ic-ok'); b.textContent = 'Usar as ' + n + ' marcada' + (n === 1 ? '' : 's'); b.disabled = !n; }
function impToggle(id, v) { IMPC.marc[id] = !!v; impConfBotao(); }
function impNome(id, v) { IMPC.nomes[id] = v.trim() || IMPC.nomes[id]; }
function impAmpla() {
  const old = parseEdital(IMPC.txt.replace(/\f/g, '\n')); if (!old.length) { showToast('⚠️', 'Nada parecido com matéria foi encontrado nesse texto.'); return; }
  IMPC.ampla = true; IMPC.A = { certas: [], duvidas: old.map((d, i) => ({ id: 'd' + i, nome: d.nome, grupo: d.grupos[0].nome, cargo: '', topicos: d.grupos.reduce((a, g) => a.concat(g.topicos), []), motivos: [], faltas: ['leitura ampla: não passou nas provas de segurança'] })), ignorados: [], avisos: ['Na leitura ampla, confira cada matéria com atenção antes de marcar.'], resumo: { paginas: IMPC.A.resumo.paginas, ignorados: 0 } };
  IMPC.marc = {}; IMPC.nomes = {}; IMPC.A.duvidas.forEach(m => { IMPC.marc[m.id] = false; IMPC.nomes[m.id] = m.nome; }); renderImpConf();
}
function impMarcarTodas(v) { Object.keys(IMPC.marc).forEach(k => { IMPC.marc[k] = v; const c = document.getElementById('ck-' + k); if (c) c.checked = v; }); impConfBotao(); }
function impConfVoltar() { document.getElementById('imp-conf').classList.remove('open'); document.getElementById('imp-modal').classList.add('open'); }
function impUsarSelecao() {
  const A = IMPC.A, sel = A.certas.concat(A.duvidas).filter(m => IMPC.marc[m.id]).map(m => Object.assign({}, m, { nome: IMPC.nomes[m.id] }));
  if (!sel.length) { showToast('⚠️', 'Marque pelo menos uma matéria.'); return; }
  document.getElementById('imp-conf').classList.remove('open'); impAplicar(EditalLeitor.paraEditais(sel));
}
function impAplicar(res) {
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de importar.'); return; }
  if (document.getElementById('imp-dest').value === 'novo') {
    const nome = document.getElementById('imp-nome').value.trim() || 'Concurso importado';
    persist();
    const id = uniqueId(slugId(nome), Object.keys(store.concursos));
    store.concursos[id] = { id, info: { concurso: nome, cargo: '', banca: '', dataProva: '', prazo: 'curto' }, edital: [], data: { state: {}, historico: [], revisoes: [], simulados: [], erros: [], plano: {}, metas: {} } };
    loadConcurso(id); persist(); refreshAll();
  }
  edW = res.map(rd => {
    const old = EDITAL.find(d => normS(d.nome) === normS(rd.nome)), oldTops = {};
    if (old) old.grupos.forEach(g => g.topicos.forEach((t, i) => { oldTops[normS(t)] = old.id + '_' + slug(g.nome) + '_' + i; }));
    return {
      id: old ? old.id : null, on: old ? old.nome : null, nome: rd.nome, peso: old ? (old.peso || 3) : 3, dica: old ? (old.dica || '') : '',
      bizus: old ? bizusFor(old).join('\n') : '',
      grupos: rd.grupos.map(g => ({ nome: g.nome, topicos: g.topicos.map(t => ({ t, ot: oldTops[normS(t)] ? t : null, o: oldTops[normS(t)] || null })) }))
    };
  });
  const nt = res.reduce((a, d) => a + d.grupos.reduce((b, g) => b + g.topicos.length, 0), 0);
  closeImp(); renderEdEditor();
  const note = document.getElementById('ed-note');
  note.textContent = '📄 Você confirmou ' + res.length + ' matéria(s) e ' + nt + ' tópicos. Revise, ajuste e clique em “Salvar alterações”. Tópicos iguais aos atuais mantêm o progresso.';
  note.style.display = '';
  document.getElementById('ed-modal').classList.add('open');
}

// ══ CRONOGRAMA ═══════════════════════════════════════════
const DIAS_N = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function incTopic(d, text) {
  const r = plano.rx; if (!r || !r.provas || !r.provas.length) return 0;
  const dn = normS(d.nome), tn = normS(text); let s = 0;
  r.provas.forEach(p => {
    if (normS(p.disc) !== dn) return;
    const pn = normS(p.topic); if (!pn) return;
    const pw = pn.split(/\s+/).filter(w => w.length >= 4);
    if (tn.indexOf(pn) > -1 || pn.indexOf(tn) > -1 || (pw.length && pw.filter(w => tn.indexOf(w) > -1).length / pw.length >= 0.6)) s += p.qtd || 0;
  });
  return s;
}
function nextTopic(d) {
  let best = null, bi = -1;
  d.grupos.forEach(g => g.topicos.forEach((t, i) => {
    const x = getTS(d.id + '_' + slug(g.nome) + '_' + i); if (x && x.done) return;
    const inc = incTopic(d, t); if (best === null || inc > bi) { best = t; bi = inc; }
  }));
  return best || '';
}
function cronDefaults() {
  const dd = daysTo(CONCURSO_INFO.dataProva);
  return { inicio: todayKey(), fim: (dd !== null && dd > 7) ? CONCURSO_INFO.dataProva : dateToKey(addDaysD(84)), horasDia: plano.metaDia || 2, dias: [1, 2, 3, 4, 5, 6], revPct: 20 };
}
function pendRows(d) {
  const rows = [];
  d.grupos.forEach(g => g.topicos.forEach((t, i) => { const tid = d.id + '_' + slug(g.nome) + '_' + i; if (!getTS(tid).done) rows.push({ tid, t, inc: incTopic(d, t) }); }));
  return rows;
}
function gerarCron(o) {
  const days = [], end = new Date(o.fim + 'T00:00:00'); let dt = new Date(o.inicio + 'T00:00:00');
  while (dt <= end) { if (o.dias.indexOf(dt.getDay()) !== -1) days.push(dateToKey(dt)); dt.setDate(dt.getDate() + 1); }
  if (days.length < 3) return { erro: 'Poucos dias de estudo entre as datas. Aumente o período ou os dias da semana.' };
  const revN = days.length >= 10 ? Math.max(2, Math.round(days.length * o.revPct / 100)) : 0;
  const estD = days.slice(0, days.length - revN), revD = days.slice(days.length - revN);
  const budget = Math.round(o.horasDia * 60), total = budget * estD.length;
  const ds = EDITAL.map(d => ({ d, rows: pendRows(d).sort((a, b) => b.inc - a.inc), w: d.peso || 3 })).filter(x => x.rows.length);
  if (!ds.length) return { erro: 'Todos os tópicos já estão concluídos. Nada a planejar!' };
  const sw = ds.reduce((a, x) => a + x.w, 0); let totTop = 0, fora = 0;
  ds.forEach(x => {
    totTop += x.rows.length; x.M = total * x.w / sw;
    let per = Math.min(90, Math.round(x.M / x.rows.length / 5) * 5);
    if (per < 15) { const keep = Math.max(1, Math.floor(x.M / 15)); fora += Math.max(0, x.rows.length - keep); x.rows = x.rows.slice(0, keep); per = 15; }
    x.items = x.rows.map(r => ({ disc: x.d.nome, topic: r.t, tid: r.tid, min: per, tipo: 'estudo' }));
    let left = x.M - per * x.items.length;
    while (left >= 30) { const m = Math.min(45, Math.round(left / 5) * 5); x.items.push({ disc: x.d.nome, topic: 'Questões de ' + x.d.nome, min: m, tipo: 'questoes' }); left -= m; }
    x.sched = 0; x.i = 0;
  });
  const itens = []; let n = 0;
  const push = (date, it) => itens.push(Object.assign({ id: 'c' + (n++), date, done: false }, it));
  estD.forEach(date => {
    let rem = budget, guard = 0, count = 0;
    while (rem >= 15 && guard++ < 40) {
      const c = ds.filter(x => x.i < x.items.length); if (!c.length) break;
      c.sort((a, b) => (a.sched / a.M) - (b.sched / b.M));
      const x = c[0], it = x.items[x.i];
      if (count > 0 && it.min > rem + 10) break;
      x.i++; x.sched += it.min; rem -= it.min; count++; push(date, it);
    }
  });
  const sobra = ds.reduce((a, x) => a + x.items.slice(x.i).filter(i => i.tipo === 'estudo').length, 0);
  const weak = EDITAL.map(d => { const s = getDiscStats(d); return { d, pct: s.total > 0 ? s.pct : -1, w: d.peso || 3 }; }).sort((a, b) => (a.pct - b.pct) || (b.w - a.w));
  revD.forEach((date, k) => {
    if (k === revD.length - 1) { push(date, { disc: 'Geral', topic: 'Revisão leve (bizus e caderno de erros), descanso e sono', min: Math.min(budget, 90), tipo: 'revisao' }); return; }
    if ((k + 1) % 3 === 0) { push(date, { disc: 'Geral', topic: 'Simulado completo no estilo da banca + correção e caderno de erros', min: budget, tipo: 'simulado' }); return; }
    const per = Math.round(budget / 2 / 5) * 5;
    for (let j = 0; j < 2 && weak.length; j++) { const w = weak[(k * 2 + j) % weak.length]; push(date, { disc: w.d.nome, topic: 'Revisão ativa + questões: ' + w.d.nome, min: per, tipo: 'revisao' }); }
  });
  const cobertos = itens.filter(i => i.tipo === 'estudo').length;
  return { cfg: o, itens, geradoEm: todayKey(), stats: { diasEstudo: estD.length, diasRev: revD.length, horas: Math.round(itens.reduce((a, i) => a + i.min, 0) / 6) / 10, cobertos, total: totTop, fora: fora + sobra } };
}
function vv(id) { return document.getElementById(id).value; }
async function cronGerar() {
  const o = { inicio: vv('cr-ini'), fim: vv('cr-fim'), horasDia: parseFloat(vv('cr-h')) || 2, dias: Array.from(document.querySelectorAll('.cr-dia:checked')).map(c => parseInt(c.value)), revPct: Math.max(0, Math.min(50, parseInt(vv('cr-rev')) || 0)) };
  if (!o.inicio || !o.fim || o.inicio > o.fim) { showToast('⚠️', 'Confira as datas de início e fim.'); return; }
  if (!o.dias.length) { showToast('⚠️', 'Marque ao menos um dia da semana.'); return; }
  if (plano.cron && !(await askConfirm('Gerar de novo substitui o cronograma atual. Os tópicos já concluídos continuam concluídos.', 'Gerar'))) return;
  const r = gerarCron(o); if (r.erro) { showToast('⚠️', r.erro); return; }
  plano.cron = r; plano.metaDia = o.horasDia; persist(); renderCronLista(); renderHoje(); showToast('🗓️', 'Cronograma gerado!');
}
function cronReplan() {
  const cfg = Object.assign({}, (plano.cron && plano.cron.cfg) || cronDefaults()); cfg.inicio = todayKey();
  if (cfg.fim < cfg.inicio) cfg.fim = dateToKey(addDaysD(28));
  document.getElementById('cr-ini').value = cfg.inicio; document.getElementById('cr-fim').value = cfg.fim;
  const r = gerarCron(cfg); if (r.erro) { showToast('⚠️', r.erro); return; }
  plano.cron = r; persist(); renderCronLista(); renderHoje(); showToast('↻', 'Replanejado a partir de hoje!');
}
function cronToggle(id) {
  const it = plano.cron && (plano.cron.itens || []).find(x => x.id === id); if (!it) return;
  it.done = !it.done;
  if (it.tipo === 'estudo' && it.tid) { setTS(it.tid, 'done', it.done); setTS(it.tid, 'datetime', it.done ? fmtDt(new Date()) : null); renderDiscs(); updateAll(); }
  persist(); renderCronLista(); renderHoje();
  if (it.done && it.tipo === 'simulado') showToast('📝', 'Registre o resultado na aba Simulados.');
}
function renderCronForm() {
  if (!document.getElementById('cr-ini')) return;
  const cfg = (plano.cron && plano.cron.cfg) || cronDefaults();
  document.getElementById('cr-ini').value = cfg.inicio; document.getElementById('cr-fim').value = cfg.fim;
  document.getElementById('cr-h').value = cfg.horasDia; document.getElementById('cr-rev').value = cfg.revPct;
  document.querySelectorAll('.cr-dia').forEach(c => c.checked = cfg.dias.indexOf(parseInt(c.value)) !== -1);
}
function mondayOf(key) { const d = new Date(key + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateToKey(d); }
function renderCronLista() {
  const box = document.getElementById('cr-body'), kp = document.getElementById('cr-kpis'); if (!box) return;
  const c = plano.cron;
  if (!c || !Array.isArray(c.itens) || !c.itens.length) { kp.innerHTML = ''; box.innerHTML = '<div class="pro-card"><div style="font-size:13px;color:var(--text-mid)">Nenhum cronograma ainda. Ajuste as datas acima e clique em <b>Gerar cronograma</b>, ou <b>importe o edital em PDF</b> para o app organizar as matérias primeiro.</div></div>'; return; }
  const tk = todayKey(), done = c.itens.filter(i => i.done).length, atras = c.itens.filter(i => !i.done && i.date < tk).length;
  kp.innerHTML = `<div class="kpi"><div class="v">${Math.round(done / c.itens.length * 100)}%</div><div class="t">Cronograma cumprido</div><div class="s">${done}/${c.itens.length} blocos</div></div>
    <div class="kpi"><div class="v">${c.stats.diasEstudo}</div><div class="t">Dias de estudo</div><div class="s">+ ${c.stats.diasRev} de revisão final</div></div>
    <div class="kpi"><div class="v">${c.stats.horas}h</div><div class="t">Horas planejadas</div></div>
    <div class="kpi"><div class="v">${atras}</div><div class="t">Blocos atrasados</div><div class="s">${atras ? 'Use “Replanejar a partir de hoje”' : 'Tudo em dia 🎉'}</div></div>`;
  const weeks = {}; c.itens.forEach(i => { (weeks[mondayOf(i.date)] = weeks[mondayOf(i.date)] || []).push(i); });
  const keys = Object.keys(weeks).sort(), cur = mondayOf(tk);
  let html = c.stats.fora > 0 ? `<div class="pro-note"><div class="hint-icon">⚠️</div><div>Com esse tempo, ${c.stats.fora} tópico(s) ficaram de fora (os menos prioritários). Aumente as horas por dia, o período ou os dias de estudo para cobrir tudo.</div></div>` : '';
  html += keys.map((wk, n) => {
    const its = weeks[wk], dn = its.filter(i => i.done).length, dates = Array.from(new Set(its.map(i => i.date))).sort();
    const open = wk >= cur && (n === keys.indexOf(keys.filter(k => k >= cur)[0]) || n === keys.indexOf(keys.filter(k => k >= cur)[0]) + 1) ? ' open' : '';
    return `<details class="pro-card sch-week"${open}><summary>Semana ${n + 1} · ${fmtBR(dates[0]).slice(0, 5)} a ${fmtBR(dates[dates.length - 1]).slice(0, 5)} <span class="chip ${dn === its.length ? 'grn' : ''}">${dn}/${its.length}</span></summary>
      ${dates.map(dt => `<div class="sch-day${dt === tk ? ' today' : ''}"><div class="sch-d">${DIAS_N[new Date(dt + 'T00:00:00').getDay()]} ${fmtBR(dt).slice(0, 5)} ${dt === tk ? '<span class="chip yel">hoje</span>' : ''}${dt < tk && its.some(i => i.date === dt && !i.done) ? '<span class="chip red">atrasado</span>' : ''}</div>
        ${its.filter(i => i.date === dt).map(i => `<label class="sch-it${i.done ? ' done' : ''}"><input type="checkbox" class="cbx" ${i.done ? 'checked' : ''} onchange="cronToggle('${i.id}')"><span class="nm"><b>${escOpt(i.disc)}</b>: ${escOpt(i.topic)}</span><span class="chip ${i.tipo === 'estudo' ? '' : i.tipo === 'simulado' ? 'red' : 'yel'}">${i.min} min</span></label>`).join('')}</div>`).join('')}
    </details>`;
  }).join('');
  box.innerHTML = html;
}
function renderCronograma() { renderCronForm(); renderCronLista(); }
function renderHojeCron() {
  const card = document.getElementById('hj-cron-card'); if (!card) return;
  const c = plano.cron; if (!c || !Array.isArray(c.itens)) { card.style.display = 'none'; return; }
  const tk = todayKey(), hoje = c.itens.filter(i => i.date === tk), atras = c.itens.filter(i => !i.done && i.date < tk).length;
  card.style.display = '';
  document.getElementById('hj-cron').innerHTML = (hoje.length ? hoje.map(i => `<label class="sch-it${i.done ? ' done' : ''}"><input type="checkbox" class="cbx" ${i.done ? 'checked' : ''} onchange="cronToggle('${i.id}')"><span class="nm"><b>${escOpt(i.disc)}</b>: ${escOpt(i.topic)}</span><span class="chip">${i.min} min</span></label>`).join('') : '<div style="font-size:12px;color:var(--text-soft)">Nada agendado para hoje. Dia de descanso ou fora do período.</div>') +
    (atras ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip red">${atras} atrasado(s)</span><button class="mini-btn" onclick="switchTab('cronograma');cronReplan()">↻ Replanejar a partir de hoje</button></div>` : '') +
    '<button class="mini-btn" style="align-self:flex-start" onclick="switchTab(\'cronograma\')">Ver cronograma completo</button>';
}

// ══ RAIO-X DA BANCA ═══════════════════════════════════════
function rxDefault() {
  const b = normS(CONCURSO_INFO.banca || ''), nm = normS((CONCURSO_INFO.concurso || '') + ' ' + (CONCURSO_INFO.cargo || ''));
  const tipo = /cebraspe|cespe/.test(b) ? 'ce' : 'me';
  let perfil = '', blocos = [], minTotal = 0, fonte = '';
  if (tipo === 'ce') perfil = 'Cebraspe: prova de itens certo/errado. Em geral cada item errado anula um item certo, então só marque quando tiver segurança. Os editais costumam exigir nota mínima por bloco, além da nota total.';
  else if (/fcc/.test(b)) perfil = 'FCC: questões de múltipla escolha com 5 alternativas (A a E), sem anulação por erro. Responda todas. As alternativas costumam ser parecidas: leia a lei seca com atenção.';
  if (/\bprf\b/.test(nm) && /policial/.test(nm)) {
    blocos = [
      { nome: 'Bloco I', itens: 55, min: 15, discs: 'Língua Portuguesa, Raciocínio Lógico-Matemático, Noções de Informática, Física, Ética no Serviço Público, Geopolítica' },
      { nome: 'Bloco II', itens: 30, min: 10, discs: 'Legislação de Trânsito (CTB)' },
      { nome: 'Bloco III', itens: 35, min: 10, discs: 'Direito Administrativo, Direito Constitucional, Direito Penal, Direito Processual Penal, Legislação Especial, Direitos Humanos' }
    ];
    minTotal = 50;
    fonte = 'Fonte: edital PRF 2021 (Cebraspe): 120 itens certo/errado em 3 blocos, mínimos de 15, 10 e 10 pontos por bloco e 50 no total. Em 2021 o Bloco I também incluiu Língua Estrangeira (inglês ou espanhol). Confirme no edital novo.';
  }
  return { tipo, perfil, blocos, minTotal, fonte, itensDisc: {}, provas: [] };
}
function rx() { if (!plano.rx) plano.rx = rxDefault(); return plano.rx; }
function rxSet(k, v) { rx()[k] = v; persist(); renderRaioX(); }
function rxBlocoAdd() { rx().blocos.push({ nome: 'Bloco ' + (rx().blocos.length + 1), itens: 0, min: 0, discs: '' }); persist(); renderRaioX(); }
function rxBlocoDel(i) { rx().blocos.splice(i, 1); persist(); renderRaioX(); }
function rxBlocoSet(i, k, v) { rx().blocos[i][k] = (k === 'itens' || k === 'min') ? (parseFloat(v) || 0) : v; persist(); renderRaioX(); }
function rxItensDisc(nome, v) { rx().itensDisc[nome] = parseInt(v) || 0; persist(); renderRaioX(); }
function accDisc(nome) { const n = normS(nome); let ac = 0, er = 0; historico.forEach(r => { if (normS(r.disc) === n) { ac += r.acertos || 0; er += r.erros || 0; } }); return { ac, er }; }
function rxAplicarPesos() {
  const r = rx(), vals = EDITAL.map(d => r.itensDisc[d.nome] || 0), mx = Math.max.apply(null, vals.concat([0]));
  if (!mx) { showToast('⚠️', 'Preencha os itens por matéria primeiro.'); return; }
  EDITAL.forEach(d => { const q = r.itensDisc[d.nome] || 0; if (q > 0) d.peso = Math.max(1, Math.min(5, Math.round(1 + 4 * q / mx))); });
  persist(); renderDiscs(); renderRaioX(); updateAll(); showToast('★', 'Prioridades ajustadas pelo peso real da prova!');
}


function rxAddProva() {
  const disc = vv('rxp-disc'), topic = vv('rxp-topic').trim(), qtd = parseInt(vv('rxp-qtd')) || 0;
  if (!disc || !topic || qtd < 1) { showToast('⚠️', 'Informe matéria, assunto e quantidade.'); return; }
  rx().provas.push({ id: Date.now() + Math.random(), ano: parseInt(vv('rxp-ano')) || 0, prova: vv('rxp-prova').trim(), disc, topic, qtd, fonte: vv('rxp-fonte').trim() });
  ['rxp-topic', 'rxp-qtd'].forEach(id => document.getElementById(id).value = '');
  persist(); renderRaioX(); renderHoje(); showToast('🔬', vv('rxp-fonte').trim() ? 'Incidência registrada com fonte!' : 'Registrado como estimativa (sem fonte).');
}
function rxLote() {
  let n = 0, sem = 0;
  vv('rxp-lote').split(/\r?\n/).forEach(l => {
    const p = l.split(/;|\t/).map(s => s.trim()); if (p.length < 3) return;
    const d = EDITAL.find(x => normS(x.nome) === normS(p[0])) || EDITAL.find(x => normS(x.nome).indexOf(normS(p[0])) > -1 && p[0].length > 3);
    const q = parseInt(p[2]); if (!p[1] || !q) return;
    rx().provas.push({ id: Date.now() + Math.random(), ano: parseInt(p[3]) || 0, prova: '', disc: d ? d.nome : p[0], topic: p[1], qtd: q, fonte: p[4] || '' }); n++; if (!p[4]) sem++;
  });
  if (!n) { showToast('⚠️', 'Nenhuma linha válida. Use: matéria; assunto; questões; ano; fonte'); return; }
  document.getElementById('rxp-lote').value = ''; persist(); renderRaioX(); showToast('🔬', n + ' linha(s) importada(s)' + (sem ? ', ' + sem + ' sem fonte (estimativa)' : '') + '.');
}
function rxDelProva(id) { rx().provas = rx().provas.filter(p => p.id !== id); persist(); renderRaioX(); }
function renderRaioX() {
  if (!document.getElementById('rx-blocos')) return;
  const r = rx();
  document.getElementById('rx-tipo').value = r.tipo; document.getElementById('rx-perfil').value = r.perfil || '';
  document.getElementById('rx-fonte').textContent = r.fonte || (r.perfil ? '' : 'Dica: informe a banca em ✏️ Editar concurso para sugerir o perfil, e confirme as regras no edital.');
  document.getElementById('rx-mintot').value = r.minTotal || '';
  document.getElementById('rx-blocos').innerHTML = r.blocos.length ? r.blocos.map((b, i) => `<tr><td><input class="man-inp" value="${escOpt(b.nome)}" onchange="rxBlocoSet(${i},'nome',this.value)"></td><td style="width:70px"><input class="man-inp" type="number" value="${b.itens || ''}" onchange="rxBlocoSet(${i},'itens',this.value)"></td><td style="width:90px"><input class="man-inp" type="number" value="${b.min || ''}" onchange="rxBlocoSet(${i},'min',this.value)"></td><td><input class="man-inp" value="${escOpt(b.discs || '')}" onchange="rxBlocoSet(${i},'discs',this.value)"></td><td><button class="mini-btn no" onclick="rxBlocoDel(${i})">🗑</button></td></tr>`).join('') : '<tr><td colspan="5" class="rx-note">Sem blocos. Use “＋ Bloco” para copiar o quadro do edital.</td></tr>';
  // projeção por bloco
  let ph = '';
  if (r.blocos.length) {
    let totNota = 0, totItens = 0, temDados = false;
    const rows = r.blocos.map(b => {
      const names = (b.discs || '').split(',').map(s => normS(s.trim())).filter(Boolean);
      let ac = 0, er = 0; EDITAL.forEach(d => { if (names.indexOf(normS(d.nome)) > -1) { const x = accDisc(d.nome); ac += x.ac; er += x.er; } });
      const n = ac + er, a = n >= 10 ? ac / n : null, it = b.itens || 0;
      const need = it ? (r.tipo === 'ce' ? (1 + (b.min || 0) / it) / 2 : (b.min || 0) / it) : null;
      const proj = a === null || !it ? null : (r.tipo === 'ce' ? Math.max(0, it * (2 * a - 1)) : it * a);
      if (proj !== null) { totNota += proj; temDados = true; } else totNota += 0; totItens += it;
      const ok = proj !== null && b.min ? proj >= b.min : null;
      return `<tr><td><b>${escOpt(b.nome)}</b></td><td>${it}</td><td>${b.min || '—'}</td><td>${need !== null && b.min ? Math.min(100, Math.round(need * 100)) + '%' : '—'}</td><td>${a !== null ? Math.round(a * 100) + '% <span class="rx-note">(' + n + ' q.)</span>' : '<span class="rx-note">poucos dados (' + n + ' q.)</span>'}</td><td>${proj !== null ? Math.round(proj * 10) / 10 : '—'}</td><td class="rx-st ${ok === null ? '' : ok ? 'ok' : 'no'}">${ok === null ? '—' : ok ? '✅ acima do mínimo' : '⚠️ risco de eliminação'}</td></tr>`;
    }).join('');
    const comDados = r.blocos.filter(b => { const nm = (b.discs || '').split(',').map(s => normS(s.trim())).filter(Boolean); let q = 0; EDITAL.forEach(d => { if (nm.indexOf(normS(d.nome)) > -1) { const x = accDisc(d.nome); q += x.ac + x.er; } }); return q >= 10; }).length;
    const parcial = comDados < r.blocos.length;
    const tot = r.minTotal ? (temDados && parcial ? `<span class="rx-note">parcial: ${Math.round(totNota * 10) / 10} pts em ${comDados} de ${r.blocos.length} blocos (faltam dados nos outros)</span>` : temDados ? (totNota >= r.minTotal ? `<span class="rx-st ok">✅ ${Math.round(totNota * 10) / 10} de ${r.minTotal} pts</span>` : `<span class="rx-st no">⚠️ ${Math.round(totNota * 10) / 10} de ${r.minTotal} pts</span>`) : '<span class="rx-note">registre questões nas matérias para projetar</span>') : '';
    ph = `<div class="rx-scroll"><table class="rx-tbl"><thead><tr><th>Bloco</th><th>Itens</th><th>Mínimo</th><th>Acerto necessário</th><th>Seu acerto</th><th>Nota projetada</th><th>Situação</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div style="font-size:13px;font-weight:700;color:var(--navy)">Total projetado ${tot}</div>
      <div class="rx-note">Projeção = itens × seu aproveitamento atual${r.tipo === 'ce' ? ' (certo/errado: marcando todos, nota ≈ itens × (2×acerto − 1))' : ''}. Usa as questões registradas no histórico (precisa de 10 ou mais por bloco).</div>`;
  } else ph = '<div class="rx-note">Preencha o quadro da prova acima para ver a projeção da sua nota e o risco de eliminação por bloco.</div>';
  document.getElementById('rx-proj').innerHTML = ph;
  // itens por matéria + pontos
  document.getElementById('rx-itens').innerHTML = EDITAL.length ? EDITAL.map(d => `<div class="row-i"><div class="main"><div class="nm">${escOpt(d.nome)} ${pesoBadge(d)}</div></div><input class="man-inp" type="number" min="0" style="max-width:80px" value="${r.itensDisc[d.nome] || ''}" placeholder="itens" onchange="rxItensDisc(${JSON.stringify(d.nome).replace(/"/g, '&quot;')},this.value)"></div>`).join('') : '<div class="rx-note">Sem matérias.</div>';
  const pts = EDITAL.filter(d => (r.itensDisc[d.nome] || 0) > 0).map(d => { const x = accDisc(d.nome), n = x.ac + x.er, a = n >= 5 ? x.ac / n : null, q = r.itensDisc[d.nome]; return { d, q, a, perd: a === null ? null : q * (1 - a) }; }).sort((a, b) => (b.perd === null ? -1 : b.perd) - (a.perd === null ? -1 : a.perd));
  document.getElementById('rx-pontos').innerHTML = pts.length ? pts.map(p => `<div class="row-i"><div class="main"><div class="nm">${escOpt(p.d.nome)}</div><div class="sb">${p.q} itens · ${p.a === null ? 'sem dados ainda' : Math.round(p.a * 100) + '% de acerto'}</div></div><span class="chip ${p.perd === null ? '' : p.perd >= p.q * 0.4 ? 'red' : 'yel'}">${p.perd === null ? '—' : '~' + Math.round(p.perd * 10) / 10 + ' itens a recuperar'}</span></div>`).join('') + '<div class="rx-note">Ordenado por quantos itens você tende a perder em cada matéria. Comece pelo topo.</div>' : '<div class="rx-note">Preencha os itens por matéria ao lado para ver onde estão seus pontos.</div>';
  // incidência
  const sel = document.getElementById('rxp-disc'), f = document.getElementById('rxp-f'), v1 = sel.value, v2 = f.value;
  sel.innerHTML = '<option value="">— matéria —</option>' + EDITAL.map(d => `<option value="${escOpt(d.nome)}">${escOpt(d.nome)}</option>`).join('');
  f.innerHTML = '<option value="">Todas as matérias</option>' + EDITAL.map(d => `<option value="${escOpt(d.nome)}">${escOpt(d.nome)}</option>`).join('');
  sel.value = v1; f.value = v2;
  const agg = {}; r.provas.forEach(p => { if (v2 && p.disc !== v2) return; const k = normS(p.disc) + '|' + normS(p.topic); const o = agg[k] = agg[k] || { disc: p.disc, topic: p.topic, q: 0, anos: {}, ids: [], fontes: {}, sem: 0 }; o.q += p.qtd; if (p.ano) o.anos[p.ano] = 1; o.ids.push(p.id); if (p.fonte) o.fontes[p.fonte] = 1; else o.sem += p.qtd; });
  const lst = Object.keys(agg).map(k => agg[k]).sort((a, b) => b.q - a.q), mxq = Math.max(1, ...lst.map(x => x.q)), tq = lst.reduce((a, x) => a + x.q, 0);
  document.getElementById('rx-rank').innerHTML = lst.length ? `<div class="rx-note">${tq} questões registradas em ${lst.length} assuntos. Os mais cobrados:</div>` + lst.slice(0, 25).map((x, i) => `<div class="row-i"><div style="width:22px;font-weight:900;color:var(--rust)">${i + 1}</div><div class="main"><div class="nm">${i < 5 ? '🔥 ' : ''}${escOpt(x.topic)}</div><div class="sb">${escOpt(x.disc)}${Object.keys(x.anos).length ? ' · ' + Object.keys(x.anos).sort().join(', ') : ''}${Object.keys(x.fontes).length ? ' · fonte: ' + escOpt(Object.keys(x.fontes).slice(0, 2).join('; ')) : ''}${x.sem ? ' · <span class="chip yel">' + x.sem + ' q. estimativa (sem fonte)</span>' : ''}</div><div class="bar" style="margin-top:6px"><i style="width:${x.q / mxq * 100}%"></i></div></div><span class="chip yel" style="font-size:12px">${x.q} q.</span><button class="mini-btn no" title="Remover" onclick="${x.ids.map(id => 'rxDelProva(' + id + ')').join(';')}">🗑</button></div>`).join('') : '<div class="rx-note">Nenhum dado ainda. Registre acima o que caiu nas provas anteriores.</div>';
}

// ══ ZERAR DADOS ═══════════════════════════════════════════
function openZero() {
  ['z-state', 'z-hist', 'z-rev', 'z-sim', 'z-err', 'z-cron'].forEach(id => document.getElementById(id).checked = true);
  document.getElementById('z-scope').value = 'atual'; document.getElementById('z-conf').value = ''; zeroChk();
  document.getElementById('zero-modal').classList.add('open');
}
function zeroChk() {
  const any = ['z-state', 'z-hist', 'z-rev', 'z-sim', 'z-err', 'z-cron'].some(id => document.getElementById(id).checked);
  document.getElementById('z-go').disabled = !(any && vv('z-conf').trim().toUpperCase() === 'ZERAR');
}
function zeroGo() {
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes de zerar.'); return; }
  const chk = id => document.getElementById(id).checked;
  snapshot('antes de zerar dados');
  commitCurrent();
  const ids = vv('z-scope') === 'todos' ? Object.keys(store.concursos) : [curId];
  ids.forEach(id => {
    const c = store.concursos[id]; c.data = c.data || {};
    if (chk('z-state')) { if (vv('z-scope') === 'todos') { store.kb.prog = {}; store.kb.orig = {}; } else kbPurge(id); c.data.state = {}; if (id === curId) state = c.data.state; }
    if (chk('z-hist')) c.data.historico = [];
    if (chk('z-rev')) c.data.revisoes = [];
    if (chk('z-sim')) c.data.simulados = [];
    if (chk('z-err')) c.data.erros = [];
    if (chk('z-cron') && c.data.plano) delete c.data.plano.cron;
  });
  loadConcurso(curId); persist(); refreshAll();
  document.getElementById('zero-modal').classList.remove('open');
  showToast('🧹', 'Dados de estudo zerados. Bons estudos!');
}

// ── BACKUP: compartilhar + lembretes ──

async function ativarLembrete() {
  if (!('Notification' in window)) { showToast('⚠️', 'Este navegador não suporta notificações.'); return; }
  const p = await Notification.requestPermission();
  if (p === 'granted') { plano.notif = true; persist(); showToast('🔔', 'Pronto! Aviso das revisões ao abrir o app.'); renderHoje(); lembreteRevisoes(true); }
  else showToast('⚠️', 'Permissão de notificação negada.');
}
function lembreteRevisoes(force) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !plano.notif) return;
  const tk = todayKey(); if (!force && plano.ultAviso === tk) return;
  const n = revisoes.filter(r => !r.done && r.revDate <= tk).length; if (!n) return;
  plano.ultAviso = tk; persist();
  const body = 'Você tem ' + n + (n === 1 ? ' revisão' : ' revisões') + ' para fazer hoje.';
  if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then(r => r.showNotification('AprovaTropa', { body, icon: 'icons/icon-192.png' })).catch(() => { try { new Notification('AprovaTropa', { body }); } catch (e) {} });
  else { try { new Notification('AprovaTropa', { body }); } catch (e) {} }
}

// ── BACKUP / RESTORE ──────────────────────────────────
// ══ ETAPA D: cruzar editais e compartilhar progresso sem duplicar ══
function linkBadge(tid) { return kbA(curId, tid) ? '<span class="dom-b" title="Assunto compartilhado com outro concurso: o progresso é um registro só">🔗</span>' : ''; }
const STOPW = { de: 1, da: 1, do: 1, das: 1, dos: 1, em: 1, para: 1, com: 1, ou: 1, as: 1, os: 1, no: 1, na: 1, nos: 1, nas: 1, ao: 1, aos: 1, por: 1, sobre: 1, entre: 1, que: 1, uma: 1, art: 1, lei: 1 };
function tokensOf(s) { return normS(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOPW[w] && !/^\d+$/.test(w)).map(w => w.replace(/s$/, '')); }
function discKey(n) {
  const x = normS(n);
  if (/portugu/.test(x)) return 'portugues';
  if (/racioc|matemat/.test(x)) return 'raciocinio-matematica';
  if (/inform/.test(x)) return 'informatica';
  if (/processual penal/.test(x)) return 'dir-processual-penal';
  if (/penal/.test(x) && /direito|nocoes/.test(x)) return 'dir-penal';
  if (/constitucional/.test(x)) return 'dir-constitucional';
  if (/administrativo/.test(x)) return 'dir-administrativo';
  if (/direitos humanos/.test(x)) return 'direitos-humanos';
  if (/consumidor/.test(x)) return 'dir-consumidor';
  if (/civil/.test(x) && /direito|nocoes/.test(x)) return 'dir-civil';
  if (/transito|ctb/.test(x)) return 'transito';
  if (/fisica/.test(x)) return 'fisica';
  if (/etica/.test(x)) return 'etica';
  if (/geopolit/.test(x)) return 'geopolitica';
  return tokensOf(n).sort().join('-');
}
function simTok(a, b) {
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const sa = {}, sb = {}; a.forEach(w => sa[w] = 1); b.forEach(w => sb[w] = 1);
  const inter = Object.keys(sa).filter(w => sb[w]).length, uni = Object.keys(Object.assign({}, sa, sb)).length;
  return inter >= 2 ? inter / uni : 0;
}
function concCurto(id) { const n = store.concursos[id].info.concurso || id; return n.length > 26 ? n.slice(0, 24) + '…' : n; }
function computeCross(ids) {
  commitCurrent(); const clusters = [];
  ids.forEach(cid => {
    const c = store.concursos[cid];
    (c.edital || []).forEach(d => { const dk = discKey(d.nome); d.grupos.forEach(g => g.topicos.forEach((t, i) => {
      const it = { cid, tid: d.id + '_' + slug(g.nome) + '_' + i, label: t, disc: d.nome, tk: tokensOf(t) };
      let best = null, bs = 0;
      clusters.forEach(cl => { if (cl.dk !== dk || cl.members.some(m => m.cid === cid)) return; const s = Math.min.apply(null, cl.members.map(m => simTok(m.tk, it.tk))); if (s >= 0.7 && s > bs) { bs = s; best = cl; } });
      if (best) { best.members.push(it); best.q = Math.min(best.q, bs); } else clusters.push({ dk, members: [it], q: 1 });
    })); });
  });
  return clusters;
}
function clVinc(cl) { const as = cl.members.map(m => kbA(m.cid, m.tid)); return as.every(a => a && a === as[0]) ? 'sim' : as.some(Boolean) ? 'parcial' : 'nao'; }
function bestOf(a, b) { if (!a) return clone(b || {}); if (!b) return a; const pick = ((b.questoes || 0) > (a.questoes || 0)) ? b : a, r = Object.assign({}, pick); r.done = !!(a.done || b.done); r.datetime = a.datetime || b.datetime || null; return r; }
function kbVincular(ms) {
  commitCurrent(); const kb = store.kb; let aid = null; const aids = {};
  ms.forEach(m => { const a = kbA(m.cid, m.tid); if (a) { aids[a] = 1; if (!aid) aid = a; } });
  if (!aid) aid = 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  Object.keys(aids).forEach(a => { if (a !== aid) { Object.keys(kb.link).forEach(k => { if (kb.link[k] === a) kb.link[k] = aid; }); kb.prog[aid] = bestOf(kb.prog[aid], kb.prog[a]); delete kb.prog[a]; } });
  kb.orig = kb.orig || {}; kb.orig[aid] = kb.orig[aid] || []; kb.nomes = kb.nomes || {};
  ms.forEach(m => {
    if (kbA(m.cid, m.tid) === aid) return;
    const st = (store.concursos[m.cid].data.state || {})[m.tid];
    if (st) { kb.orig[aid].push({ cid: m.cid, tid: m.tid, state: clone(st) }); kb.prog[aid] = bestOf(kb.prog[aid], st); }
    kb.link[m.cid + '|' + m.tid] = aid;
  });
  if (!kb.nomes[aid]) kb.nomes[aid] = ms[0].label;
  kb.prog[aid] = kb.prog[aid] || {};
}
function kbLeave(cid, tid, keep) {
  const kb = store.kb, k = cid + '|' + tid, a = kb.link[k]; if (!a) return;
  const put = (key, val) => { const p = key.indexOf('|'); const c = store.concursos[key.slice(0, p)]; if (c) { c.data.state = c.data.state || {}; c.data.state[key.slice(p + 1)] = clone(val); } };
  delete kb.link[k];
  if (keep && kb.prog[a]) put(k, kb.prog[a]);
  const mem = Object.keys(kb.link).filter(x => kb.link[x] === a);
  if (mem.length <= 1) {
    mem.forEach(x => { delete kb.link[x]; if (kb.prog[a]) put(x, kb.prog[a]); });
    delete kb.prog[a]; if (kb.orig) delete kb.orig[a]; if (kb.nomes) delete kb.nomes[a];
  }
}
function kbPurge(cid) { Object.keys(store.kb.link).filter(k => k.indexOf(cid + '|') === 0).forEach(k => kbLeave(cid, k.slice(cid.length + 1), false)); }
function horasMembros(cl) {
  let h = 0, q = 0;
  cl.members.forEach(m => { const c = store.concursos[m.cid]; (c.data.historico || []).forEach(r => { if (r.disc === m.disc && r.topic && sameTopic(r.topic, m.label)) { h += r.horas || 0; q += (r.acertos || 0) + (r.erros || 0); } }); });
  return { h, q };
}
let _cz = { sel: null, cl: [] };
function renderCruzar() {
  const sel = document.getElementById('cz-sel'); if (!sel) return;
  const todos = Object.keys(store.concursos).filter(id => (store.concursos[id].edital || []).length);
  if (!_cz.sel) _cz.sel = todos.slice(); _cz.sel = _cz.sel.filter(id => todos.indexOf(id) > -1);
  sel.innerHTML = todos.map(id => `<label class="days-pick" style="display:flex"><label style="display:flex;gap:6px;align-items:center;font-size:12px;font-weight:700;color:var(--navy);background:var(--bg);padding:6px 10px;border-radius:8px;cursor:pointer"><input type="checkbox" ${_cz.sel.indexOf(id) > -1 ? 'checked' : ''} onchange="czSel('${id}',this.checked)">${escOpt(concCurto(id))}</label></label>`).join('') || '<div class="rx-note">Cadastre as matérias de pelo menos dois concursos.</div>';
  const ids = _cz.sel; if (ids.length < 2) { ['cz-kpis', 'cz-comuns', 'cz-prov', 'cz-excl', 'cz-rx'].forEach(i => document.getElementById(i).innerHTML = '<div class="rx-note">Selecione pelo menos dois concursos.</div>'); return; }
  const cls = _cz.cl = computeCross(ids), comuns = cls.filter(c => c.members.length >= 2 && c.q === 1), prov = cls.filter(c => c.members.length >= 2 && c.q < 1), excl = cls.filter(c => c.members.length === 1);
  // resumo
  document.getElementById('cz-kpis').innerHTML = '<table class="rx-tbl"><thead><tr><th>Concurso</th><th>Tópicos</th><th>Comuns</th><th>Parecidos</th><th>Exclusivos</th><th>Já compartilhados</th></tr></thead><tbody>' + ids.map(id => {
    const mine = cls.filter(c => c.members.some(m => m.cid === id)), tot = mine.length || 1;
    const nc = mine.filter(c => c.members.length >= 2 && c.q === 1).length, np = mine.filter(c => c.members.length >= 2 && c.q < 1).length, ne = mine.filter(c => c.members.length === 1).length;
    const sh = mine.filter(c => c.members.length >= 2 && clVinc(c) === 'sim').length;
    return `<tr><td><b>${escOpt(concCurto(id))}</b></td><td>${mine.length}</td><td>${nc} <span class="rx-note">(${Math.round(nc / tot * 100)}%)</span></td><td>${np}</td><td>${ne} <span class="rx-note">(${Math.round(ne / tot * 100)}%)</span></td><td>${sh}</td></tr>`;
  }).join('') + '</tbody></table><div class="rx-note">A coluna “Comuns” mostra quanto do edital você cobre estudando só os assuntos em comum.</div>';
  const chips = cl => cl.members.map(m => `<span class="cz-chip">${escOpt(concCurto(m.cid))}</span>`).join(' ');
  const row = (cl, k, sel2) => {
    const v = clVinc(cl), hm = horasMembros(cl), a = cl.members.map(m => tsOf(m.cid, m.tid)), done = a.some(x => x.done);
    return `<div class="row-i" style="align-items:flex-start">${sel2 ? `<input type="checkbox" class="cbx cz-pv" value="${k}">` : ''}<div class="main"><div class="nm" style="white-space:normal">${escOpt(cl.members[0].label)}</div><div class="sb">${escOpt(cl.members[0].disc)} · ${chips(cl)}${sel2 ? '<br>' + cl.members.slice(1).map(m => escOpt(m.label)).join(' / ') : ''}<br>${hm.h ? 'Horas neste assunto (somadas uma vez): ' + fmtH(hm.h) + ' · ' : ''}${done ? '✅ concluído em algum concurso' : ''}</div></div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="chip ${v === 'sim' ? 'grn' : v === 'parcial' ? 'yel' : ''}">${v === 'sim' ? '🔗 vinculado' : v === 'parcial' ? 'parcial' : 'não vinculado'}</span>${v !== 'nao' ? `<button class="mini-btn" onclick="czDesvincular(${k})">Desvincular</button>` : ''}</div></div>`;
  };
  const nv = comuns.filter(c => clVinc(c) !== 'sim').length;
  document.getElementById('cz-comuns').innerHTML = comuns.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="chip">${comuns.length} assuntos comuns</span>${nv ? `<button class="mini-btn pri" onclick="czVincularExatos()">🔗 Vincular os ${nv} ainda não vinculados</button>` : '<span class="chip grn">todos vinculados</span>'}</div>` + comuns.slice(0, 60).map(c => row(c, cls.indexOf(c), false)).join('') + (comuns.length > 60 ? `<div class="rx-note">Mostrando 60 de ${comuns.length}.</div>` : '') + '<div class="rx-note">Ao vincular, onde os dois concursos já tinham questões registradas fica o maior registro (não soma), e os originais ficam guardados.</div>' : '<div class="rx-note">Nenhum assunto idêntico entre os concursos selecionados.</div>';
  document.getElementById('cz-prov').innerHTML = prov.length ? `<button class="mini-btn pri" style="align-self:flex-start" onclick="czVincularSel()">🔗 Vincular os marcados</button>` + prov.slice(0, 60).map(c => row(c, cls.indexOf(c), true)).join('') : '<div class="rx-note">Nenhum assunto parecido para confirmar.</div>';
  document.getElementById('cz-excl').innerHTML = ids.map(id => { const ex = excl.filter(c => c.members[0].cid === id); return `<details><summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--navy)">${escOpt(concCurto(id))}: ${ex.length} exclusivos</summary>${ex.slice(0, 80).map(c => `<div class="row-i"><div class="main"><div class="nm" style="white-space:normal">${escOpt(c.members[0].label)}</div><div class="sb">${escOpt(c.members[0].disc)}</div></div></div>`).join('')}${ex.length > 80 ? `<div class="rx-note">Mostrando 80 de ${ex.length}.</div>` : ''}</details>`; }).join('');
  // raio-x cruzado (sem duplicar o mesmo registro de prova)
  const seen = {}, agg = {};
  ids.forEach(id => { const c = store.concursos[id], rxo = (c.data.plano || {}).rx; ((rxo && rxo.provas) || []).forEach(p => {
    const tk = tokensOf(p.topic).join(' '), key = [p.ano || '', normS(p.prova || ''), discKey(p.disc), tk, normS(p.fonte || '')].join('|'); if (seen[key]) return; seen[key] = 1;
    const k2 = discKey(p.disc) + '|' + tk, o = agg[k2] = agg[k2] || { disc: p.disc, topic: p.topic, q: 0, fontes: {}, sem: 0, concs: {} };
    o.q += p.qtd || 0; o.concs[id] = 1; if (p.fonte) o.fontes[p.fonte] = 1; else o.sem += p.qtd || 0; }); });
  const L = Object.keys(agg).map(k => agg[k]).sort((a, b) => b.q - a.q).slice(0, 15);
  document.getElementById('cz-rx').innerHTML = L.length ? L.map(o => `<div class="row-i"><div class="main"><div class="nm" style="white-space:normal">${escOpt(o.topic)}</div><div class="sb">${escOpt(o.disc)} · registrado em: ${Object.keys(o.concs).map(c => escOpt(concCurto(c))).join(', ')}${Object.keys(o.fontes).length ? '<br>Fonte: ' + escOpt(Object.keys(o.fontes).slice(0, 3).join('; ')) : ''}${o.sem ? '<br><span class="chip yel">' + o.sem + ' q. sem fonte (estimativa)</span>' : ''}</div></div><span class="chip yel" style="font-size:12px">${o.q} q.</span></div>`).join('') + '<div class="rx-note">São contagens de questões que VOCÊ registrou a partir de provas anteriores (o mesmo registro não é somado duas vezes). Não são probabilidades de cobrança.</div>' : '<div class="rx-note">Nenhuma incidência registrada ainda. Cadastre em Raio-X da banca → Incidência em provas anteriores, de preferência com a fonte.</div>';
}
function czSel(id, on) { _cz.sel = (_cz.sel || []).filter(x => x !== id); if (on) _cz.sel.push(id); renderCruzar(); }
function czAfter(msg) { persist(); refreshAll(); showToast('🧩', msg); }
function czVincularExatos() {
  snapshot('antes de vincular assuntos');
  _cz.cl = computeCross((_cz.sel || []).filter(id => store.concursos[id] && (store.concursos[id].edital || []).length));
  let n = 0; _cz.cl.filter(c => c.members.length >= 2 && c.q === 1 && clVinc(c) !== 'sim').forEach(c => { kbVincular(c.members); n++; });
  czAfter(n + ' assunto(s) vinculado(s). O progresso agora é compartilhado.');
}
function czVincularSel() {
  const ks = Array.from(document.querySelectorAll('.cz-pv:checked')).map(x => parseInt(x.value));
  if (!ks.length) { showToast('⚠️', 'Marque os assuntos que são iguais.'); return; }
  snapshot('antes de vincular assuntos'); ks.forEach(k => { const cl = _cz.cl[k]; if (cl && cl.members.every(m => store.concursos[m.cid])) kbVincular(cl.members); }); czAfter(ks.length + ' assunto(s) vinculado(s).');
}
function czDesvincular(k) {
  const cl = _cz.cl[k]; if (!cl || !cl.members.every(m => store.concursos[m.cid])) return; snapshot('antes de desvincular assunto');
  cl.members.forEach(m => kbLeave(m.cid, m.tid, true)); czAfter('Assunto desvinculado: cada concurso ficou com uma cópia do progresso atual.');
}
// ══ ETAPA C: indicadores (horas, questões, novas × repetidas, simulados) ══
function getNR(prefix, ac, er) {
  const a = document.getElementById(prefix + '-rq'), b = document.getElementById(prefix + '-ra');
  if (!a || !b) return {};
  const va = a.value, vb = b.value; a.value = ''; b.value = '';
  if (va === '' && vb === '') return {};
  const n = ac + er; let rq = Math.max(0, parseInt(va) || 0); rq = Math.min(rq, n);
  const lo = Math.max(0, rq - er), hi = Math.min(rq, ac); let ra = Math.max(0, parseInt(vb) || 0); ra = Math.min(Math.max(ra, lo), hi);
  return { rq, ra, cls: 1 };
}
function agrega(rows) {
  const o = { h: 0, q: 0, ac: 0, er: 0, nQ: 0, nA: 0, rQ: 0, rA: 0, uQ: 0, uA: 0, sess: 0 };
  rows.forEach(r => {
    const ac = r.acertos || 0, er = r.erros || 0, n = ac + er;
    o.h += r.horas || 0; o.q += r.questoes || 0; o.ac += ac; o.er += er; o.sess++;
    if (r.cls) { const rq = Math.min(r.rq || 0, n), ra = Math.min(r.ra || 0, ac); o.rQ += rq; o.rA += ra; o.nQ += n - rq; o.nA += ac - ra; }
    else { o.uQ += n; o.uA += ac; }
  });
  return o;
}
function pctS(a, n) { return n > 0 ? Math.round(a / n * 100) + '%' : '—'; }
function renderDesempenho() {
  if (!document.getElementById('ds-kpis')) return;
  const sd = document.getElementById('ds-disc'), v0 = sd.value;
  sd.innerHTML = '<option value="">Todas as matérias</option>' + EDITAL.map(d => `<option value="${escOpt(d.nome)}">${escOpt(d.nome)}</option>`).join(''); sd.value = v0;
  const per = vv('ds-per'), disc = sd.value, tk = todayKey(), ini = per === 'todos' ? '' : addDays(tk, -(parseInt(per) - 1));
  const rows = historico.filter(r => (!ini || r.date >= ini) && (!disc || r.disc === disc)), A = agrega(rows);
  const sims = simulados.filter(s => !ini || s.date >= ini).slice().sort((a, b) => a.date < b.date ? -1 : 1), sc = sims.map(simScore);
  const ult3 = sc.slice(-3), mediaSim = ult3.length ? Math.round(ult3.reduce((a, b) => a + b, 0) / ult3.length * 10) / 10 : null;
  const tend = sc.length >= 2 ? Math.round((sc[sc.length - 1] - sc[0]) * 10) / 10 : null;
  const k = (v, t, s) => `<div class="kpi"><div class="v">${v}</div><div class="t">${t}</div><div class="s">${s || ''}</div></div>`;
  document.getElementById('ds-kpis').innerHTML =
    k(fmtH(A.h), 'Horas estudadas', A.sess + ' sessões') +
    k(A.q, 'Questões resolvidas', A.ac + A.er + ' com acerto/erro lançado') +
    k(pctS(A.ac, A.ac + A.er), 'Acerto geral', A.ac + ' de ' + (A.ac + A.er)) +
    k(pctS(A.nA, A.nQ), 'Acerto em questões novas', A.nQ + ' questões') +
    k(pctS(A.rA, A.rQ), 'Acerto em repetidas', A.rQ + ' questões') +
    k(A.uQ, 'Não classificadas', 'sem novas × repetidas (dados antigos ou sem detalhe)') +
    k(mediaSim !== null ? mediaSim + '%' : '—', 'Simulados (média dos 3 últimos)', sims.length + ' no período') +
    k(tend === null ? '—' : (tend >= 0 ? '▲ +' : '▼ ') + tend + ' pts', 'Evolução nos simulados', 'do primeiro ao último do período');
  // treino × simulado
  const aNov = A.nQ >= 10 ? A.nA / A.nQ * 100 : null, aGer = A.ac + A.er >= 10 ? A.ac / (A.ac + A.er) * 100 : null;
  const base = aNov !== null ? aNov : aGer, baseTxt = aNov !== null ? 'questões novas' : 'acerto geral (sem detalhe de novas)';
  let comp = '';
  if (base !== null && mediaSim !== null) {
    const dif = Math.round((base - mediaSim) * 10) / 10;
    comp = `Você acerta <b>${Math.round(base)}%</b> em ${baseTxt} e <b>${mediaSim}%</b> nos simulados: diferença de <b>${dif} pontos</b>. ${dif > 12 ? 'O treino por assunto está mais fácil que a prova real: faça mais questões misturadas, com tempo, e revise os erros dos simulados.' : dif < -5 ? 'Você vai melhor nos simulados que nos treinos por assunto: aproveite para reforçar as matérias mais fracas.' : 'Treino e simulado estão alinhados.'}`;
  } else comp = 'Para comparar, registre pelo menos 10 questões e um simulado no período.';
  if (A.rQ >= 10 && A.nQ >= 10) comp += `<br>Em questões repetidas você acerta ${pctS(A.rA, A.rQ)} contra ${pctS(A.nA, A.nQ)} nas novas: ${A.rA / A.rQ > A.nA / A.nQ + 0.15 ? 'parte do seu acerto vem de lembrar a questão, não do assunto. Confie mais no resultado das novas.' : 'sem sinal de memorização das questões.'}`;
  document.getElementById('ds-comp').innerHTML = '<div style="font-size:13px;line-height:1.6;color:var(--text-mid)">' + comp + '</div>';
  // semanas
  const ws = [], hoje = new Date(tk + 'T00:00:00');
  for (let i = 7; i >= 0; i--) { const d = new Date(hoje); d.setDate(d.getDate() - i * 7); const m = mondayOf(dateToKey(d)); ws.push({ ini: m, fim: addDays(m, 6) }); }
  const wk = ws.map(w => { const R = historico.filter(r => r.date >= w.ini && r.date <= w.fim && (!disc || r.disc === disc)), a = agrega(R); return { w, a }; });
  const mxH = Math.max(1, ...wk.map(x => x.a.h));
  document.getElementById('ds-weeks').innerHTML = '<div class="wk">' + wk.map(x => `<div class="c" title="${fmtBR(x.w.ini)}: ${fmtH(x.a.h)}, ${x.a.q} questões"><span>${x.a.h > 0 ? fmtH(x.a.h) : ''}</span><i style="height:${Math.max(3, x.a.h / mxH * 70)}px"></i><span>${fmtBR(x.w.ini).slice(0, 5)}</span><span style="color:var(--navy)">${x.a.nQ >= 5 ? pctS(x.a.nA, x.a.nQ) : (x.a.ac + x.a.er >= 5 ? pctS(x.a.ac, x.a.ac + x.a.er) + '*' : '')}</span></div>`).join('') + '</div><div class="rx-note">Barras: horas. Embaixo: acerto em questões novas (com * quando é o acerto geral, sem detalhe de novas).</div>';
  // por matéria
  const linhas = EDITAL.filter(d => !disc || d.nome === disc).map(d => {
    const R = rows.filter(r => r.disc === d.nome), a = agrega(R); let tot = 0, conc = 0, dom = 0, sp = 0;
    d.grupos.forEach(g => g.topicos.forEach((t, i) => { const tid = d.id + '_' + slug(g.nome) + '_' + i; tot++; if (getTS(tid).done) conc++; const m = masteryInfo(d, tid, t); if (m.nivel === 'dominado') dom++; if (m.nivel === 'sempratica') sp++; }));
    return `<tr><td><b>${escOpt(d.nome)}</b> ${pesoBadge(d)}</td><td>${fmtH(a.h)}</td><td>${a.q}</td><td>${pctS(a.nA, a.nQ)}<span class="rx-note"> (${a.nQ})</span></td><td>${pctS(a.rA, a.rQ)}<span class="rx-note"> (${a.rQ})</span></td><td>${conc}/${tot}</td><td><b>${dom}</b></td><td>${sp ? '<span class="chip yel">' + sp + '</span>' : '—'}</td></tr>`;
  }).join('');
  document.getElementById('ds-tbl').innerHTML = EDITAL.length ? `<table class="rx-tbl"><thead><tr><th>Matéria</th><th>Horas</th><th>Questões</th><th>Acerto novas</th><th>Acerto repetidas</th><th>Concluídos</th><th>Dominados</th><th>Concluído sem prática</th></tr></thead><tbody>${linhas}</tbody></table><div class="rx-note">“Dominado” exige questões suficientes, 80% ou mais de acerto, sem erro pendente e revisão bem lembrada. “Concluído sem prática” = marcado como concluído com menos de 8 questões.</div>` : '<div class="rx-note">Sem matérias.</div>';
}
// ══ ETAPA B: erros, revisão adaptativa, domínio e recomendação ══
const REV_STEPS = [1, 7, 30];
let revAutoSel = false;
function syncRevAutoBtn() { const b = document.getElementById('rev-auto-btn'); if (b) b.classList.toggle('done', revAutoSel); }
function toggleRevAuto() { revAutoSel = !revAutoSel; syncRevAutoBtn(); }
function setRevCfg(k, v) { store.cfg[k] = v; persist(); renderRevCfg(); }
function renderRevCfg() {
  const m = document.getElementById('rv-modo'); if (!m) return;
  m.value = store.cfg.revModo; document.getElementById('rv-auto').value = store.cfg.revAuto ? '1' : '0';
  document.getElementById('rv-expl').textContent = store.cfg.revModo === '1-7-30'
    ? 'Modelo fixo: o botão 🧠 Inteligente agenda 1 dia, depois 7 e depois 30 dias, sem mudar com o desempenho. Os botões de dias avulsos continuam funcionando.'
    : 'Modelo adaptativo: a 1ª revisão sai em 1 a 3 dias conforme seu acerto na sessão. Ao concluir cada revisão você diz como foi (bem, com dificuldade ou esqueci) e o próximo intervalo cresce, encurta ou volta para 1 dia. É uma regra prática (estimativa), não um dado de banca. Nunca agenda para depois da data da prova.';
}
function primeiroInt(ac, er) { const n = (ac || 0) + (er || 0); if (n < 5) return 1; const a = ac / n; return a < 0.6 ? 1 : a < 0.8 ? 2 : 3; }
function novaRev(disc, topic, studyDate, days, extra) {
  const revDate = addDays(studyDate, days), p = CONCURSO_INFO.dataProva;
  if (p && revDate >= p) return null;
  const r = Object.assign({ id: Date.now() + Math.random(), disc, topic, studyDate, revDate, days, done: false, res: '' }, extra || {});
  revisoes.push(r); return r;
}
function agendarCadeia(disc, topic, ac, er, date) {
  const modo = store.cfg.revModo, cad = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  return novaRev(disc, topic, date, modo === '1-7-30' ? REV_STEPS[0] : primeiroInt(ac, er), { cad, passo: 0, ease: 2.3, modo });
}
function proximoInt(r, res) {
  if (r.modo === '1-7-30') { const s = REV_STEPS[(r.passo || 0) + 1]; return s ? { next: s, ease: r.ease || 2.3 } : null; }
  let ease = r.ease || 2.3; const d = r.days || 1; let next;
  if (res === 'bom') { next = Math.max(d + 1, Math.round(d * ease)); ease = Math.min(3, ease + 0.1); }
  else if (res === 'dificil') { next = Math.max(d + 1, Math.round(d * 1.3)); ease = Math.max(1.3, ease - 0.15); }
  else { next = 1; ease = Math.max(1.3, ease - 0.3); }
  return { next: Math.min(next, 120), ease };
}
function toggleRevDone(id) {
  const r = revisoes.find(x => String(x.id) === String(id)); if (!r) return;
  if (r.done) { r.done = false; r.res = ''; renderRevisoes(); renderHoje(); debouncedSave(); return; }
  revAvaliar(id);
}
function revAvaliar(id) {
  const r = revisoes.find(x => String(x.id) === String(id)); if (!r) return;
  document.getElementById('rev-modal-t').textContent = (r.topic || r.disc) + (r.topic ? ' · ' + r.disc : '');
  document.getElementById('rev-modal').dataset.id = String(id); document.getElementById('rev-modal').classList.add('open');
}
function closeRevModal() { document.getElementById('rev-modal').classList.remove('open'); }
function revResp(id, res) {
  closeRevModal();
  const r = revisoes.find(x => String(x.id) === String(id)); if (!r) return;
  const tk = todayKey(); r.done = true; r.res = res || ''; r.doneDate = tk;
  let msg = 'Revisão registrada!';
  if (res) {
    const temFutura = revisoes.some(x => !x.done && x.id !== r.id && x.disc === r.disc && x.topic === r.topic && x.revDate > tk);
    let seg = null;
    if (r.cad) seg = proximoInt(r, res);
    else if (store.cfg.revModo === 'adaptativo' && (!temFutura || res === 'esqueci')) { r.cad = 'c' + Date.now().toString(36); r.passo = 0; r.ease = 2.3; r.modo = 'adaptativo'; seg = proximoInt(r, res); }
    if (seg && (res === 'esqueci' || !temFutura || r.cad)) {
      const nr = novaRev(r.disc, r.topic, tk, seg.next, { cad: r.cad, passo: (r.passo || 0) + 1, ease: seg.ease, modo: r.modo || store.cfg.revModo });
      msg += nr ? ' Próxima em ' + seg.next + ' dia(s) (' + fmtBR(nr.revDate).slice(0, 5) + ').' : ' Ciclo encerrado antes da prova.';
    }
  }
  renderRevisoes(); renderHoje(); persist(); showToast('🔁', msg);
}

// ── caderno de erros (banca, concurso, resposta correta, tentativas) ──
function seqDias(e) { const ds = {}; for (let i = (e.tent || []).length - 1; i >= 0; i--) { if (!e.tent[i].ok) break; ds[e.tent[i].d] = 1; } return Object.keys(ds).length; }
function addErro() {
  const disc = vv('er-disc'), topic = vv('er-topic').trim(), texto = vv('er-texto').trim(), regra = vv('er-regra').trim(), resp = vv('er-resp').trim();
  if (!texto && !regra && !resp) { showToast('⚠️', 'Escreva o que errou, a resposta correta ou a regra.'); return; }
  erros.push({ id: Date.now() + Math.random(), date: vv('er-data') || todayKey(), disc, topic, banca: vv('er-banca').trim(), conc: vv('er-conc').trim(), concId: curId, motivo: vv('er-motivo'), texto, resp, regra, ok: 0, dominado: false, ult: '', tent: [] });
  ['er-topic', 'er-texto', 'er-regra', 'er-resp', 'er-conc'].forEach(id => document.getElementById(id).value = '');
  persist(); renderErros(); renderHoje(); showToast('📕', 'Erro registrado no caderno!');
}
function respTreino(acertou) {
  const e = erros.find(x => x.id === erroAtual); if (!e) return;
  const tk = todayKey(); e.tent = e.tent || []; e.ult = tk; e.tent.push({ d: tk, ok: !!acertou });
  e.ok = acertou ? seqDias(e) : 0;
  if (acertou && e.ok >= 2) { e.dominado = true; showToast('🏆', 'Erro dominado: 2 acertos em dias diferentes!'); }
  erroAtual = null; erroRevelado = false; persist(); renderErros(); renderHoje();
}
function renderTreino() {
  const el = document.getElementById('er-treino');
  const e = erros.find(x => x.id === erroAtual && !x.dominado) || escolherErro();
  if (!e) { erroAtual = null; el.innerHTML = '<div style="font-size:12px;color:var(--text-soft)">' + (erros.length ? '🎉 Todos os erros dominados! Continue registrando novos.' : 'Registre erros para treinar aqui.') + '</div>'; return; }
  erroAtual = e.id; const hist = (e.tent || []).map(t => t.ok ? '✓' : '✗').join(' ');
  el.innerHTML = `<div class="treino"><div style="font-size:11px;color:var(--text-soft);font-weight:700">${escOpt(e.disc || '')}${e.topic ? ' · ' + escOpt(e.topic) : ''} · ${escOpt(e.motivo)} · acertos em dias diferentes: ${seqDias(e)}/2${hist ? ' · tentativas: <span class="tent">' + hist + '</span>' : ''}</div>
    <div class="q">${escOpt(e.texto || '(sem descrição)')}</div>
    ${erroRevelado ? `<div class="r">${e.resp ? '<b>Resposta correta:</b> ' + escOpt(e.resp) + '\n' : ''}${escOpt(e.regra || (e.resp ? '' : 'Sem regra anotada.'))}</div><div style="display:flex;gap:8px"><button class="mini-btn ok" onclick="respTreino(true)">✅ Acertei</button><button class="mini-btn no" onclick="respTreino(false)">❌ Ainda erro</button></div>` : '<button class="mini-btn pri" style="align-self:flex-start" onclick="erroRevelado=true;renderTreino()">Mostrar resposta</button>'}
  </div>`;
}
function renderErros() {
  if (!document.getElementById('er-kpis')) return;
  const sel = document.getElementById('er-disc'), fd = document.getElementById('er-f-disc'), mo = document.getElementById('er-motivo'), fb = document.getElementById('er-f-banca'), fm = document.getElementById('er-f-motivo');
  const v1 = sel.value, v2 = fd.value, v3 = fb.value, v4 = fm.value;
  const optD = EDITAL.map(d => `<option value="${escOpt(d.nome)}">${escOpt(d.nome)}</option>`).join('');
  sel.innerHTML = '<option value="">— matéria —</option>' + optD; fd.innerHTML = '<option value="">Todas as matérias</option>' + optD;
  const bancas = Array.from(new Set(erros.map(e => e.banca).filter(Boolean)));
  fb.innerHTML = '<option value="">Todas as bancas</option>' + bancas.map(b => `<option value="${escOpt(b)}">${escOpt(b)}</option>`).join('');
  fm.innerHTML = '<option value="">Todos os motivos</option>' + MOTIVOS.map(m => `<option>${m}</option>`).join('');
  sel.value = v1; fd.value = v2; fb.value = v3; fm.value = v4;
  if (!mo.options.length) mo.innerHTML = MOTIVOS.map(m => `<option>${m}</option>`).join('');
  const eb = document.getElementById('er-banca'), ec = document.getElementById('er-conc'), ed = document.getElementById('er-data');
  if (!eb.value) eb.value = CONCURSO_INFO.banca || ''; if (!ec.value) ec.value = CONCURSO_INFO.concurso || ''; if (!ed.value) ed.value = todayKey();
  const pend = erros.filter(e => !e.dominado), dom = erros.length - pend.length, cont = {};
  erros.forEach(e => cont[e.motivo] = (cont[e.motivo] || 0) + 1);
  const top = Object.keys(cont).sort((a, b) => cont[b] - cont[a])[0];
  document.getElementById('er-kpis').innerHTML =
    `<div class="kpi"><div class="v">${erros.length}</div><div class="t">Erros no caderno</div></div>
     <div class="kpi"><div class="v">${pend.length}</div><div class="t">A dominar</div></div>
     <div class="kpi"><div class="v">${dom}</div><div class="t">Já dominados</div><div class="s">${erros.length ? Math.round(dom / erros.length * 100) + '% do caderno' : ''}</div></div>
     <div class="kpi"><div class="v" style="font-size:15px">${top ? escOpt(top) : '—'}</div><div class="t">Maior causa de erro</div></div>`;
  const mx = Math.max(1, ...Object.values(cont));
  document.getElementById('er-motivos').innerHTML = erros.length ? MOTIVOS.filter(m => cont[m]).sort((a, b) => cont[b] - cont[a]).map(m => `<div><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--navy);font-weight:700"><span>${m}</span><span>${cont[m]}</span></div><div class="bar" style="margin-top:4px"><i style="width:${cont[m] / mx * 100}%"></i></div></div>`).join('') : '<div style="font-size:12px;color:var(--text-soft)">Registre seus erros para descobrir o padrão.</div>';
  renderTreino();
  const fst = document.getElementById('er-f-st').value;
  const lista = erros.filter(e => (!v2 || e.disc === v2) && (!v3 || e.banca === v3) && (!v4 || e.motivo === v4) && (!fst || (fst === 'p' ? !e.dominado : e.dominado))).slice().reverse();
  document.getElementById('er-list').innerHTML = lista.length ? lista.map(e => {
    const tent = (e.tent || []).map(t => `<span title="${fmtBR(t.d)}">${t.ok ? '✓' : '✗'}</span>`).join(' ');
    return `<div class="row-i" style="align-items:flex-start"><div class="main"><div class="nm" style="white-space:normal">${escOpt(e.topic || e.disc || 'Sem assunto')} ${e.dominado ? '<span class="chip grn">dominado</span>' : '<span class="chip yel">a dominar</span>'}</div>
      <div class="sb">${escOpt(e.disc || '')} · ${escOpt(e.motivo)} · ${fmtBR(e.date)}${e.banca ? ' · ' + escOpt(e.banca) : ''}${e.conc ? ' · ' + escOpt(e.conc) : ''}</div>
      ${e.texto ? `<div style="font-size:12px;color:var(--text-mid);margin-top:4px;white-space:pre-line">${escOpt(e.texto)}</div>` : ''}
      ${e.resp ? `<div style="font-size:12px;color:#166534;margin-top:4px">✔ Resposta correta: <b>${escOpt(e.resp)}</b></div>` : ''}
      ${e.regra ? `<div style="font-size:12px;color:#166534;margin-top:4px;white-space:pre-line">💡 ${escOpt(e.regra)}</div>` : ''}
      ${tent ? `<div class="tent" style="margin-top:4px;color:var(--text-mid)">Tentativas: ${tent}</div>` : ''}</div>
      <div style="display:flex;flex-direction:column;gap:6px"><button class="mini-btn" onclick="toggleDominado(${e.id})">${e.dominado ? 'Reabrir' : '✓ Dominei'}</button><button class="mini-btn no" onclick="delErro(${e.id})">🗑</button></div></div>`;
  }).join('') : '<div style="font-size:12px;color:var(--text-soft)">Nenhum erro por aqui.</div>';
}

// ── domínio de cada assunto (por evidência, não só "concluído") ──
function sameTopic(a, b) { const x = normS(a), y = normS(b); return !!x && !!y && (x === y || x.indexOf(y) > -1 || y.indexOf(x) > -1); }
function topicQ(d, tid, label) {
  const ts = getTS(tid); let ac = ts.acertos || 0, er = ts.erros || 0;
  historico.forEach(r => { if (r.origem === 'cronômetro' && r.disc === d.nome && r.topic && sameTopic(r.topic, label)) { ac += r.acertos || 0; er += r.erros || 0; } });
  return { ac, er, n: ac + er };
}
function masteryInfo(d, tid, label) {
  const ts = getTS(tid), q = topicQ(d, tid, label), a = q.n >= 8 ? q.ac / q.n : null, tk = todayKey();
  const pend = erros.filter(e => !e.dominado && e.disc === d.nome && e.topic && sameTopic(e.topic, label)).length;
  const revs = revisoes.filter(r => r.disc === d.nome && r.topic && sameTopic(r.topic, label));
  const bons = revs.filter(r => r.done && r.res === 'bom'), esq = revs.filter(r => r.done && r.res === 'esqueci').length;
  const atras = revs.some(r => !r.done && r.revDate < tk);
  const sess = historico.some(r => r.disc === d.nome && r.topic && sameTopic(r.topic, label));
  let nivel, v;
  if (!ts.done && q.n === 0 && !sess) { nivel = 'nao'; v = 0; }
  else if (q.n < 8) { nivel = ts.done ? 'sempratica' : 'iniciado'; v = ts.done ? 0.25 : 0.15; }
  else if (a < 0.6 || pend > 0 || atras) { nivel = 'aprendendo'; v = Math.max(0.2, Math.min(0.55, a)); }
  else if (ts.done && q.n >= 15 && a >= 0.8 && esq === 0 && (bons.some(r => (r.days || 0) >= 7) || bons.length >= 2)) { nivel = 'dominado'; v = 1; }
  else { nivel = 'consolidando'; v = 0.55 + 0.25 * Math.max(0, Math.min(1, (a - 0.6) / 0.2)); }
  return { nivel, v, a, n: q.n, pend, bons: bons.length, atras };
}
function domBadge(d, tid, label) {
  const m = masteryInfo(d, tid, label), pc = m.a !== null ? Math.round(m.a * 100) + '%' : '';
  const T = {
    iniciado: ['🌱 iniciado', '', 'Estudo iniciado: faça questões para medir o domínio.'],
    sempratica: ['⚠️ sem prática', 'y', 'Marcado como concluído, mas com menos de 8 questões: ainda não dá para dizer que domina.'],
    aprendendo: ['🔴 aprendendo ' + pc, 'r', 'Acerto abaixo de 60%, erro pendente ou revisão atrasada.'],
    consolidando: ['🟡 consolidando ' + pc, 'y', 'Bom desempenho, falta confirmar com revisões espaçadas.'],
    dominado: ['🟢 dominado ' + pc, 'g', 'Concluído, 15 ou mais questões com 80% ou mais, sem erro pendente e com revisão bem lembrada.']
  };
  const t = T[m.nivel]; if (!t) return '';
  return `<span class="dom-b ${t[1]}" title="${t[2]} (${m.n} questões)">${t[0]}</span>`;
}

// ── recomendação diária ──
function incInfo(d, label) {
  const r = plano.rx; let com = 0, sem = 0, fontes = {};
  if (!r || !r.provas) return { com, sem, fontes: [] };
  const dn = normS(d.nome), tn = normS(label);
  r.provas.forEach(p => {
    if (normS(p.disc) !== dn) return; const pn = normS(p.topic); if (!pn) return;
    const pw = pn.split(/\s+/).filter(w => w.length >= 4);
    if (tn.indexOf(pn) > -1 || pn.indexOf(tn) > -1 || (pw.length && pw.filter(w => tn.indexOf(w) > -1).length / pw.length >= 0.6)) { if (p.fonte) { com += p.qtd || 0; fontes[p.fonte] = 1; } else sem += p.qtd || 0; }
  });
  return { com, sem, fontes: Object.keys(fontes) };
}
function recomendar() {
  const tk = todayKey(), L = [], dLeft = daysTo(CONCURSO_INFO.dataProva);
  revisoes.filter(r => !r.done && r.revDate <= tk).forEach(r => {
    const at = Math.round((new Date(tk + 'T00:00:00') - new Date(r.revDate + 'T00:00:00')) / 86400000);
    L.push({ tipo: 'rev', id: r.id, score: at > 0 ? 100 + Math.min(at, 30) * 2 : 85, titulo: 'Revisar: ' + (r.topic || r.disc), sub: r.disc, motivos: [at > 0 ? 'Revisão atrasada há ' + at + ' dia(s)' : 'Revisão agendada para hoje', 'No dia certo, a revisão custa menos tempo'] });
  });
  const ep = erros.filter(e => !e.dominado && e.ult !== tk);
  if (ep.length) L.push({ tipo: 'err', score: 60 + Math.min(20, ep.length * 2), titulo: 'Treino de erros (' + ep.length + ' pendente' + (ep.length > 1 ? 's' : '') + ')', sub: 'Caderno de erros', motivos: ['Erro não dominado tende a se repetir na prova', 'Treino rápido de 5 a 10 minutos'] });
  EDITAL.forEach((d, i) => {
    const p = discProg(d, state), progD = p.t ? p.c / p.t : 0; let best = null;
    d.grupos.forEach(g => g.topicos.forEach((t, ti) => {
      const tid = d.id + '_' + slug(g.nome) + '_' + ti, m = masteryInfo(d, tid, t); if (m.nivel === 'dominado') return;
      const inc = incInfo(d, t), incEf = inc.com + inc.sem * 0.5;
      let gap = 1 - m.v; if (m.nivel === 'nao' && dLeft !== null && dLeft > 0 && dLeft < 30) gap *= 0.75;
      const wImp = (d.peso || 3) / 5, boost = 1 + Math.min(0.5, incEf / 8), wProg = 1 + (1 - progD) * 0.4;
      const wProva = dLeft !== null && dLeft > 0 ? 1 + Math.min(1, 30 / dLeft) * 0.5 : 1;
      const score = 28 * wImp * boost * gap * wProg * wProva;
      if (!best || score > best.score) best = { tipo: 'top', i, tid, label: t, score, m, inc, progD, d, dLeft };
    }));
    if (best) {
      const m = best.m, mot = ['Prioridade ' + '★'.repeat(d.peso || 3) + ' da matéria'];
      if (m.nivel === 'nao') mot.push('Ainda não estudado'); else if (m.nivel === 'sempratica') mot.push('Concluído, mas só ' + m.n + ' questão(ões): falta prática'); else if (m.a !== null) mot.push('Aproveitamento de ' + Math.round(m.a * 100) + '% em ' + m.n + ' questões');
      if (m.pend) mot.push(m.pend + ' erro(s) pendente(s) neste assunto');
      mot.push('Matéria ' + Math.round(best.progD * 100) + '% concluída');
      if (best.dLeft !== null && best.dLeft > 0) mot.push('Prova em ' + best.dLeft + ' dias');
      if (best.inc.com) mot.push('Apareceu ' + best.inc.com + 'x em provas registradas (fonte: ' + best.inc.fontes.slice(0, 2).join('; ') + ')');
      else if (best.inc.sem) mot.push('Registrado ' + best.inc.sem + 'x nas provas (estimativa, sem fonte)');
      L.push({ tipo: 'top', i: best.i, label: best.label, score: best.score, titulo: best.label, sub: d.nome, motivos: mot });
    }
  });
  const sims = simulados.slice().sort((a, b) => a.date < b.date ? -1 : 1), ult = sims.length ? sims[sims.length - 1].date : null;
  const diasUlt = ult ? Math.round((new Date(tk + 'T00:00:00') - new Date(ult + 'T00:00:00')) / 86400000) : null;
  if (dLeft !== null && dLeft > 0 && dLeft <= 60 && (diasUlt === null || diasUlt >= 14)) L.push({ tipo: 'sim', score: 50 + (diasUlt === null ? 2 : Math.min(8, Math.floor(diasUlt / 7))), titulo: 'Fazer um simulado', sub: 'Simulados', motivos: ['Prova em ' + dLeft + ' dias', diasUlt === null ? 'Você ainda não registrou simulado' : 'Último simulado há ' + diasUlt + ' dias'] });
  return L.sort((a, b) => b.score - a.score);
}
function recoGo(k) {
  const it = (window._reco || [])[k]; if (!it) return;
  if (it.tipo === 'rev') revAvaliar(it.id);
  else if (it.tipo === 'top') { startStudy(it.i); const ts = document.getElementById('crono-topic'); if (ts && it.label) ts.value = it.label; }
  else if (it.tipo === 'err') switchTab('erros'); else switchTab('simulados');
}
function renderReco() {
  const el = document.getElementById('hj-reco'); if (!el) return;
  const L = window._reco = recomendar();
  if (!L.length) { el.innerHTML = '<div class="rx-note">Cadastre matérias e registre estudos para receber recomendações.</div>'; return; }
  const lab = it => it.tipo === 'rev' ? '✓ Já revisei' : it.tipo === 'top' ? '▶ Estudar agora' : it.tipo === 'err' ? 'Abrir treino' : 'Registrar simulado';
  const t = L[0];
  el.innerHTML = `<div class="reco-top"><div class="reco-t">${escOpt(t.titulo)}</div><div class="reco-s">${escOpt(t.sub || '')}</div><div class="reco-m">${t.motivos.map(m => '<span class="chip">' + escOpt(m) + '</span>').join('')}</div><button class="mini-btn pri" style="align-self:flex-start;padding:10px 16px;font-size:13px" onclick="recoGo(0)">${lab(t)}</button></div>` +
    (L.length > 1 ? '<div class="rx-note" style="margin-top:6px">Depois, nesta ordem:</div>' + L.slice(1, 5).map((it, k) => `<div class="row-i"><div class="main"><div class="nm">${escOpt(it.titulo)}</div><div class="sb">${escOpt(it.sub || '')} · ${escOpt(it.motivos[0])}</div></div><button class="mini-btn" onclick="recoGo(${k + 1})">${lab(it)}</button></div>`).join('') : '') +
    '<div class="rx-note" style="margin-top:6px">Ordem calculada por: revisões vencidas, erros pendentes, prioridade do assunto, seu desempenho, progresso do edital e proximidade da prova.</div>';
}
// ══ ETAPA A: esquema v3, pontos de restauração e backup confiável ══
const SCHEMA = 3, SNAP_KEY = 'rumo-posse-snap-v1', APP_VER = '2026.10-v4-idb';
function stable(o) {
  if (o === null || typeof o !== 'object') return o === undefined ? 'null' : JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
}
function hashStr(s) { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x.toString(16).padStart(8, '0') + '-' + s.length.toString(16); }
function resumoStore(s) {
  const r = { concursos: 0, sessoes: 0, horas: 0, questoes: 0, revisoes: 0, erros: 0, simulados: 0 };
  if (!s || !s.concursos) return r;
  Object.keys(s.concursos).forEach(id => {
    const d = s.concursos[id].data || {}; r.concursos++;
    (d.historico || []).forEach(x => { r.sessoes++; r.horas += x.horas || 0; r.questoes += x.questoes || 0; });
    r.revisoes += (d.revisoes || []).length; r.erros += (d.erros || []).length; r.simulados += (d.simulados || []).length;
  });
  r.horas = Math.round(r.horas * 100) / 100; return r;
}
function resumoTxt(r) { return r.concursos + ' concurso(s), ' + r.sessoes + ' sessões (' + r.horas + ' h), ' + r.questoes + ' questões, ' + r.revisoes + ' revisões, ' + r.erros + ' erros no caderno, ' + r.simulados + ' simulados'; }

// pontos de restauração (cópias de segurança no próprio aparelho)
function snapListLegacy() { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { return []; } }
function snapList() { return window.Armazenamento ? Armazenamento.snapshots() : snapListLegacy(); }
function snapshot(motivo) {
  try { commitCurrent(); } catch (e) {}
  if (window.Armazenamento) return Armazenamento.guardarSnapshot({ t: Date.now(), motivo, data: JSON.stringify(store) });
  let l = snapListLegacy(); l.unshift({ t: Date.now(), motivo, data: JSON.stringify(store) }); l = l.slice(0, 3);
  for (let k = 0; k < 4; k++) { try { localStorage.setItem(SNAP_KEY, JSON.stringify(l)); return true; } catch (e) { if (l.length <= 1) return false; l.pop(); } }
  return false;
}
function snapAuto() { const l = snapList(), hoje = new Date().toISOString().slice(0, 10); if (!l.length || new Date(l[0].t).toISOString().slice(0, 10) !== hoje) snapshot('automático (diário)'); }
async function snapRestore(i) {
  const rec = snapList()[i]; if (!rec) return;
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes.'); return; }
  if (!(await askConfirm('Voltar para a cópia de ' + new Date(rec.t).toLocaleString('pt-BR') + ' (' + rec.motivo + ')? O estado atual também será guardado como ponto de restauração.', 'Restaurar'))) return;
  const data = rec.data; snapshot('antes de restaurar ponto');
  store = JSON.parse(data); migrateStore();
  if (!store.concursos[store.active]) store.active = Object.keys(store.concursos)[0];
  loadConcurso(store.active); persist(); refreshAll(); closeBackupModal(); showToast('🕒', 'Ponto de restauração aplicado!');
}

// migração de esquema (idempotente, sem apagar nada)
function migrateStore() {
  const primeira = !store.schema || store.schema < SCHEMA;
  if (primeira && Object.keys(store.concursos).length) snapshot('antes da migração para o esquema v' + SCHEMA);
  Object.keys(store.concursos).forEach(id => {
    const c = store.concursos[id]; c.data = c.data || {}; const d = c.data, inf = c.info || {};
    d.state = d.state || {}; d.historico = d.historico || []; d.revisoes = d.revisoes || []; d.simulados = d.simulados || [];
    d.erros = d.erros || []; d.plano = d.plano || {}; d.metas = d.metas || {};
    d.erros.forEach(e => {
      if (!Array.isArray(e.tent)) e.tent = [];
      if (e.banca === undefined) e.banca = inf.banca || '';
      if (e.conc === undefined) e.conc = inf.concurso || '';
      if (e.resp === undefined) e.resp = '';
    });
    d.revisoes.forEach(r => { if (r.res === undefined) r.res = ''; });
    if (d.plano.rx && d.plano.rx.provas) d.plano.rx.provas.forEach(p => { if (p.fonte === undefined) p.fonte = ''; });
  });
  store.cfg = Object.assign({ revModo: 'adaptativo' }, store.cfg || {});
  store.kb = store.kb || { v: 1, link: {}, prog: {} };
  store.v = SCHEMA; store.schema = SCHEMA;
}

// verificação de integridade
async function verificarDados() {
  commitCurrent(); const msgs = [];
  Object.keys(store.concursos).forEach(id => {
    const c = store.concursos[id], d = c.data, nome = c.info.concurso || id;
    const tids = {}; (c.edital || []).forEach(m => m.grupos.forEach(g => g.topicos.forEach((t, i) => { tids[m.id + '_' + slug(g.nome) + '_' + i] = 1; })));
    const orf = Object.keys(d.state).filter(k => !tids[k] && !(d.state[k] && d.state[k].done === false && !d.state[k].questoes)).length;
    const nomes = {}; (c.edital || []).forEach(m => nomes[normS(m.nome)] = 1);
    const sessOrf = d.historico.filter(r => r.disc && !nomes[normS(r.disc)]).length;
    const ids = {}; let dup = 0; [].concat(d.historico, d.revisoes, d.erros, d.simulados).forEach(x => { const k = String(x.id); if (ids[k]) dup++; ids[k] = 1; });
    if (orf || sessOrf || dup) msgs.push(nome + ': ' + [orf ? orf + ' progresso(s) sem tópico no edital' : '', sessOrf ? sessOrf + ' sessão(ões) de matéria que não está mais no edital' : '', dup ? dup + ' id(s) repetido(s)' : ''].filter(Boolean).join('; '));
  });
  await askConfirm(msgs.length ? 'Pontos de atenção (nada foi apagado):\n\n' + msgs.join('\n') : '✅ Tudo certo: ' + resumoTxt(resumoStore(store)) + '.', 'OK');
}

// ── exportação ──
function envelope(kind, payload) {
  const base = payload.store || { concursos: { x: payload.concurso } };
  return { app: 'rumo-a-posse', kind, schema: SCHEMA, appVersion: APP_VER, exportedAt: new Date().toISOString(), resumo: resumoStore(base), checksum: hashStr(stable(payload)), payload };
}
function dataArq() { return new Date().toLocaleDateString('pt-BR').replace(/\//g, '-'); }
function openBackupModal() {
  const l = snapList();
  document.getElementById('snap-list').innerHTML = l.length ? l.map((s, i) => `<div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--navy)"><span style="flex:1">${new Date(s.t).toLocaleString('pt-BR')}<br><span style="color:var(--text-soft)">${escOpt(s.motivo)}</span></span><button class="mini-btn" onclick="snapRestore(${i})">Restaurar</button></div>`).join('') : '<div style="font-size:12px;color:var(--text-soft)">Nenhum ponto ainda.</div>';
  try { renderArmazenamento(true); } catch (e) {}
  document.getElementById('backup-modal').classList.add('open');
}
function closeBackupModal(e) {
  if (!e || e.target === document.getElementById('backup-modal')) document.getElementById('backup-modal').classList.remove('open');
}
function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 2000);
  store.lastBackup = Date.now(); try { persist(); } catch (e) {}
  document.getElementById('backup-modal').classList.remove('open');
  showToast('✅', 'Backup exportado com sucesso!');
}
function exportBackup() {
  try {
    commitCurrent(); const c = store.concursos[curId];
    downloadJson(envelope('concurso', { concurso: clone(c) }), 'backup-rumo-posse-' + slugId(c.info.concurso) + '-' + dataArq() + '.json');
  } catch (e) { showToast('⚠️', 'Erro ao exportar: ' + e.message); }
}
function exportBackupAll() {
  try { commitCurrent(); store.lastBackup = Date.now(); downloadJson(envelope('todos', { store: clone(store) }), 'backup-rumo-posse-TODOS-' + dataArq() + '.json'); }
  catch (e) { showToast('⚠️', 'Erro ao exportar: ' + e.message); }
}
async function shareBackup() {
  try {
    commitCurrent(); store.lastBackup = Date.now(); persist();
    const file = new File([JSON.stringify(envelope('todos', { store: clone(store) }), null, 2)], 'backup-rumo-posse.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Backup Rumo à Posse' }); closeBackupModal(); showToast('✅', 'Backup compartilhado!'); }
    else exportBackupAll();
  } catch (e) { if (e && e.name !== 'AbortError') showToast('⚠️', 'Não consegui compartilhar. Use Exportar.'); }
}
function triggerImport() { document.getElementById('backup-modal').classList.remove('open'); document.getElementById('import-file').click(); }

// ── importação: validar, mostrar prévia, mesclar ou substituir ──
let _imp = null;
function parseBackup(j) {
  if (j && j.app === 'rumo-a-posse' && j.payload) {
    const ok = hashStr(stable(j.payload)) === j.checksum;
    if (j.payload.store && j.payload.store.concursos) return { kind: 'todos', store: j.payload.store, ok, schema: j.schema };
    if (j.payload.concurso) return { kind: 'concurso', concurso: j.payload.concurso, ok, schema: j.schema };
  }
  if (j && j.store && j.store.concursos) return { kind: 'todos', store: j.store, ok: null, schema: 2 };
  if (j && (j.state || j.historico)) {
    return { kind: 'legado', ok: null, schema: 1, concurso: { id: curId, info: j.info || null, edital: Array.isArray(j.edital) ? j.edital : null,
      data: { state: j.state || {}, historico: j.historico || [], revisoes: j.revisoes || [], simulados: j.simulados || [], erros: j.erros || [], plano: j.plano || {}, metas: {} } } };
  }
  throw new Error('formato não reconhecido');
}
function importBackup(input) {
  const f = input.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try { _imp = parseBackup(JSON.parse(rd.result)); } catch (e) { showToast('⚠️', 'Arquivo inválido: ' + (e.message || '')); input.value = ''; return; }
    input.value = ''; impPreview();
  };
  rd.readAsText(f);
}
function impPreview() {
  const i = _imp, base = i.kind === 'todos' ? i.store : { concursos: { x: i.concurso } };
  const aviso = i.ok === false ? '<div style="color:var(--red);font-weight:800;margin-bottom:6px">⚠️ O arquivo não confere com o checksum: pode ter sido alterado ou corrompido. Restaure só se confiar nele.</div>' : (i.ok === true ? '<div style="color:#15803d;font-weight:700;margin-bottom:6px">✅ Integridade do arquivo confirmada.</div>' : '<div style="margin-bottom:6px;color:var(--text-soft)">Formato antigo (sem checksum).</div>');
  const nomes = i.kind === 'todos' ? Object.keys(i.store.concursos).map(id => i.store.concursos[id].info.concurso).join(', ') : ((i.concurso.info && i.concurso.info.concurso) || 'dados do concurso atual');
  document.getElementById('imp2-body').innerHTML = aviso + '<b>Conteúdo:</b> ' + escOpt(resumoTxt(resumoStore(base))) + '.<br><b>Concursos:</b> ' + escOpt(nomes) + '.<br><b>Seu app agora:</b> ' + escOpt(resumoTxt(resumoStore((commitCurrent(), store)))) + '.';
  const modos = i.kind === 'todos'
    ? [['mesclar', 'Mesclar com o que já existe (recomendado: não apaga nem duplica)'], ['substituir', 'Substituir TUDO pelo conteúdo do arquivo']]
    : i.kind === 'concurso'
      ? [['mesclar', 'Mesclar neste app (cria o concurso se não existir)'], ['substituir', 'Substituir esse concurso pelo do arquivo']]
      : [['mesclar', 'Mesclar no concurso atual (recomendado)'], ['substituir', 'Substituir os dados do concurso atual']];
  document.getElementById('imp2-modos').innerHTML = modos.map((m, k) => `<label><input type="radio" name="imp2m" value="${m[0]}" ${k === 0 ? 'checked' : ''}> ${m[1]}</label>`).join('');
  document.getElementById('imp2-modal').classList.add('open');
}
function mergeById(dst, src) { const seen = {}; dst.forEach(x => seen[String(x.id)] = 1); src.forEach(x => { if (!seen[String(x.id)]) { dst.push(x); seen[String(x.id)] = 1; } }); return dst; }
function mergeState(dst, src) {
  Object.keys(src || {}).forEach(k => {
    const a = dst[k], b = src[k];
    if (!a) { dst[k] = clone(b); return; }
    const pick = ((b.questoes || 0) > (a.questoes || 0)) ? b : a, r = Object.assign({}, pick);
    r.done = !!(a.done || b.done); r.datetime = a.datetime || b.datetime || null; dst[k] = r;
  });
}
function mergeConc(dst, src) {
  src = clone(src);
  if (!dst.info || !dst.info.concurso) dst.info = src.info || dst.info;
  if ((!dst.edital || !dst.edital.length) && src.edital) dst.edital = src.edital;
  const d = dst.data, s = src.data || {};
  mergeState(d.state, s.state);
  ['historico', 'revisoes', 'simulados'].forEach(k => mergeById(d[k], s[k] || []));
  (s.erros || []).forEach(e => { const x = d.erros.find(y => String(y.id) === String(e.id)); if (!x) d.erros.push(e); else if ((e.tent || []).length > (x.tent || []).length) Object.assign(x, e); });
  const sp = s.plano || {}, dp = d.plano;
  if (sp.cron && !dp.cron) dp.cron = sp.cron;
  if (sp.rx) { if (!dp.rx) dp.rx = sp.rx; else mergeById(dp.rx.provas = dp.rx.provas || [], sp.rx.provas || []); }
  if (sp.trein && !dp.trein) dp.trein = sp.trein;
  ['metaDia', 'horasSemana'].forEach(k => { if (dp[k] === undefined && sp[k] !== undefined) dp[k] = sp[k]; });
}
function importApply() {
  const i = _imp; if (!i) return;
  if (cronoBusy()) { showToast('⏱', 'Pare e registre o cronômetro antes.'); return; }
  const modo = (document.querySelector('input[name="imp2m"]:checked') || {}).value || 'mesclar';
  snapshot('antes de importar backup');
  const antes = resumoStore(store);
  try {
    if (i.kind === 'todos') {
      if (modo === 'substituir') { store = clone(i.store); migrateStore(); }
      else {
        const s = clone(i.store); migrateStore();
        Object.keys(s.concursos).forEach(id => { if (!store.concursos[id]) store.concursos[id] = s.concursos[id]; else mergeConc(store.concursos[id], s.concursos[id]); });
        const kb = s.kb || { link: {}, prog: {} };
        Object.keys(kb.link || {}).forEach(k => { if (!store.kb.link[k]) store.kb.link[k] = kb.link[k]; });
        mergeState(store.kb.prog, kb.prog);
      }
    } else if (i.kind === 'concurso') {
      const c = clone(i.concurso), id = c.id || slugId(c.info.concurso);
      if (modo === 'substituir' || !store.concursos[id]) store.concursos[id] = c; else mergeConc(store.concursos[id], c);
      store.concursos[id].id = id;
    } else {
      commitCurrent(); const c = store.concursos[curId];
      if (modo === 'substituir') { c.data = clone(i.concurso.data); if (i.concurso.edital) c.edital = i.concurso.edital; }
      else mergeConc(c, i.concurso);
    }
    migrateStore();
    if (!store.concursos[curId]) curId = store.active = Object.keys(store.concursos)[0];
    loadConcurso(curId); persist(); refreshAll();
  } catch (e) { showToast('⚠️', 'Falha ao restaurar: ' + e.message + '. Use um ponto de restauração.'); return; }
  document.getElementById('imp2-modal').classList.remove('open'); _imp = null;
  const dep = resumoStore(store);
  showToast('✅', 'Restaurado: +' + (dep.sessoes - antes.sessoes) + ' sessões, +' + (dep.erros - antes.erros) + ' erros, +' + (dep.simulados - antes.simulados) + ' simulados.');
}

function showToast(icon,msg){document.getElementById('ti').textContent=icon;document.getElementById('tm').textContent=msg;const t=document.getElementById('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2400);}

// ── UTILS ────────────────────────────────────────────────
function slug(s){return s.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-');}
function fmtDt(d){return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
function pc(pct,tot){if(!tot||tot===0)return'n';if(pct>=70)return'g';if(pct>=50)return'y';return'r';}
function secsToHMS(s){const h=Math.floor(s/3600).toString().padStart(2,'0'),m=Math.floor((s%3600)/60).toString().padStart(2,'0'),ss=(s%60).toString().padStart(2,'0');return`${h}:${m}:${ss}`;}
function horasLabel(h){const hh=Math.floor(h),mm=Math.round((h-hh)*60);return`${hh}h ${mm.toString().padStart(2,'0')}min`;}
function dateToKey(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function todayKey(){return dateToKey(new Date());}

// ── REVISÕES ───────────────────────────────────────────
function toggleRevBtn(btn, days) {
  btn.classList.toggle('done'); updateRevSelected();
}
function clearRevBtns() {
  document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('done')); updateRevSelected();
}
function getSelectedRevDays() {
  const days = [];
  document.querySelectorAll('[data-days].done').forEach(b => days.push(parseInt(b.dataset.days)));
  const custom = parseInt(document.getElementById('crono-rev-custom').value);
  if (custom > 0) days.push(custom);
  return [...new Set(days)].sort((a,b)=>a-b);
}
function updateRevSelected() {
  const days = getSelectedRevDays();
  const el = document.getElementById('crono-rev-selected'); if (!el) return;
  el.textContent = days.length ? 'Revisão em: ' + days.map(d=>d+'d').join(', ') : '';
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return dateToKey(d);
}
function renderRevisoes() {
  const el = document.getElementById('rev-content'); if (!el) return;
  if (!revisoes || !revisoes.length) {
    el.innerHTML = '<div class="rev-empty">Nenhuma revisão agendada ainda.<br>Use o cronômetro e agende revisões ao estudar.</div>'; return;
  }
  const today = todayKey();

  // Classify each revisao
  const groups = { overdue: [], today: [], week: [], later: [], done: [] };
  revisoes.forEach(r => {
    if (r.done) { groups.done.push(r); return; }
    const daysLeft = Math.ceil((new Date(r.revDate+'T00:00:00') - new Date(today+'T00:00:00'))/86400000);
    if (daysLeft < 0)      groups.overdue.push(r);
    else if (daysLeft === 0) groups.today.push(r);
    else if (daysLeft <= 7) groups.week.push(r);
    else                    groups.later.push(r);
  });

  const groupDefs = [
    { key:'overdue', icon:'🔴', title:'Atrasadas',    color:'#b91c1c' },
    { key:'today',   icon:'🟡', title:'Revisar Hoje', color:'#b45309' },
    { key:'week',    icon:'🔵', title:'Esta Semana',  color:'#0D134C' },
    { key:'later',   icon:'⚪', title:'Próximas',     color:'#8a90b8' },
    { key:'done',    icon:'🟢', title:'Concluídas',   color:'#15803d' },
  ];

  let html = '';
  groupDefs.forEach(gd => {
    const items = groups[gd.key];
    if (!items.length) return;

    // Group by disc within this group
    const byDisc = {};
    items.forEach(r => {
      const k = r.disc || 'Sem disciplina';
      if (!byDisc[k]) byDisc[k] = [];
      byDisc[k].push(r);
    });

    html += `<div class="rev-group">
      <div class="rev-group-hdr">
        <span class="rev-group-icon">${gd.icon}</span>
        <span class="rev-group-title">${gd.title}</span>
        <span class="rev-group-count">${items.length} tópico${items.length!==1?'s':''}</span>
      </div>`;

    Object.keys(byDisc).sort().forEach(disc => {
      const discItems = byDisc[disc];
      const discIdx = EDITAL.findIndex(d => d.nome === disc);
      const cor = discIdx >= 0 ? DISC_CORES[discIdx % DISC_CORES.length] : '#8a90b8';

      html += `<div class="rev-disc-block" style="--dc:${cor}">
        <div class="rev-disc-hdr">
          <div class="rev-disc-dot"></div>
          <div class="rev-disc-name">${disc}</div>
          <div class="rev-disc-cnt">${discItems.length} tópico${discItems.length!==1?'s':''}</div>
        </div>`;

      discItems.forEach(r => {
        const daysLeft = Math.ceil((new Date(r.revDate+'T00:00:00') - new Date(today+'T00:00:00'))/86400000);
        const [,rm,rd] = r.revDate.split('-');
        let badgeClass, badgeLabel;
        if (r.done)         { badgeClass='done';    badgeLabel='✓ Concluída'; }
        else if (daysLeft<0){ badgeClass='overdue'; badgeLabel=`${Math.abs(daysLeft)}d atrasada`; }
        else if (daysLeft===0){ badgeClass='pending'; badgeLabel='Hoje!'; }
        else                { badgeClass='pending'; badgeLabel=`${daysLeft}d — ${rd}/${rm}`; }

        const actionLabel = r.done ? 'Reabrir' : 'Finalizado';
        const actionClass = r.done ? ' is-done' : '';
        const actionTitle = r.done ? 'Marcar revisão como pendente' : 'Marcar revisão como finalizada';

        html += `<div class="rev-topic-row">
          <div>
            <div class="rev-topic-name">${r.topic || '—'}</div>
            <div class="rev-topic-meta">Estudo: ${r.studyDate?r.studyDate.split('-').reverse().join('/'):'—'} &bull; Agendada ${r.days}d</div>
          </div>
          <div class="rev-badges">
            <span class="rev-badge ${badgeClass}">${badgeLabel}</span>
            <button class="rev-done-btn${actionClass}" onclick="toggleRevDone('${r.id}')" title="${actionTitle}">${actionLabel}</button>
            <button class="btn-del" onclick="deleteRevisao('${r.id}')" title="Remover">🗑</button>
          </div>
        </div>`;
      });
      html += '</div>'; // rev-disc-block
    });
    html += '</div>'; // rev-group
  });

  el.innerHTML = html;
}

function deleteRevisao(id) {
  revisoes = revisoes.filter(r => String(r.id)!==String(id)); renderRevisoes(); debouncedSave();
}

// ── PAINEL DE ESTATÍSTICAS ─────────────────────────────
function renderCharts() {
  const discEl   = document.getElementById('chart-disc');
  const periodEl = document.getElementById('chart-period');
  if (!discEl || !periodEl) return;

  const discFilter = discEl.value;
  const period     = parseInt(periodEl.value) || 0;
  const cutoffKey  = period > 0 ? dateToKey(new Date(Date.now() - period*86400000)) : '0000-00-00';

  let regs = historico.filter(r => r.date >= cutoffKey);
  if (discFilter) regs = regs.filter(r => r.disc === discFilter);

  const totalH  = regs.reduce((s,r)=>s+(r.horas||0),0);
  const totalAc = regs.reduce((s,r)=>s+(r.acertos||0),0);
  const totalEr = regs.reduce((s,r)=>s+(r.erros||0),0);
  const totQ    = totalAc + totalEr;
  const pct     = totQ > 0 ? Math.round(totalAc/totQ*100) : null;

  const pctColor = pct===null ? 'var(--text-soft)' : pct>=70 ? '#15803d' : pct>=50 ? '#b45309' : '#b91c1c';

  // Big numbers
  document.getElementById('sb-horas').textContent    = horasLabel(totalH);
  document.getElementById('sb-acertos').textContent  = totalAc;
  document.getElementById('sb-erros').textContent    = totalEr;
  document.getElementById('sb-pct').textContent      = pct !== null ? pct + '%' : '—';
  document.getElementById('sb-pct').style.color      = pctColor;

  const periodLabel = period > 0 ? `últimos ${period} dias` : 'todo o período';
  ['sb-horas-sub','sb-acertos-sub','sb-erros-sub','sb-pct-sub'].forEach(id => {
    document.getElementById(id).textContent = periodLabel;
  });

  // Per-discipline breakdown — always show all disciplines
  const discRow = document.getElementById('stats-disc-row');
  const discData = EDITAL.map((d, i) => {
    let dRegs = historico.filter(r => r.disc === d.nome && r.date >= cutoffKey);
    const h  = dRegs.reduce((s,r)=>s+(r.horas||0),0);
    const ac = dRegs.reduce((s,r)=>s+(r.acertos||0),0);
    const er = dRegs.reduce((s,r)=>s+(r.erros||0),0);
    const q  = ac + er;
    const p  = q > 0 ? Math.round(ac/q*100) : null;
    return { nome: d.nome, cor: DISC_CORES[i % DISC_CORES.length], h, ac, er, q, p };
  });

  // Show all, sorted: with data first
  discData.sort((a,b) => (b.h+b.q) - (a.h+a.q));

  const maxH = Math.max(...discData.map(d => d.h), 0.01);
  const maxQ = Math.max(...discData.map(d => d.q), 0.01);

  discRow.innerHTML = discData.map(d => {
    const hasData = d.h > 0 || d.q > 0;
    const pctColor = d.p===null ? 'var(--text-soft)' : d.p>=70 ? '#15803d' : d.p>=50 ? '#b45309' : '#b91c1c';
    const barW = hasData ? Math.max(4, Math.round((d.h / maxH) * 100)) : 0;
    const opacity = hasData ? '1' : '0.4';
    return `<div class="stat-disc-item" style="opacity:${opacity}">
      <div class="stat-disc-dot" style="background:${d.cor}"></div>
      <div class="stat-disc-name" title="${d.nome}">${d.nome}</div>
      <div class="stat-disc-bar-wrap" title="${horasLabel(d.h)}"><div class="stat-disc-bar-fill" style="width:${barW}%;background:${d.cor}"></div></div>
      <div class="stat-disc-nums">
        <div class="stat-disc-num"><div class="stat-disc-num-val" style="color:var(--navy)">${hasData ? horasLabel(d.h) : '—'}</div><div class="stat-disc-num-lbl">Horas</div></div>
        <div class="stat-disc-num"><div class="stat-disc-num-val" style="color:var(--green)">${d.ac > 0 ? d.ac : '—'}</div><div class="stat-disc-num-lbl">Acertos</div></div>
        <div class="stat-disc-num"><div class="stat-disc-num-val" style="color:var(--red)">${d.er > 0 ? d.er : '—'}</div><div class="stat-disc-num-lbl">Erros</div></div>
        <div class="stat-disc-num"><div class="stat-disc-num-val" style="color:${pctColor}">${d.p !== null ? d.p+'%' : '—'}</div><div class="stat-disc-num-lbl">% Acerto</div></div>
      </div>
    </div>`;
  }).join('');
}
function populateChartDisc() {
  const sel = document.getElementById('chart-disc'); if (!sel) return;
  sel.innerHTML = '<option value="">Todas as disciplinas</option>' + EDITAL.map(d=>`<option value="${d.nome}">${d.nome}</option>`).join('');
}

// ── INIT ─────────────────────────────────────────────────
function init() {
  loadStorage();
  document.getElementById('man-data').value = todayKey();
  refreshAll();
  snapAuto();
  compactTabs(); switchTab('hoje');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  setTimeout(lembreteRevisoes, 1500);
}
init();
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('cf-modal').classList.contains('open')) { cfClose(false); return; }
  closeConcModal(); if (document.getElementById('ed-modal').classList.contains('open')) closeEditEdital();
});



if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) { window.addEventListener("load", function(){ navigator.serviceWorker.register("sw.js").catch(function(){}); }); }
/* ═══════════ v4 · gráficos de qualidade · Treinador · Busca de concurso · Mapas dos erros ═══════════ */
const _$ = id => document.getElementById(id);
function _xe(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _nrm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function _fd(k) { return k ? k.slice(8, 10) + '/' + k.slice(5, 7) : ''; }
function _wk(k) { const d = new Date(k + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateToKey(d); }
function _trunc(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function _vazio(m) { return '<div class="rx-note">' + m + '</div>'; }
function _leg(it) { return '<div class="leg">' + it.map(i => '<span><i style="background:' + i[0] + '"></i>' + i[1] + '</span>').join('') + '</div>'; }

/* ---------- gráficos de qualidade (Desempenho) ---------- */
function _svgBL(lb, b1, b2, ln, lmax, sfx) {
  const Wd = 480, H = 230, pl = 30, pr = 34, pt = 18, pb = 32, iw = Wd - pl - pr, ih = H - pt - pb, n = lb.length;
  const mx = Math.max(1, ...b1, ...b2), bw = Math.max(4, Math.min(18, iw / n / 2.6));
  const X = i => pl + iw * (i + .5) / n, Yb = v => pt + ih * (1 - v / mx), Yl = v => pt + ih * (1 - v / lmax);
  let g = '';
  [0, .5, 1].forEach(f => { const y = pt + ih * (1 - f); g += `<line x1="${pl}" x2="${Wd - pr}" y1="${y}" y2="${y}" stroke="#e2e5f0"/><text x="${Wd - pr + 4}" y="${y + 3}" font-size="10" fill="#8a90b0">${Math.round(lmax * f)}${sfx}</text><text x="${pl - 4}" y="${y + 3}" font-size="10" text-anchor="end" fill="#8a90b0">${Math.round(mx * f)}</text>`; });
  lb.forEach((l, i) => { g += `<rect x="${X(i) - bw - 1}" y="${Yb(b1[i])}" width="${bw}" height="${pt + ih - Yb(b1[i])}" rx="2" fill="#7DCFB0"/><rect x="${X(i) + 1}" y="${Yb(b2[i])}" width="${bw}" height="${pt + ih - Yb(b2[i])}" rx="2" fill="#f87171"/><text x="${X(i)}" y="${H - 12}" font-size="10" text-anchor="middle" fill="#8a90b0">${_fd(l)}</text>`; });
  const pts = []; ln.forEach((v, i) => { if (v != null) pts.push([X(i), Yl(v), v]); });
  if (pts.length > 1) g += `<polyline points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}" fill="none" stroke="#0D134C" stroke-width="2.5" stroke-linejoin="round"/>`;
  pts.forEach(p => { g += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#0D134C"/><text x="${p[0]}" y="${p[1] - 8}" font-size="10" text-anchor="middle" font-weight="700" fill="#0D134C">${p[2]}${sfx}</text>`; });
  return `<svg viewBox="0 0 ${Wd} ${H}" style="width:100%;height:auto">${g}</svg>`;
}
function _svgLN(lb, series) {
  const Wd = 480, H = 220, pl = 32, pr = 14, pt = 16, pb = 30, iw = Wd - pl - pr, ih = H - pt - pb, n = lb.length;
  const X = i => pl + (n === 1 ? iw / 2 : iw * i / (n - 1)), Y = v => pt + ih * (1 - v / 100); let g = '';
  [0, 25, 50, 75, 100].forEach(v => { g += `<line x1="${pl}" x2="${Wd - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e2e5f0"/><text x="${pl - 4}" y="${Y(v) + 3}" font-size="10" text-anchor="end" fill="#8a90b0">${v}%</text>`; });
  lb.forEach((l, i) => { g += `<text x="${X(i)}" y="${H - 10}" font-size="10" text-anchor="middle" fill="#8a90b0">${_fd(l)}</text>`; });
  series.forEach(s => {
    const pts = []; s.vals.forEach((v, i) => { if (v != null) pts.push([X(i), Y(v), v]); });
    if (pts.length > 1) g += `<polyline points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}" fill="none" stroke="${s.cor}" stroke-width="2.5" stroke-linejoin="round"/>`;
    pts.forEach(p => { g += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${s.cor}"/><text x="${p[0]}" y="${p[1] - 8}" font-size="10" text-anchor="middle" font-weight="700" fill="${s.cor}">${p[2]}%</text>`; });
  });
  return `<svg viewBox="0 0 ${Wd} ${H}" style="width:100%;height:auto">${g}</svg>`;
}
function _dica(m) {
  const n = _nrm(m);
  if (n.includes('atenc')) return 'Desatenção: releie o comando da questão e sublinhe negações ("exceto", "incorreta") antes de marcar.';
  if (n.includes('confu')) return 'Confusão entre conceitos: monte um quadro comparativo dos itens parecidos.';
  if (n.includes('sabia') || n.includes('conteudo') || n.includes('lacuna')) return 'Lacuna de conteúdo: volte ao assunto e refaça o resumo antes de treinar mais questões.';
  if (n.includes('tempo')) return 'Falta de tempo: treine blocos de questões cronometrados.';
  if (n.includes('chute')) return 'Chute: só marque com critério e anote o que levaria à certeza.';
  return '';
}
function renderDsExtra() {
  if (!_$('ds-ch1')) return;
  const per = vv('ds-per'), disc = vv('ds-disc'), tk = todayKey(), ini = per === 'todos' ? '' : addDays(tk, -(parseInt(per) - 1));
  const rows = historico.filter(r => (!ini || r.date >= ini) && (!disc || r.disc === disc));
  const W = {};
  rows.forEach(r => {
    const k = _wk(r.date), o = W[k] || (W[k] = { k, ac: 0, er: 0, nQ: 0, nA: 0, rQ: 0, rA: 0 }), ac = r.acertos || 0, er = r.erros || 0, n = ac + er;
    o.ac += ac; o.er += er;
    if (r.cls) { const rq = Math.min(r.rq || 0, n), ra = Math.min(r.ra || 0, ac); o.rQ += rq; o.rA += ra; o.nQ += n - rq; o.nA += ac - ra; }
  });
  const ws = Object.values(W).filter(w => w.ac + w.er > 0).sort((a, b) => a.k < b.k ? -1 : 1).slice(-12), tot = ws.reduce((s, w) => s + w.ac + w.er, 0);
  /* 1 · curva de acertos e erros */
  _$('ds-ch1').innerHTML = (ws.length < 2 || tot < 20)
    ? _vazio('Dados insuficientes para a curva. Registre acertos e erros em pelo menos 2 semanas (mínimo de 20 questões). Você tem ' + tot + ' questão(ões) em ' + ws.length + ' semana(s) neste filtro.')
    : _svgBL(ws.map(w => w.k), ws.map(w => w.ac), ws.map(w => w.er), ws.map(w => Math.round(w.ac / (w.ac + w.er) * 100)), 100, '%') + _leg([['#7DCFB0', 'Acertos'], ['#f87171', 'Erros'], ['#0D134C', 'Taxa de acerto da semana']]);
  /* 2 · qualidade do aprendizado: novas × repetidas */
  const wn = ws.filter(w => w.nQ >= 5 || w.rQ >= 5);
  _$('ds-ch2').innerHTML = (wn.length < 2)
    ? _vazio('Para medir a qualidade do aprendizado, informe em "questões repetidas" (campo opcional ao registrar) quantas já tinha feito antes. São necessárias 2 semanas com pelo menos 5 questões novas ou repetidas.')
    : _svgLN(wn.map(w => w.k), [{ cor: '#0D134C', vals: wn.map(w => w.nQ >= 5 ? Math.round(w.nA / w.nQ * 100) : null) }, { cor: '#f59e0b', vals: wn.map(w => w.rQ >= 5 ? Math.round(w.rA / w.rQ * 100) : null) }]) + _leg([['#0D134C', 'Acerto em questões novas (domínio real)'], ['#f59e0b', 'Acerto em repetidas (memória)']]);
  /* 3 · curva de erros do caderno */
  const E = erros.filter(e => !disc || e.disc === disc);
  if (E.length < 3) _$('ds-ch3').innerHTML = _vazio('Dados insuficientes: registre pelo menos 3 erros no Caderno de erros. Você tem ' + E.length + ' neste filtro.');
  else {
    let f = E.map(e => _wk(e.date || tk)).sort()[0]; const cur = _wk(tk), keys = [];
    while (f <= cur) { keys.push(f); f = addDays(f, 7); }
    let acc = 0; const rows3 = keys.map(k => {
      const nv = E.filter(e => _wk(e.date || tk) === k).length, rs = E.filter(e => e.dominado && e.ult && _wk(e.ult) === k).length; acc += nv - rs;
      return { k, nv, rs, pend: Math.max(0, acc) };
    }).slice(-12), mp = Math.max(1, ...rows3.map(r => r.pend));
    _$('ds-ch3').innerHTML = _svgBL(rows3.map(r => r.k), rows3.map(r => r.rs), rows3.map(r => r.nv), rows3.map(r => r.pend), mp, '') + _leg([['#f87171', 'Erros novos'], ['#7DCFB0', 'Erros dominados'], ['#0D134C', 'Pendentes (acumulado)']]);
  }
  /* 4 · o que melhorar */
  const pd = {}, pt = {};
  rows.forEach(r => { const ac = r.acertos || 0, er = r.erros || 0; if (ac + er <= 0) return; (pd[r.disc] = pd[r.disc] || { ac: 0, er: 0 }); pd[r.disc].ac += ac; pd[r.disc].er += er; if (r.topic) { const k = r.disc + ' › ' + r.topic; (pt[k] = pt[k] || { ac: 0, er: 0 }); pt[k].ac += ac; pt[k].er += er; } });
  const rk = o => Object.entries(o).map(([k, v]) => ({ k, n: v.ac + v.er, p: Math.round(v.ac / (v.ac + v.er) * 100) })).filter(x => x.n >= 10).sort((a, b) => a.p - b.p).slice(0, 3);
  const pe = {}; E.filter(e => !e.dominado).forEach(e => { const k = (e.disc || '—') + (e.topic ? ' › ' + e.topic : ''); pe[k] = (pe[k] || 0) + 1; });
  const pend = Object.entries(pe).filter(x => x[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const mot = {}; E.forEach(e => { const m = e.motivo || 'Não informado'; mot[m] = (mot[m] || 0) + 1; });
  const mots = Object.entries(mot).sort((a, b) => b[1] - a[1]);
  let h4 = '';
  const l1 = rk(pd), l2 = rk(pt);
  if (l1.length) h4 += '<div class="mel"><b>Matérias com menor acerto</b>' + l1.map(x => `<div>${_xe(x.k)} <span class="chip ${x.p < 60 ? 'red' : x.p < 75 ? 'yel' : 'grn'}">${x.p}%</span> <small>${x.n} questões</small></div>`).join('') + '</div>';
  if (l2.length) h4 += '<div class="mel"><b>Assuntos com menor acerto</b>' + l2.map(x => `<div>${_xe(x.k)} <span class="chip ${x.p < 60 ? 'red' : x.p < 75 ? 'yel' : 'grn'}">${x.p}%</span> <small>${x.n} questões</small></div>`).join('') + '</div>';
  if (pend.length) h4 += '<div class="mel"><b>Erros recorrentes ainda pendentes</b>' + pend.map(x => `<div>${_xe(x[0])} <span class="chip red">${x[1]} pendentes</span></div>`).join('') + '</div>';
  if (E.length >= 5) {
    h4 += '<div class="mel"><b>Por que você erra</b>' + mots.slice(0, 5).map(m => `<div class="mbar"><span>${_xe(m[0])}</span><div><i style="width:${Math.round(m[1] / E.length * 100)}%"></i></div><small>${Math.round(m[1] / E.length * 100)}%</small></div>`).join('');
    const dc = _dica(mots[0][0]); if (dc) h4 += '<div class="rx-note" style="margin-top:6px">💡 Sugestão: ' + _xe(dc) + '</div>'; h4 += '</div>';
  }
  _$('ds-melhorar').innerHTML = h4 || _vazio('Ainda não há dados suficientes para apontar o que melhorar. São usados: matérias/assuntos com pelo menos 10 questões lançadas e pelo menos 5 erros no caderno. Quanto mais registros, mais confiável a análise.');
}
{ const _o = renderDesempenho; renderDesempenho = function () { _o(); try { renderDsExtra(); } catch (e) { console.error(e); } }; }

/* ---------- Busca de concurso (estrutura pronta; motor ainda não conectado) ----------
   Contrato do motor:  BUSCA.provider = { search: async (texto) => [ { nome, orgao, cargo, banca,
   situacao, tipo:'novo'|'anterior', dataPub:'AAAA-MM-DD', fonte, url } ] }
   Enquanto provider for null, a busca mostra apenas os concursos cadastrados neste app. */
const BUSCA = { provider: null };
function _buscaLocal(q) {
  const ws = _nrm(q).split(/\s+/).filter(Boolean);
  return Object.keys(store.concursos).map(id => { const i = (id === curId ? CONCURSO_INFO : store.concursos[id].info) || {}; return { id, local: true, nome: i.concurso || id, orgao: '', cargo: i.cargo || '', banca: i.banca || '', situacao: 'Cadastrado no app', tipo: 'local', dataProva: i.dataProva || '' }; })
    .filter(r => { const t = _nrm([r.nome, r.cargo, r.banca].join(' ')); return ws.every(w => t.includes(w)); });
}
async function buscarConc() {
  const q = vv('bs-q').trim(); if (q.length < 2) { showToast('🔎', 'Digite o nome do concurso, órgão ou cargo.'); return; }
  const loc = _buscaLocal(q); let ext = [], aviso = '';
  if (BUSCA.provider && typeof BUSCA.provider.search === 'function') {
    try { if (!navigator.onLine) throw new Error('sem conexão'); ext = (await BUSCA.provider.search(q)) || []; }
    catch (e) { aviso = '⚠️ A busca online não respondeu (' + _xe(e.message || 'erro') + '). Mostrando apenas os concursos cadastrados.'; }
  } else aviso = '🔌 A busca na internet ainda não está conectada. Por enquanto a pesquisa mostra só os concursos cadastrados neste app.';
  window._bsRes = loc.concat(ext.map(r => Object.assign({ local: false }, r)));
  const L = window._bsRes;
  _$('bs-res').innerHTML = (aviso ? _vazio(aviso) : '') + (L.length ? L.map((r, i) => {
    const ant = r.tipo === 'anterior', url = /^https?:\/\//.test(r.url || '') ? r.url : '';
    return `<div class="bs-it"><div class="bs-t">${_xe(r.nome)}</div><div class="bs-s">${_xe([r.orgao, r.cargo, r.banca].filter(Boolean).join(' · '))}</div>
      <div class="bs-s"><span class="chip ${ant ? 'yel' : 'grn'}">${_xe(ant ? 'Referência anterior (não é edital novo)' : (r.situacao || '—'))}</span>${r.dataPub ? ' <small>publicado em ' + _xe(r.dataPub.split('-').reverse().join('/')) + '</small>' : ''}${url ? ' <a href="' + _xe(url) + '" target="_blank" rel="noopener">fonte ↗</a>' : ''}</div>
      <button class="btn btn-navy" onclick="selecionarConc(${i})">Selecionar</button></div>`;
  }).join('') : _vazio('Nenhum concurso encontrado para "' + _xe(q) + '". Não inventamos resultados: cadastre o concurso (＋) ou tente outro termo.'));
}
function selecionarConc(i) {
  const r = (window._bsRes || [])[i]; if (!r) return;
  store.sel = { id: r.local ? r.id : null, nome: r.nome, orgao: r.orgao || '', cargo: r.cargo || '', banca: r.banca || '', situacao: r.situacao || '', tipo: r.tipo || '', dataPub: r.dataPub || '', fonte: r.url || '', ts: Date.now() };
  persist(); renderBusca(); showToast('✅', 'Concurso selecionado.');
}
function selecionarAtivo() {
  store.sel = { id: curId, nome: CONCURSO_INFO.concurso, orgao: '', cargo: CONCURSO_INFO.cargo || '', banca: CONCURSO_INFO.banca || '', situacao: 'Cadastrado no app', tipo: 'local', dataPub: '', fonte: '', ts: Date.now() };
  persist(); renderTrein(); renderBusca();
}
function limparSel() { store.sel = null; persist(); renderBusca(); if (_$('page-treinador').classList.contains('active')) renderTrein(); }
function renderBusca() {
  const el = _$('bs-sel'); if (!el) return; const s = store.sel;
  if (!s) { el.innerHTML = ''; return; }
  const ant = s.tipo === 'anterior';
  el.innerHTML = `<div class="bs-sel"><div class="xlbl">Concurso selecionado</div><div class="bs-t">${_xe(s.nome)}</div>
    <div class="bs-s">${_xe([s.orgao, s.cargo && ('Cargo: ' + s.cargo), s.banca && ('Banca: ' + s.banca)].filter(Boolean).join(' · '))}</div>
    <div class="bs-s"><span class="chip ${ant ? 'yel' : 'grn'}">${_xe(ant ? 'Edital anterior usado como referência' : (s.situacao || 'Cadastrado'))}</span></div>
    <div class="bs-act"><button class="btn btn-lime" onclick="horaAprovado()">🚀 Hora de Ser Aprovado</button><button class="btn btn-ghost" onclick="limparSel()">Trocar</button></div></div>`;
}
function horaAprovado() {
  const s = store.sel;
  if (!s) { showToast('🔎', 'Busque um concurso e selecione um resultado primeiro.'); switchTab('hoje'); scrollToId('bs-card'); return; }
  if (!s.id || !store.concursos[s.id]) {
    openConcModal('new');
    setTimeout(() => { const f = (id, v) => { const e = _$(id); if (e && v) e.value = v; }; f('cm-nome', s.nome); f('cm-cargo', s.cargo); f('cm-banca', s.banca); }, 30);
    showToast('📝', 'Confirme o cadastro deste concurso e toque novamente em Hora de Ser Aprovado.'); return;
  }
  if (s.id !== curId) switchConcurso(s.id);
  const T = TR(); T.ativo = true; T.desde = T.desde || todayKey(); persist(); switchTab('treinador');
}

/* ---------- Treinador: um tópico por dia · pontuação · ajuste do cronograma pelo progresso ---------- */
function TR() {
  const t = plano.trein = (plano.trein && typeof plano.trein === 'object') ? plano.trein : {};
  t.cfg = Object.assign({ horas: 2, dias: 6, qdia: 10, mtop: 45 }, t.cfg || {});
  if (!t.dias || typeof t.dias !== 'object') t.dias = {};
  Object.keys(t.dias).forEach(k => { const d = t.dias[k]; if (!d || d.v !== 2 || !Array.isArray(d.itens)) delete t.dias[k]; }); /* formato antigo/inconsistente */
  t.reforcos = Array.isArray(t.reforcos) ? t.reforcos : [];
  t.log = Array.isArray(t.log) ? t.log : [];
  t.atrasos = (t.atrasos && typeof t.atrasos === 'object') ? t.atrasos : {};
  return t;
}
function _topInfo(tid) {
  for (const d of EDITAL) for (const g of d.grupos) for (let i = 0; i < g.topicos.length; i++)
    if (d.id + '_' + slug(g.nome) + '_' + i === tid) return { tid, disc: d.nome, topic: g.topicos[i] };
  return null;
}
function _cronItens() { return (plano.cron && Array.isArray(plano.cron.itens)) ? plano.cron.itens : []; }
function _escolheTopico(T) {
  const tk = todayKey();
  const rf = T.reforcos.filter(r => !r.feito && r.due <= tk).sort((a, b) => a.due < b.due ? -1 : 1).find(r => _topInfo(r.tid));
  if (rf) return Object.assign(_topInfo(rf.tid), { origem: 'reforco' });
  const at = Object.keys(T.atrasos).find(t => !getTS(t).done && _topInfo(t));
  if (at) return Object.assign(_topInfo(at), { origem: 'atraso' });
  const ch = _cronItens().find(x => x.date === tk && x.tipo === 'estudo' && x.tid && !getTS(x.tid).done && _topInfo(x.tid));
  if (ch) return Object.assign(_topInfo(ch.tid), { origem: 'cronograma' });
  const usados = {}; Object.keys(T.dias).forEach(k => { if (k < tk && k >= addDays(tk, -14) && T.dias[k].topico) usados[T.dias[k].topico.tid] = 1; });
  const rec = {}; Object.keys(T.dias).forEach(k => { const x = T.dias[k].topico; if (x && k < tk && k >= addDays(tk, -3)) rec[x.disc] = (rec[x.disc] || 0) + 1; });
  const melhor = (evita) => { let b = null; EDITAL.forEach(d => pendRows(d).forEach(r => { if (evita && usados[r.tid]) return; const sc = ((r.inc || 0) + 1) * (d.peso || 3) * Math.pow(0.5, rec[d.nome] || 0); if (!b || sc > b.sc) b = { sc, tid: r.tid }; })); return b; };
  const b = melhor(true) || melhor(false);
  return b ? Object.assign(_topInfo(b.tid), { origem: 'prioridade' }) : null;
}
function _ajusteDiario(T) {
  const tk = todayKey(); if (T.ajusteEm === tk) return; T.ajusteEm = tk;
  const ant = Object.keys(T.dias).filter(k => k < tk).sort().pop(); let redistribuir = false;
  if (ant && T.dias[ant].topico) {
    const d = T.dias[ant], tid = d.topico.tid, feito = d.itens.some(i => i.k === 'estudo' && i.done) || (d.topico.origem !== 'reforco' && getTS(tid).done);
    if (feito) delete T.atrasos[tid];
    else {
      const n = (T.atrasos[tid] || 0) + 1;
      if (n <= 2) { T.atrasos[tid] = n; T.log.push({ d: tk, t: '“' + d.topico.topic + '” não foi estudado em ' + _fd(ant) + ' e volta hoje (' + n + '/2).' }); }
      else { delete T.atrasos[tid]; redistribuir = true; T.log.push({ d: tk, t: '“' + d.topico.topic + '” atrasou 2 vezes e foi redistribuído pelo cronograma.' }); }
    }
  }
  const c = plano.cron && Array.isArray(plano.cron.itens) ? plano.cron : null;
  if (c && (redistribuir || c.itens.some(i => i.tipo === 'estudo' && !i.done && i.date < tk))) {
    const cfg = Object.assign({}, c.cfg || cronDefaults()); cfg.inicio = tk; if (!cfg.fim || cfg.fim < tk) cfg.fim = dateToKey(addDaysD(28));
    const r = gerarCron(cfg); if (!r.erro) { plano.cron = r; T.log.push({ d: tk, t: 'Cronograma ajustado: tópicos atrasados foram redistribuídos até a prova.' }); }
  }
  T.log = T.log.slice(-20);
}
function diaHoje() {
  const T = TR(), tk = todayKey(); let dia = T.dias[tk]; if (dia) return dia;
  _ajusteDiario(T);
  const tp = _escolheTopico(T);
  dia = { v: 2, data: tk, topico: tp ? { tid: tp.tid, disc: tp.disc, topic: tp.topic, origem: tp.origem } : null, itens: [] };
  if (tp) {
    const q = T.cfg.qdia;
    dia.itens.push({ k: 'estudo', txt: tp.origem === 'reforco' ? 'Reforçar o tópico (releia o resumo e os erros)' : 'Estudar o tópico', det: 'Estude e marque como estudado', pts: 20 });
    dia.itens.push({ k: 'quest', txt: 'Resolver ' + q + ' questões deste tópico', det: 'Lance acertos e erros em Estudar, escolhendo este tópico', pts: 20, meta: q });
    const due = revisoes.filter(r => !r.done && r.revDate <= tk).length;
    if (due) { const m = Math.min(due, 3); dia.itens.push({ k: 'rev', txt: 'Fazer ' + m + ' revisão(ões) vencida(s)', det: due + ' pendente(s) no total', pts: 5 * m, meta: m, base: due }); }
    const pe = erros.filter(e => !e.dominado && e.disc === tp.disc), pt = pe.filter(e => findTopicTid(e.disc, e.topic) === tp.tid), use = pt.length ? pt : pe;
    if (use.length) dia.itens.push({ k: 'err', txt: 'Treinar ' + Math.min(3, use.length) + ' erro(s) ' + (pt.length ? 'deste tópico' : 'da matéria'), det: 'No Caderno de erros', pts: 10, meta: Math.min(3, use.length) });
  }
  T.dias[tk] = dia; persist(); return dia;
}
function _avalia(dia) {
  const tk = todayKey(), tp = dia.topico, T = TR(); let mudou = false; if (!tp) return false;
  const rows = historico.filter(r => r.date === tk && r.disc === tp.disc && r.topic && findTopicTid(r.disc, r.topic) === tp.tid);
  const ac = rows.reduce((s, r) => s + (r.acertos || 0), 0), er = rows.reduce((s, r) => s + (r.erros || 0), 0), hrs = rows.reduce((s, r) => s + (r.horas || 0), 0);
  dia.itens.forEach(it => {
    if (it.done) return; let ok = false;
    if (it.k === 'estudo') ok = tp.origem === 'reforco' ? hrs > 0 : !!getTS(tp.tid).done;
    else if (it.k === 'quest') ok = (ac + er) >= it.meta;
    else if (it.k === 'rev') ok = it.base - revisoes.filter(r => !r.done && r.revDate <= tk).length >= it.meta;
    else if (it.k === 'err') ok = erros.filter(e => e.ult === tk).length >= it.meta;
    if (ok) { it.done = true; it.doneAt = Date.now(); mudou = true; }
  });
  const q = dia.itens.find(i => i.k === 'quest');
  if (q && q.done && ac + er > 0) {
    dia.acc = Math.round(ac / (ac + er) * 100);
    if (dia.acc < 60 && !dia.reforcoAg) { dia.reforcoAg = true; T.reforcos.push({ tid: tp.tid, due: addDays(tk, 3), feito: false }); T.log.push({ d: tk, t: 'Acerto de ' + dia.acc + '% em “' + tp.topic + '”: reforço agendado para ' + _fd(addDays(tk, 3)) + '.' }); mudou = true; }
  }
  const e = dia.itens.find(i => i.k === 'estudo');
  if (e && e.done) { if (tp.origem === 'reforco') T.reforcos.forEach(r => { if (r.tid === tp.tid && r.due <= tk) r.feito = true; }); delete T.atrasos[tp.tid]; }
  return mudou;
}
function _pts(dia) {
  let p = dia.itens.filter(i => i.done).reduce((s, i) => s + i.pts, 0);
  if (dia.itens.length && dia.itens.every(i => i.done)) p += 10;
  if (dia.itens.some(i => i.k === 'quest' && i.done) && (dia.acc || 0) >= 70) p += 10;
  return p;
}
function _ptsMax(dia) { return dia.itens.reduce((s, i) => s + i.pts, 0) + 20; }
function trEstudar() {
  const tp = diaHoje().topico; if (!tp) return; const idx = EDITAL.findIndex(d => d.nome === tp.disc); if (idx < 0) return;
  startStudy(idx); const ts = _$('crono-topic'); if (ts) { ts.value = tp.tid; if (ts.value !== tp.tid) ts.value = getTopicLabelFromTid(tp.disc, tp.tid); }
}
function trEstudado() {
  const dia = diaHoje(), tp = dia.topico; if (!tp) return;
  if (tp.origem !== 'reforco' && !getTS(tp.tid).done) {
    const c = _cronItens().find(x => x.tid === tp.tid && !x.done);
    if (c) cronToggle(c.id); else { setTS(tp.tid, 'done', true); setTS(tp.tid, 'datetime', fmtDt(new Date())); renderDiscs(); updateAll(); }
  }
  const it = dia.itens.find(i => i.k === 'estudo'); if (it && !it.done) { it.done = true; it.doneAt = Date.now(); }
  _avalia(dia); persist(); renderTrein();
}
function trIr(k) { if (k === 'rev') switchTab('revisoes'); else if (k === 'err') switchTab('erros'); else trEstudar(); }
const _ORIGEM = { cronograma: 'Do seu cronograma', reforco: 'Reforço: seu acerto ficou baixo neste tópico', atraso: 'Voltou: não foi estudado antes', prioridade: 'Maior prioridade do edital (peso × incidência)' };
function renderTrein() {
  const hd = _$('tr-head'), body = _$('tr-body'); if (!hd) return; const s = store.sel;
  if (!s) { body.style.display = 'none'; hd.innerHTML = `<div class="pro-card"><h3>🔎 Escolha um concurso primeiro</h3><div class="rx-note">O Treinador trabalha em cima do concurso que você selecionar. Faça a busca na tela <b>Hoje</b> e toque em <b>Selecionar</b>, ou use o concurso que já está ativo.</div><div class="bs-act"><button class="btn btn-navy" onclick="switchTab('hoje');scrollToId('bs-card')">Buscar concurso</button><button class="btn btn-ghost" onclick="selecionarAtivo()">Usar o concurso ativo</button></div></div>`; return; }
  if (s.id && !store.concursos[s.id]) { selecionarAtivo(); return; }   // concurso escolhido não existe mais
  if (!s.id) { body.style.display = 'none'; hd.innerHTML = `<div class="pro-card"><h3>📝 Falta cadastrar o concurso</h3><div class="rx-note"><b>${_xe(s.nome)}</b> ainda não está cadastrado no app. Toque em Hora de Ser Aprovado na tela Hoje para criar o cadastro.</div><div class="bs-act"><button class="btn btn-navy" onclick="horaAprovado()">Cadastrar agora</button><button class="btn btn-ghost" onclick="limparSel()">Trocar</button></div></div>`; return; }
  if (s.id !== curId) { selecionarAtivo(); return; }   // a seleção acompanha o concurso que você está estudando
  body.style.display = '';
  const d = daysTo(CONCURSO_INFO.dataProva), ant = s.tipo === 'anterior';
  hd.innerHTML = `<div class="pro-card tr-hero"><div class="xlbl">Treinando para</div><div class="bs-t">${_xe(CONCURSO_INFO.concurso)}</div>
    <div class="bs-s">${_xe([CONCURSO_INFO.cargo && ('Cargo: ' + CONCURSO_INFO.cargo), CONCURSO_INFO.banca && ('Banca: ' + CONCURSO_INFO.banca)].filter(Boolean).join(' · '))}</div>
    <div class="bs-s">${ant ? '<span class="chip yel">Edital anterior usado como referência</span> ' : ''}${d !== null && d > 0 ? '<span class="chip grn">Prova em ' + d + ' dias (data informada por você)</span>' : '<span class="chip yel">Data da prova não definida ou já passou: planejamento provisório</span>'}</div></div>`;
  const dia = diaHoje(); if (_avalia(dia)) persist();
  renderTrHoje(dia); renderTrPont(); renderTrProx(); renderTrNivel(); renderTrCfg();
}
function renderTrHoje(dia) {
  const tp = dia.topico;
  if (!tp) { _$('tr-hoje').innerHTML = _vazio('Não há tópicos pendentes no edital deste concurso. Cadastre ou importe as matérias na aba Edital.'); return; }
  const pts = _pts(dia), mx = _ptsMax(dia), ok = dia.itens.filter(i => i.done).length;
  _$('tr-hoje').innerHTML = `<div class="tr-foco"><div class="xlbl">Tópico de hoje</div><div class="bs-t">${_xe(tp.disc)} › ${_xe(tp.topic)}</div><div class="bs-s"><span class="chip ${tp.origem === 'prioridade' || tp.origem === 'cronograma' ? 'grn' : 'yel'}">${_xe(_ORIGEM[tp.origem] || '')}</span></div></div>
    <div class="tr-prog"><div><i style="width:${Math.round(pts / mx * 100)}%"></i></div><b>${pts}/${mx} pts</b></div>` +
    dia.itens.map(i => `<div class="tr-item${i.done ? ' ok' : ''}"><span class="tr-chk">${i.done ? '✅' : '⬜'}</span><div class="tx"><b>${_xe(i.txt)}</b><small>${_xe(i.det)} · +${i.pts} pts</small></div>${i.done ? '' : (i.k === 'estudo' ? '<button class="mini-btn" onclick="trEstudar()">▶ Estudar</button>' : '<button class="mini-btn" onclick="trIr(\'' + i.k + '\')">Ir</button>')}</div>`).join('') +
    `<div class="rx-note" style="margin-top:8px">Bônus: +10 pts se acertar 70% ou mais nas questões e +10 pts por concluir tudo. Concluídas ${ok}/${dia.itens.length}.${dia.acc !== undefined ? ' Acerto de hoje no tópico: ' + dia.acc + '%.' : ''}</div>
    <div class="bs-act">${dia.itens.some(i => i.k === 'estudo' && !i.done) ? '<button class="btn btn-lime" onclick="trEstudado()">✔ Já estudei este tópico</button>' : ''}<a class="btn btn-ghost" href="${_xe(ytUrl(tp.topic + ' ' + tp.disc))}" target="_blank" rel="noopener" style="text-decoration:none;color:#c4302b;justify-content:center">▶ Aula grátis no YouTube</a></div>`;
}
function renderTrPont() {
  const T = TR(), tk = todayKey(), ks = Object.keys(T.dias).sort(); let tot = 0, sem = 0;
  ks.forEach(k => { const p = _pts(T.dias[k]); tot += p; if (k > addDays(tk, -7)) sem += p; });
  let st = 0, d = T.dias[tk] && T.dias[tk].itens.some(i => i.done) ? tk : addDays(tk, -1);
  while (T.dias[d] && T.dias[d].itens.some(i => i.done)) { st++; d = addDays(d, -1); }
  const hoje = T.dias[tk] ? _pts(T.dias[tk]) : 0, ult = ks.slice(-7);
  const com = ult.filter(k => T.dias[k].topico), est = com.filter(k => T.dias[k].itens.some(i => i.k === 'estudo' && i.done)).length;
  _$('tr-pont').innerHTML = `<div class="kpi-grid"><div class="kpi"><div class="v">${hoje}</div><div class="t">Hoje</div></div><div class="kpi"><div class="v">${sem}</div><div class="t">Últimos 7 dias</div></div><div class="kpi"><div class="v">${tot}</div><div class="t">Total</div></div><div class="kpi"><div class="v">🔥${st}</div><div class="t">Dias seguidos</div></div></div>` +
    (ult.length ? ult.map(k => { const dd = T.dias[k], p = _pts(dd), mx = _ptsMax(dd) || 1; return `<div class="tr-h"><span>${_fd(k)}</span><div><i style="width:${Math.min(100, Math.round(p / mx * 100))}%"></i></div><small>${p}</small></div>`; }).join('') : '') +
    (com.length >= 3 ? `<div class="rx-note" style="margin-top:8px">Ritmo: você estudou o tópico do dia em ${est} de ${com.length} dias recentes.${est / com.length < 0.5 ? ' Se está pesado, reduza as horas por dia em Metas: o app redistribui o cronograma.' : ''}</div>` : '<div class="rx-note" style="margin-top:8px">Os pontos e o ritmo aparecem conforme os dias passam.</div>');
}
function renderTrProx() {
  const T = TR(), tk = todayKey(), dia = T.dias[tk], hojeTid = dia && dia.topico ? dia.topico.tid : '', c = _cronItens();
  let lista = [];
  if (c.length) lista = c.filter(i => i.tipo === 'estudo' && !i.done && i.date > tk && i.tid !== hojeTid).sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 5).map(i => `<div class="tr-h" style="grid-template-columns:48px 1fr"><span>${_fd(i.date)}</span><span style="font-size:13px;color:var(--navy)"><b>${_xe(i.disc)}</b> › ${_xe(i.topic)}</span></div>`);
  else {
    const last = Object.keys(T.dias).sort().map(k => T.dias[k].topico && T.dias[k].topico.disc).filter(Boolean).slice(-3), usados = {}, out = [];
    Object.keys(T.dias).forEach(k => { const x = T.dias[k].topico; if (x && k >= addDays(tk, -14)) usados[x.tid] = 1; });
    for (let n = 0; n < 5; n++) {
      const rec = {}; last.slice(-3).forEach(dn => rec[dn] = (rec[dn] || 0) + 1); let b = null;
      EDITAL.forEach(d => pendRows(d).forEach(r => { if (usados[r.tid] || r.tid === hojeTid) return; const sc = ((r.inc || 0) + 1) * (d.peso || 3) * Math.pow(0.5, rec[d.nome] || 0); if (!b || sc > b.sc) b = { sc, d: d.nome, t: r.t, tid: r.tid }; }));
      if (!b) break; usados[b.tid] = 1; last.push(b.d); out.push(b);
    }
    lista = out.map(x => `<div class="tr-h" style="grid-template-columns:1fr"><span style="font-size:13px;color:var(--navy)"><b>${_xe(x.d)}</b> › ${_xe(x.t)}</span></div>`);
  }
  _$('tr-prox').innerHTML = (lista.length ? '<div class="xlbl">' + (c.length ? 'Seguem no seu cronograma' : 'Prováveis próximos (por prioridade, sem cronograma)') + '</div>' + lista.join('') : _vazio('Nenhum tópico pendente à frente.')) +
    (c.length ? '' : '<div class="bs-act"><button class="btn btn-ghost" onclick="switchTab(\'cronograma\')">🗓️ Gerar cronograma até a prova</button></div>') +
    (T.log.length ? '<div class="xlbl" style="margin-top:10px">Ajustes automáticos recentes</div>' + T.log.slice(-3).reverse().map(l => `<div class="rx-note" style="margin-top:4px">${_fd(l.d)} · ${_xe(l.t)}</div>`).join('') : '<div class="rx-note" style="margin-top:8px">Se um tópico não for estudado, ele volta no dia seguinte (até 2 vezes) e o cronograma é redistribuído. Acerto abaixo de 60% agenda um reforço em 3 dias.</div>');
}
function nivelInfo() {
  const A = agrega(historico), n = A.ac + A.er;
  if (n < 30) return { ok: false, n };
  const tk = todayKey(); let c = 0, t = 0; EDITAL.forEach(d => { const p = discProg(d, state); c += p.c; t += p.t; });
  const acerto = A.ac / n * 100, cob = t ? c / t * 100 : 0, cons = new Set(historico.filter(r => r.date > addDays(tk, -14)).map(r => r.date)).size / 14 * 100;
  const sc = simulados.slice().sort((a, b) => a.date < b.date ? -1 : 1).slice(-3).map(simScore), sim = sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null;
  const dom = A.nQ >= 10 ? A.nA / A.nQ * 100 : acerto, base = sim !== null ? sim : dom;
  const score = Math.round(0.4 * acerto + 0.2 * cob + 0.2 * cons + 0.2 * base);
  const lv = score >= 75 ? 'Avançado' : score >= 60 ? 'Intermediário' : score >= 40 ? 'Em evolução' : 'Iniciante';
  const comp = [{ k: 'Acerto nas questões', v: Math.round(acerto) }, { k: 'Edital concluído', v: Math.round(cob) }, { k: 'Constância (últimos 14 dias)', v: Math.round(cons) }, { k: sim !== null ? 'Média dos simulados' : 'Acerto em questões novas', v: Math.round(base) }];
  return { ok: true, n, score, lv, comp, sim };
}
function renderTrNivel() {
  const n = nivelInfo();
  if (!n.ok) { _$('tr-nivel').innerHTML = _vazio('O nível é calculado pelos seus resultados reais. Registre pelo menos 30 questões com acertos e erros (você tem ' + n.n + ').'); return; }
  const fraco = n.comp.slice().sort((a, b) => a.v - b.v)[0], notaC = CONCURSO_INFO.notaCorte;
  _$('tr-nivel').innerHTML = `<div class="lvl"><b>${n.lv}</b><span>${n.score}/100</span></div>` + n.comp.map(c => `<div class="mbar"><span>${_xe(c.k)}</span><div><i style="width:${c.v}%"></i></div><small>${c.v}%</small></div>`).join('') +
    `<div class="rx-note" style="margin-top:8px">📌 O que mais puxa sua nota para baixo: <b>${_xe(fraco.k)}</b> (${fraco.v}%).${notaC && n.sim !== null ? ' Média dos simulados: ' + Math.round(n.sim) + '% · nota de corte informada: ' + notaC + '%.' : ''}</div>
     <div class="rx-note" style="margin-top:6px">Estimativa do app com base em ${n.n} questões e seus registros (40% acerto, 20% edital, 20% constância, 20% simulados/questões novas). Não prevê aprovação.</div>`;
}
function renderTrCfg() {
  const c = TR().cfg; let ok = 0, t = 0; EDITAL.forEach(d => { const p = discProg(d, state); ok += p.c; t += p.t; });
  const pend = t - ok, h = pend * c.mtop / 60, dEst = Math.ceil(h / c.horas), sem = Math.ceil(dEst / c.dias), dl = daysTo(CONCURSO_INFO.dataProva);
  let est = !t ? 'Cadastre as matérias do edital para estimar o tempo.' : `Faltam ${pend} de ${t} tópicos (${Math.round(ok / t * 100)}% concluído): cerca de ${Math.round(h)}h de estudo, ≈ ${sem} semana(s) neste ritmo (estimativa de ${c.mtop} min por tópico, sem contar revisões e questões).`;
  if (t && dl !== null && dl > 0) { const need = h / (dl * c.dias / 7); est += need > c.horas ? ` ⚠️ Para ver tudo até a prova (${dl} dias) seriam ~${Math.round(need * 10) / 10}h por dia de estudo.` : ` ✅ Dá para ver todo o conteúdo antes da prova (${dl} dias).`; }
  else if (t) est += ' Sem data de prova válida, o planejamento é provisório.';
  _$('tr-cfg').innerHTML = `<div class="form-grid">
    <div><label class="xlbl">Horas de estudo por dia</label><input class="man-inp" type="number" min="0.5" max="14" step="0.5" id="tr-horas" value="${c.horas}"></div>
    <div><label class="xlbl">Dias de estudo por semana</label><input class="man-inp" type="number" min="1" max="7" id="tr-dias" value="${c.dias}"></div>
    <div><label class="xlbl">Questões por dia (do tópico)</label><input class="man-inp" type="number" min="5" max="100" id="tr-qdia" value="${c.qdia}"></div></div>
    <div class="rx-note" style="margin-top:8px">${_xe(est)} Não garante aprovação.</div>
    <div class="bs-act"><button class="btn btn-navy" onclick="trSalvarCfg()">Salvar metas</button></div>`;
}
function trSalvarCfg() {
  const c = TR().cfg, n = (id, mn, mx, df) => { const v = parseFloat(vv(id)); return isNaN(v) ? df : Math.min(mx, Math.max(mn, v)); };
  c.horas = n('tr-horas', 0.5, 14, c.horas); c.dias = Math.round(n('tr-dias', 1, 7, c.dias)); c.qdia = Math.round(n('tr-qdia', 5, 100, c.qdia));
  if (plano.cron && plano.cron.cfg) { const cf = Object.assign({}, plano.cron.cfg); cf.horasDia = c.horas; cf.inicio = todayKey(); if (!cf.fim || cf.fim < cf.inicio) cf.fim = dateToKey(addDaysD(28)); const r = gerarCron(cf); if (!r.erro) { plano.cron = r; plano.metaDia = c.horas; TR().log.push({ d: todayKey(), t: 'Metas alteradas: cronograma redistribuído para ' + c.horas + 'h por dia.' }); } }
  persist(); renderTrein(); showToast('✅', 'Metas salvas. As questões por dia valem a partir de amanhã.');
}



/* ---------- Mapas mentais: meus erros · biblioteca · criar/importar ---------- */
let _mpZ = (window.innerWidth < 700 ? 0.75 : 1), _mpSvg = '', _mpTxt = '', _mpModo = 'erros';
function _wrap(s, max, lines) {
  const out = []; let cur = '';
  String(s).split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); });
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].slice(0, Math.max(1, max - 1)) + '…'; }
  return out;
}
function _acoesErro(l) {
  const pend = l.filter(e => !e.dominado).length, out = [];
  if (pend) out.push('Refazer os ' + pend + ' erro(s) pendente(s) em 2 dias diferentes');
  const seen = {}; l.forEach(e => { const d = _dica(e.motivo || ''); if (d && !seen[d] && out.length < 3) { seen[d] = 1; out.push(d); } });
  if (out.length < 3) out.push('Resolver 10 questões novas deste assunto');
  return out.slice(0, 3);
}
function mapaTree(disc) {
  const E = erros.filter(e => !disc || e.disc === disc);
  const grp = (L, f) => { const m = {}; L.forEach(e => { const k = f(e); (m[k] = m[k] || []).push(e); }); return Object.entries(m).sort((a, b) => b[1].length - a[1].length); };
  const info = L => ({ n: L.length, pend: L.filter(e => !e.dominado).length });
  const topicos = L => grp(L, e => e.topic || '(sem assunto)').slice(0, 6).map(([t, l]) => {
    const mot = grp(l, e => e.motivo || 'Motivo não informado').slice(0, 3).map(([m, ml]) => Object.assign({ t: m, kids: ml.slice().sort((a, b) => (a.date || '') < (b.date || '') ? 1 : -1).slice(0, 1).map(e => ({ t: '📌 ' + _trunc(e.regra || e.resp || e.texto || '(sem anotação)', 70), leaf: true, dom: !!e.dominado, n: 1, pend: e.dominado ? 0 : 1 })) }, info(ml)));
    const ac = { t: '✅ Como melhorar', acao: true, kids: _acoesErro(l).map(a => ({ t: '• ' + _trunc(a, 90), leaf: true, acao: true })) };
    return Object.assign({ t, kids: mot.concat([ac]) }, info(l));
  });
  const root = Object.assign({ t: disc || 'Meus erros', root: true, kids: [] }, info(E));
  root.kids = disc ? topicos(E) : grp(E, e => e.disc || 'Sem matéria').slice(0, 5).map(([d, l]) => Object.assign({ t: d, kids: topicos(l) }, info(l)));
  return { root, E };
}
function mapaBib(discNome, parte) {
  const d = EDITAL.find(x => x.nome === discNome); if (!d) return null;
  const it = bizusFor(d), P = 8, np = Math.max(1, Math.ceil(it.length / P)), p = Math.min(Math.max(0, parte || 0), np - 1), sl = it.slice(p * P, p * P + P);
  const kids = sl.map(s => { const i = s.indexOf(' — '), t = i > 0 ? s.slice(0, i) : _trunc(s, 50), x = i > 0 ? s.slice(i + 3) : ''; return { t, lib: true, w: 190, kids: x ? [{ t: x, lib: true, leaf: true, w: 330, lines: 4 }] : [] }; });
  return { root: { t: d.nome + (np > 1 ? ' · parte ' + (p + 1) + '/' + np : ''), root: true, lib: true, kids }, np, sl, total: it.length };
}
function mapaTexto(txt, titulo) {
  const L = String(txt || '').split(/\r?\n/).map(s => s.replace(/\t/g, '  ')).filter(s => s.trim()).slice(0, 150).map(s => { const m = s.match(/^(\s*)([-*•]\s*)?(.*)$/); return { ind: m[1].length, t: m[3].trim() }; }).filter(x => x.t);
  if (!L.length) return null;
  const mk = x => ({ t: _trunc(x.t, 90), lib: true, kids: [] }), minI = Math.min(...L.map(x => x.ind)), tops = L.filter(x => x.ind === minI);
  let root; const stack = [];
  if (tops.length === 1 && L[0].ind === minI) { root = Object.assign(mk(L[0]), { root: true }); stack.push({ ind: minI, n: root }); L.shift(); }
  else { root = { t: titulo || 'Meu mapa', root: true, lib: true, kids: [] }; stack.push({ ind: minI - 1, n: root }); }
  L.forEach(x => { const n = mk(x); while (stack.length > 1 && stack[stack.length - 1].ind >= x.ind) stack.pop(); stack[stack.length - 1].n.kids.push(n); stack.push({ ind: x.ind, n }); });
  (function f(n) { if (n.kids.length) { if (!n.root) n.w = 190; n.kids.forEach(f); } else if (!n.root) { n.leaf = true; n.w = 280; n.lines = 3; } })(root);
  return root;
}
function mapaSvg(root) {
  const GX = 36, H = 64, SP = 72; let leaf = 0; const nodes = [];
  (function lay(n, d) { n.d = d; nodes.push(n); if (!n.kids || !n.kids.length) { n.y = leaf * SP + 10; leaf++; } else { n.kids.forEach(k => lay(k, d + 1)); n.y = (n.kids[0].y + n.kids[n.kids.length - 1].y) / 2; } })(root, 0);
  const cw = []; nodes.forEach(n => { n.w = n.w || (n.root ? 160 : (n.leaf ? 230 : 180)); cw[n.d] = Math.max(cw[n.d] || 0, n.w); });
  const xs = [0]; for (let i = 1; i < cw.length; i++) xs[i] = xs[i - 1] + cw[i - 1] + GX;
  nodes.forEach(n => n.x = xs[n.d]);
  const W = xs[cw.length - 1] + cw[cw.length - 1] + 10, Ht = leaf * SP + 10; let s = '';
  nodes.forEach(n => (n.kids || []).forEach(k => { const x1 = n.x + n.w, y1 = n.y + H / 2, x2 = k.x, y2 = k.y + H / 2, mx = (x1 + x2) / 2; s += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#b6bcd6" stroke-width="1.6"/>`; }));
  nodes.forEach(n => {
    let fill, stroke, tc = '#0D134C';
    if (n.root) { fill = '#0D134C'; stroke = '#0D134C'; tc = '#ffffff'; }
    else if (n.acao) { fill = '#ecfccb'; stroke = '#84cc16'; }
    else if (n.lib) { fill = n.leaf ? '#ffffff' : '#eef2ff'; stroke = '#a5b4fc'; }
    else if (n.leaf) { fill = n.dom ? '#dcfce7' : '#ffffff'; stroke = n.dom ? '#86efac' : '#f87171'; }
    else { fill = n.pend === 0 ? '#dcfce7' : n.pend >= 3 ? '#fecaca' : '#fee2e2'; stroke = n.pend === 0 ? '#86efac' : '#f87171'; }
    const tl = _wrap(n.t, Math.floor(n.w / 6.2), n.lines || (n.leaf ? 3 : 2)), sub = (n.n !== undefined && !n.leaf) ? n.n + ' erro(s) · ' + n.pend + ' pend.' : '';
    s += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${H}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    tl.forEach((l, i) => { s += `<text x="${n.x + 8}" y="${n.y + 17 + i * 13}" font-size="${n.leaf ? 11 : 11.5}" font-weight="${n.leaf ? 600 : 700}" fill="${tc}">${_xe(l)}</text>`; });
    if (sub) s += `<text x="${n.x + 8}" y="${n.y + H - 8}" font-size="10" fill="${n.root ? '#cbd5ff' : '#6b7280'}">${_xe(sub)}</text>`;
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}" font-family="Inter,Arial,sans-serif"><rect width="100%" height="100%" fill="#ffffff"/>${s}</svg>`, W, Ht };
}
function mpModo(m) {
  if (m === 'bib' && !temAcesso('mapas_biblioteca')) { pedirAcesso('mapas_biblioteca'); return; }
  _mpModo = m; ['erros', 'bib', 'novo'].forEach(k => { const b = _$('mpm-' + k); if (b) b.classList.toggle('active', k === m); }); renderMapas();
}
function _mpMostra(root, legenda) {
  const m = mapaSvg(root); _mpSvg = m.svg;
  _$('mp-box').innerHTML = '<div class="mp-scroll"><div id="mp-inner" style="width:' + Math.round(m.W * _mpZ) + 'px">' + m.svg.replace(/ width="\d+" height="\d+"/, ' style="width:100%;height:auto"') + '</div></div>' + (legenda ? _leg(legenda) : '') +
    '<div class="rx-note" style="margin-top:8px">Arraste para os lados para ver tudo e use ＋ / － para ampliar.</div>';
}
function renderMapas() {
  const sel = _$('mp-disc'); if (!sel) return; const v0 = sel.value, m = _mpModo;
  sel.innerHTML = (m === 'erros' ? '<option value="">Todas as matérias</option>' : '') + EDITAL.map(d => `<option value="${escOpt(d.nome)}">${escOpt(d.nome)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === v0) ? v0 : sel.options[0].value;
  _$('mp-ctl-disc').style.display = m === 'novo' ? 'none' : ''; _$('mp-parte-wrap').style.display = m === 'bib' ? '' : 'none'; _$('mp-novo-card').style.display = m === 'novo' ? '' : 'none';
  _$('mp-titulo').textContent = m === 'erros' ? 'Mapa dos meus erros' : m === 'bib' ? 'Mapa da biblioteca' : 'Meu mapa'; _$('mp-plan-h').textContent = m === 'erros' ? '🎯 Plano de ataque' : '🧭 Como estudar com este mapa';
  _mpTxt = ''; _mpSvg = '';
  if (m === 'erros') return _mpErros(sel.value);
  if (m === 'bib') return _mpBib(sel.value);
  return _mpNovo();
}
function _mpErros(disc) {
  const { root, E } = mapaTree(disc);
  if (E.length < 3) { _$('mp-box').innerHTML = _vazio('Dados insuficientes: registre pelo menos 3 erros no Caderno de erros para gerar um mapa confiável. Você tem ' + E.length + (disc ? ' nesta matéria.' : '.')); _$('mp-plan').innerHTML = _vazio('O plano de ataque aparece aqui depois que o mapa for gerado.'); return; }
  _mpMostra(root, [['#fecaca', '3+ erros pendentes'], ['#fee2e2', '1–2 pendentes'], ['#dcfce7', 'tudo dominado'], ['#ecfccb', 'como melhorar']]);
  const tp = {}; E.forEach(e => { const k = (e.disc || 'Sem matéria') + '|' + (e.topic || '(sem assunto)'); const o = tp[k] || (tp[k] = { d: e.disc || 'Sem matéria', t: e.topic || '(sem assunto)', n: 0, p: 0, reg: '', dt: '' }); o.n++; if (!e.dominado) o.p++; const r = e.regra || e.resp; if (r && (e.date || '') >= o.dt) { o.dt = e.date || ''; o.reg = r; } });
  const top = Object.values(tp).sort((a, b) => b.p - a.p || b.n - a.n).slice(0, 6);
  _mpTxt = 'MAPA DE ERROS: ' + (disc || 'todas as matérias') + ' · ' + CONCURSO_INFO.concurso + '\n' + top.map((o, i) => (i + 1) + '. ' + o.d + ' > ' + o.t + ': ' + o.n + ' erro(s), ' + o.p + ' pendente(s)' + (o.reg ? '\n   Revisar: ' + _trunc(o.reg, 160) : '')).join('\n');
  _$('mp-plan').innerHTML = top.map((o, i) => `<div class="tr-item"><span class="tr-chk">${i + 1}</span><div class="tx"><b>${_xe(o.d)} › ${_xe(o.t)}</b><small>${o.n} erro(s) · ${o.p} pendente(s)</small>${o.reg ? '<small>📌 Revisar: ' + _xe(_trunc(o.reg, 140)) + '</small>' : ''}<small>Ação sugerida: treinar os erros pendentes deste assunto e resolver questões novas dele.</small><a class="yt" href="${_xe(ytUrl(o.t === '(sem assunto)' ? o.d : o.t))}" target="_blank" rel="noopener">▶ Aula grátis no YouTube</a></div></div>`).join('');
}
function _mpBib(disc) {
  const pr = _$('mp-parte'); const d0 = EDITAL.find(x => x.nome === disc); const np = d0 ? Math.max(1, Math.ceil(bizusFor(d0).length / 8)) : 1;
  const cur = parseInt(pr.value) || 0; pr.innerHTML = Array.from({ length: np }, (_, i) => `<option value="${i}">Parte ${i + 1} de ${np}</option>`).join(''); pr.value = Math.min(cur, np - 1);
  const r = mapaBib(disc, parseInt(pr.value) || 0);
  if (!r || !r.sl.length) { _$('mp-box').innerHTML = _vazio('Esta matéria ainda não tem conteúdo na biblioteca. Use "Criar / importar" para montar o seu mapa.'); _$('mp-plan').innerHTML = ''; return; }
  _mpMostra(r.root, null);
  _mpTxt = 'MAPA: ' + r.root.t + '\n' + r.sl.map((s, i) => (i + 1) + '. ' + s).join('\n');
  _$('mp-plan').innerHTML = '<ol class="mp-steps"><li>Leia o mapa de cima para baixo, um ramo por vez.</li><li>Cubra o mapa e tente reescrever os ramos de memória.</li><li>Marque o que errou e lance no Caderno de erros.</li><li>Revise em 1, 7 e 30 dias.</li></ol><a class="yt" href="' + _xe(ytUrl(disc)) + '" target="_blank" rel="noopener">▶ Aulas grátis de ' + _xe(disc) + ' no YouTube</a><details class="biz-box" style="margin-top:10px"><summary>Texto completo desta parte (' + r.sl.length + ')</summary><ul>' + r.sl.map(s => '<li>' + bizItemHtml(s) + '</li>').join('') + '</ul></details><div class="rx-note" style="margin-top:8px">Conteúdo do banco de bizus do app (' + r.total + ' itens nesta matéria). Confira sempre com o edital e a legislação vigente.</div>';
}
function _mpNovo() {
  const lst = plano.mapas || [];
  _$('mp-salvos').innerHTML = lst.length ? lst.map(x => `<div class="tr-h" style="grid-template-columns:1fr auto auto"><span style="font-size:13px;font-weight:700;color:var(--navy)">${_xe(x.titulo)}</span><button class="mini-btn" onclick="mpAbrir(${x.id})">Abrir</button><button class="mini-btn" onclick="mpExcluir(${x.id})">Excluir</button></div>`).join('') : '<div class="rx-note">Nenhum mapa salvo ainda.</div>';
  const txt = vv('mp-txt'), root = mapaTexto(txt, vv('mp-tit').trim());
  if (!root) { _$('mp-box').innerHTML = _vazio('Cole ou digite um texto em tópicos (use recuo para criar ramos) e toque em Gerar mapa.'); _$('mp-plan').innerHTML = '<ol class="mp-steps"><li>Escreva o tema na primeira linha.</li><li>Use 2 espaços (ou Tab) para criar um sub-ramo.</li><li>Aceita listas com "-" ou "*".</li></ol>'; return; }
  _mpMostra(root, null); _mpTxt = txt;
  _$('mp-plan').innerHTML = '<ol class="mp-steps"><li>Revise o mapa e corrija o que estiver incompleto.</li><li>Toque em Salvar para guardar no app.</li><li>Baixe o SVG para imprimir ou compartilhar.</li></ol>';
}
function mpGerarNovo() { if (!vv('mp-txt').trim()) { showToast('⚠️', 'Digite ou cole o texto do mapa.'); return; } _mpNovo(); }
function mpSalvar() {
  const txt = vv('mp-txt').trim(); if (!txt) { showToast('⚠️', 'Nada para salvar.'); return; }
  const tit = vv('mp-tit').trim() || _trunc(txt.split(/\r?\n/)[0], 40); plano.mapas = plano.mapas || []; plano.mapas.push({ id: Date.now(), titulo: tit, txt, ts: Date.now() });
  persist(); _mpNovo(); showToast('💾', 'Mapa salvo.');
}
function mpAbrir(id) { const x = (plano.mapas || []).find(m => m.id === id); if (!x) return; _$('mp-txt').value = x.txt; _$('mp-tit').value = x.titulo; _mpNovo(); }
async function mpExcluir(id) { if (!(await askConfirm('Excluir este mapa salvo?', 'Excluir'))) return; plano.mapas = (plano.mapas || []).filter(m => m.id !== id); persist(); _mpNovo(); }
function mpZoom(f) { _mpZ = Math.min(2.5, Math.max(.4, _mpZ * f)); const i = _$('mp-inner'); if (i && _mpSvg) i.style.width = Math.round((parseFloat(i.style.width) || 0) * f) + 'px'; else renderMapas(); }
function mpBaixar() {
  if (!temAcesso('mapas_exportar')) { pedirAcesso('mapas_exportar'); return; }
  if (!_mpSvg) { showToast('⚠️', 'Gere um mapa primeiro.'); return; }
  const b = new Blob([_mpSvg], { type: 'image/svg+xml' }), a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'mapa-' + _mpModo + '-' + slug(CONCURSO_INFO.concurso || 'concurso') + '.svg'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 600);
}
function mpCopiar() {
  if (!_mpTxt) { showToast('⚠️', 'Gere um mapa primeiro.'); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(_mpTxt) : Promise.reject()).then(() => showToast('📋', 'Texto copiado.')).catch(() => showToast('⚠️', 'Não foi possível copiar neste navegador.'));
}

{ const _o = renderHoje; renderHoje = function () { _o.apply(this, arguments); try { renderBusca(); } catch (e) { console.error(e); } }; }
try { renderBusca(); } catch (e) { console.error(e); }


/* ---------- Aulas gratuitas (YouTube): link de busca real; curadoria via API fica para depois ----------
   Contrato futuro: YOUTUBE.provider = { aulas: async ({tema, banca}) => [{titulo, canal, url, duracao}] } */
const YOUTUBE = { provider: null };
function ytUrl(tema) { const q = [String(tema || '').trim(), CONCURSO_INFO.banca || '', 'aula concurso'].filter(Boolean).join(' '); return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q); }

/* ---------- Raio-X: importar arquivo e (futuro) buscar dados reais por API ----------
   Contrato: RAIOX.provider = { buscar: async ({banca, cargo, concurso}) => [{disc, topic, qtd, ano, prova, fonte(URL obrigatória)}] } */
const RAIOX = { provider: null };
function rxImportarArquivo(inp) {
  const f = inp.files && inp.files[0]; if (!f) return;
  if (!temAcesso('raiox_importar')) { inp.value = ''; pedirAcesso('raiox_importar'); return; }
  if (f.size > 2e6) { showToast('⚠️', 'Arquivo grande demais (máx. 2 MB).'); inp.value = ''; return; }
  const rd = new FileReader();
  rd.onload = () => {
    let lines = [], ign = 0; const txt = String(rd.result || '');
    try {
      if (/^\s*[\[{]/.test(txt)) {
        let j = JSON.parse(txt); if (!Array.isArray(j)) j = j.itens || j.provas || [];
        j.forEach(o => { const d = o.disc || o.materia || o['matéria'], t = o.topic || o.assunto, q = parseInt(o.qtd || o.questoes || o['questões']); if (d && t && q > 0) lines.push([d, t, q, o.ano || '', o.fonte || o.url || o.source || ''].join('; ')); else ign++; });
      } else txt.split(/\r?\n/).forEach((l, i) => { if (!l.trim() || (i === 0 && /mat[eé]ria/i.test(l))) return; const p = l.split(/;|\t|,(?=\s*\d)/); if (p.length >= 3 && parseInt(p[2]) > 0) lines.push(l.replace(/\t/g, '; ')); else ign++; });
    } catch (e) { showToast('⚠️', 'Arquivo inválido: ' + e.message); inp.value = ''; return; }
    inp.value = ''; if (!lines.length) { showToast('⚠️', 'Nenhuma linha válida. Veja o formato em docs/06-RAIOX-DADOS-REAIS.md'); return; }
    _$('rxp-lote').value = lines.join('\n'); rxLote(); if (ign) showToast('ℹ️', ign + ' linha(s) ignorada(s) por estarem incompletas.');
  };
  rd.onerror = () => showToast('⚠️', 'Não foi possível ler o arquivo.'); rd.readAsText(f);
}
async function rxBuscarOnline() {
  if (!RAIOX.provider || typeof RAIOX.provider.buscar !== 'function') { showToast('🔌', 'A fonte online de dados da banca ainda não está conectada. Veja docs/06-RAIOX-DADOS-REAIS.md.'); return; }
  if (!temAcesso('raiox_importar')) { pedirAcesso('raiox_importar'); return; }
  try {
    if (!navigator.onLine) throw new Error('sem conexão');
    const r = (await RAIOX.provider.buscar({ banca: CONCURSO_INFO.banca || '', cargo: CONCURSO_INFO.cargo || '', concurso: CONCURSO_INFO.concurso || '' })) || []; let ok = 0, rej = 0;
    r.forEach(o => { const q = parseInt(o.qtd); if (o.disc && o.topic && q > 0 && /^https?:\/\//.test(o.fonte || '')) { rx().provas.push({ id: Date.now() + Math.random(), ano: parseInt(o.ano) || 0, prova: o.prova || '', disc: o.disc, topic: o.topic, qtd: q, fonte: o.fonte, origem: 'api' }); ok++; } else rej++; });
    persist(); renderRaioX(); renderHoje(); showToast('🌐', ok + ' dado(s) importado(s) com fonte' + (rej ? '; ' + rej + ' recusado(s) por faltar fonte oficial' : '') + '.');
  } catch (e) { showToast('⚠️', 'Não foi possível buscar agora (' + (e.message || 'erro') + ').'); }
}

/* ---------- Monetização (estrutura; desligada por padrão: tudo liberado) ----------
   Ligue com MONET.ativa = true só quando houver billing/anúncios reais conectados. */
const MONET = { ativa: false, plano: 'gratis', recursos: { mapas_biblioteca: 'premium', mapas_exportar: 'premium', raiox_importar: 'premium' }, nomes: { mapas_biblioteca: 'A biblioteca de mapas', mapas_exportar: 'Baixar mapas', raiox_importar: 'A importação de dados do Raio-X' } };
const ADS = { provider: null };            /* { showRewarded: async () => boolean } */
const PLANOS_LOJA = { provider: null };    /* { abrir: () => void } (Play Billing / App Store) */
function temAcesso(r) {
  if (!MONET.ativa) return true; if ((MONET.recursos[r] || 'gratis') === 'gratis' || MONET.plano !== 'gratis') return true;
  const t = (store.desbloq || {})[r]; return !!t && t > Date.now();
}
function pedirAcesso(r) {
  let o = _$('paywall'); if (!o) { o = document.createElement('div'); o.id = 'paywall'; o.className = 'pw-ov'; document.body.appendChild(o); }
  o.innerHTML = `<div class="pw-box"><h3>🔒 Recurso Premium</h3><p>${_xe(MONET.nomes[r] || r)} faz parte dos planos pagos. Você pode assistir a um anúncio para liberar por 24 horas ou assinar.</p><div class="bs-act"><button class="btn btn-lime" onclick="pwAd('${r}')">▶ Assistir anúncio (24h)</button><button class="btn btn-navy" onclick="pwPlanos()">Ver planos</button><button class="btn btn-ghost" onclick="pwFechar()">Fechar</button></div></div>`; o.style.display = 'flex';
}
function pwFechar() { const o = _$('paywall'); if (o) o.style.display = 'none'; }
async function pwAd(r) {
  if (!ADS.provider) { showToast('📺', 'Anúncios ainda não configurados neste app.'); return; }
  try { if (await ADS.provider.showRewarded()) { store.desbloq = store.desbloq || {}; store.desbloq[r] = Date.now() + 864e5; persist(); pwFechar(); showToast('🔓', 'Liberado por 24 horas.'); } else showToast('📺', 'Anúncio não concluído.'); }
  catch (e) { showToast('⚠️', 'Anúncio indisponível agora.'); }
}
function pwPlanos() { if (!PLANOS_LOJA.provider) { showToast('💳', 'As assinaturas serão ativadas quando o app estiver na loja.'); return; } PLANOS_LOJA.provider.abrir(); }

/* ═══ Armazenamento seguro (IndexedDB): encaixe com o app ═══ */
function renderArmazenamento(comEspaco) {
  const box = document.getElementById('arm-box'); if (!box || !window.Armazenamento) return;
  const s = Armazenamento.status(), hora = s.ultimoGravado ? new Date(s.ultimoGravado).toLocaleTimeString('pt-BR') : '—';
  const chip = (cl, t) => '<span class="chip ' + cl + '">' + t + '</span>';
  const linhas = [
    s.modo === 'indexeddb' ? chip('grn', 'IndexedDB ativo') : chip('yel', 'modo antigo (localStorage)'),
    s.persistente === true ? chip('grn', 'persistente') : s.persistente === false ? chip('yel', 'não persistente') : '',
    s.modo === 'indexeddb' ? (s.espelhoOk ? chip('grn', 'espelho ok') : chip('yel', 'espelho cheio (tudo no IndexedDB)')) : '',
    s.conflito ? chip('red', 'conflito: outra janela alterou os dados') : '',
    chip('', s.snapshots + ' ponto(s) de restauração')
  ].join(' ');
  box.innerHTML = '<div class="arm-t">🗄️ Armazenamento seguro</div><div class="arm-chips">' + linhas + '</div>' +
    '<div class="arm-s">' + (s.modo === 'indexeddb' ? 'Último salvamento seguro: ' + hora + ' (versão ' + s.rev + ')' : 'O IndexedDB não está ativo' + (s.erro ? ': ' + s.erro : '') + '. O app continua salvando no localStorage.') + '</div><div class="arm-s" id="arm-esp"></div>' +
    '<div class="arm-b"><button class="backup-btn-imp" onclick="armConferir()">🔍 Conferir cópia do IndexedDB</button><button class="backup-btn-imp" onclick="armPersistir()">🛡️ Pedir armazenamento persistente</button></div><div class="arm-s" id="arm-res"></div>';
  if (comEspaco) Armazenamento.estimativa().then(e => { const el = document.getElementById('arm-esp'); if (el && e) el.textContent = 'Espaço usado pelo app: ' + (e.uso / 1048576).toFixed(1) + ' MB de ' + Math.round(e.quota / 1048576) + ' MB disponíveis.'; });
}
function armConferir() {
  const r = document.getElementById('arm-res'); if (r) r.textContent = 'Conferindo…';
  Armazenamento.verificar().then(v => { if (!r) return; r.textContent = (v.ok ? '✅ ' : '⚠️ ') + v.detalhe + (v.gravado ? ' (' + resumoTxt(v.gravado) + ')' : ''); });
}
function armPersistir() { Armazenamento.pedirPersistencia().then(p => showToast(p ? '🛡️' : 'ℹ️', p ? 'Armazenamento persistente concedido: o navegador não apaga seus dados sozinho.' : 'O navegador não concedeu (instalar o app na tela inicial ajuda).')); }
if (window.Armazenamento) Armazenamento.iniciar({
  app: APP_VER,
  getStore: () => store,
  resumo: resumoStore,
  aoStatus: () => { try { renderArmazenamento(false); } catch (e) {} },
  aoHidratar: s => { store = s; migrateStore(); if (!store.concursos[store.active]) store.active = Object.keys(store.concursos)[0]; loadConcurso(store.active); persist(); refreshAll(); showToast('🗄️', 'Seus dados foram recuperados do armazenamento seguro.'); },
  aoConflito: () => showToast('⚠️', 'Outra janela do app alterou os dados. Exporte um backup e recarregue esta página antes de continuar.')
});

/* a escolha do Treinador acompanha o concurso ativo quando você troca pelo seletor do topo */
{ const _sc = switchConcurso; switchConcurso = function () { const r = _sc.apply(this, arguments); try { if (store.sel && store.sel.id && store.sel.id !== curId) selecionarAtivo(); } catch (e) { console.error(e); } return r; }; }

/* aviso quando o index.html da pasta app é aberto sozinho (sem js/ e pdfjs/ ao lado) */
window.addEventListener('load', () => { setTimeout(() => { if (typeof Armazenamento === 'undefined' || typeof EditalLeitor === 'undefined') { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#fff7ed;border:2px solid #f59e0b;border-radius:12px;padding:12px;font:13px/1.45 sans-serif;color:#7c2d12;box-shadow:0 8px 24px rgba(0,0,0,.25)'; d.innerHTML = '<b>⚠️ Você abriu o index.html da pasta app direto do celular.</b><br>Os arquivos de apoio (js/ e pdfjs/) não carregam assim, então importar edital e o armazenamento seguro não funcionam. Use o <b>rumo-a-posse.html</b> (arquivo único) ou publique a pasta <b>app</b> (Netlify).<br><button style="margin-top:8px;padding:8px 12px;border-radius:8px;border:0;background:#0D134C;color:#fff;font-weight:700" onclick="this.parentNode.remove()">Entendi</button>'; document.body.appendChild(d); } }, 600); });

/* Busca de concurso no topo (modal próprio). Usa as mesmas funções buscarConc/selecionarConc já existentes. */
function openBusca() { const m = document.getElementById('busca-modal'); if (m) m.classList.add('open'); setTimeout(() => { const i = document.getElementById('bs-q'); if (i) i.focus(); }, 60); }
function closeBusca() { const m = document.getElementById('busca-modal'); if (m) m.classList.remove('open'); }
/* "Hora de Ser Aprovado" no topo: sempre visível; acompanha o concurso ativo (horaAprovado já usa o selecionado) */
function atualizarBotaoTopo() {
  const b = document.querySelector('.top-hora'); if (!b) return;
  const s = (typeof store !== 'undefined' && store.sel) ? store.sel : null;
  b.title = s && s.nome ? 'Hora de Ser Aprovado: ' + s.nome : 'Hora de Ser Aprovado';
}

/* ═══ Ações de escolha e nota (wrappers) — helpers estão em 098-escolha-helpers.js ═══ */
/* escolha: busca, novo concurso e "Hora de Ser Aprovado" marcam o concurso como escolhido */
{ const _sc = selecionarConc; selecionarConc = function (i) {
    const r = (window._bsRes || [])[i]; if (r && r.local && r.id && store.concursos[r.id]) store.concursos[r.id].chosen = true;
    const out = _sc.apply(this, arguments); persist(); renderHoje(); return out; }; }
{ const _ha = horaAprovado; horaAprovado = function () {
    const s = store.sel; if (s && s.id && store.concursos[s.id]) { store.concursos[s.id].chosen = true; persist(); }
    return _ha.apply(this, arguments); }; }
{ const _nc = saveConcModal; saveConcModal = function () {
    const antes = new Set(Object.keys(store.concursos)); const r = _nc.apply(this, arguments);
    Object.keys(store.concursos).forEach(id => { if (!antes.has(id)) store.concursos[id].chosen = true; });
    persist(); renderConcursoSelect(); renderHoje(); return r; }; }
{ const _rp = restorePresets; restorePresets = function () {
    const r = _rp.apply(this, arguments);
    PRESETS.forEach(p => { if (store.concursos[p.id]) store.concursos[p.id].chosen = true; });
    persist(); renderHoje(); renderConcursoSelect(); return r; }; }
/* tela inicial: prova realizada pela nota, e estado vazio sem concursos escolhidos */
{ const _rh = renderHoje; renderHoje = function () {
    _rh.apply(this, arguments);
    try {
      const escolhidos = Object.keys(store.concursos).filter(id => isEscolhido(id));
      if (!escolhidos.length) {
        document.getElementById('hj-hi').textContent = 'Bem-vindo! Escolha seu concurso para começar.';
        const dn = document.getElementById('hj-cd-n'), dl = document.getElementById('hj-cd-l'); if (dn && dl) { dn.textContent = '＋'; dl.textContent = 'Escolha um concurso'; }
        const sl = document.getElementById('conc-select'); if (sl && !sl.options.length) sl.innerHTML = '<option>Nenhum concurso escolhido</option>';
        document.getElementById('hj-concs').innerHTML = '<div class="rx-note">Você ainda não escolheu nenhum concurso. Busque o seu ou crie um novo; ele aparece aqui, com o próprio progresso e nota.</div>' +
          '<div class="bs-act"><button class="btn btn-navy" onclick="openBusca()">🔎 Buscar concurso</button><button class="btn btn-ghost" onclick="openConcModal(\'new\')">＋ Novo concurso</button></div>' ;
      } else if (CONCURSO_INFO && provaRealizada(store.concursos[curId] || { info: CONCURSO_INFO })) {
        const n = document.getElementById('hj-cd-n'), l = document.getElementById('hj-cd-l');
        if (n && l) { n.textContent = '✔'; const c = store.concursos[curId]; l.textContent = (c && c.info.notaProva != null) ? 'Prova realizada · nota ' + fmtNota(c.info.notaProva) : 'Prova realizada'; }
      }
    } catch (e) { console.error(e); }
  }; }

