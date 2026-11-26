/* Busca online de concursos (fonte: API própria).
   Só mostra resultados de fonte OFICIAL: link https obrigatório e sem agregadores (ex.: PCI).
   Se a API não estiver configurada, a busca continua só com os concursos cadastrados. */
(function () {
  'use strict';
  var API_BASE = 'https://api-busca-concursos.onrender.com';   // URL pública da sua API
  var LIMITE = 20;

  function pick(x, chaves) { for (var i = 0; i < chaves.length; i++) { if (x[chaves[i]] != null && x[chaves[i]] !== '') return x[chaves[i]]; } return ''; }
  function oficial(x) {
    var url = String(pick(x, ['linkFonte', 'link', 'url', 'fonte']));
    var origem = String(pick(x, ['fonteOrigem', 'origem', 'fonte_origem']));
    if (!/^https:\/\//.test(url)) return false;                 // sem link oficial, não entra
    if (/pci/i.test(origem) || /pci/i.test(url)) return false;  // agregador: fora
    return true;
  }
  function mapear(x) {
    var nome = pick(x, ['titulo', 'nome', 'concurso', 'cargo']) || 'Concurso';
    return {
      nome: nome,
      orgao: pick(x, ['orgao', 'órgão']),
      cargo: pick(x, ['cargo']),
      banca: pick(x, ['banca']),
      situacao: pick(x, ['situacao', 'situação', 'status']),
      dataPub: String(pick(x, ['atualizadoEm', 'atualizado_em', 'dataPub'])).slice(0, 10),
      url: pick(x, ['linkFonte', 'link', 'url', 'fonte']),
      tipo: 'online'
    };
  }
  async function buscar(q) {
    var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 30000);
    var r;
    try {
      r = await fetch(API_BASE + '/concursos?busca=' + encodeURIComponent(q) + '&limite=' + LIMITE,
        { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('a API demorou para responder (no plano gratuito ela pode estar "acordando"; tente de novo em 1 minuto)');
      throw e;
    } finally { clearTimeout(t); }
    if (!r.ok) throw new Error('a API respondeu ' + r.status);
    var j = await r.json();
    var lista = (j && (j.dados || j.concursos || j.resultados)) || [];
    if (!Array.isArray(lista)) lista = [];
    return lista.filter(oficial).map(mapear);
  }
  if (typeof BUSCA !== 'undefined' && API_BASE) BUSCA.provider = { search: buscar };
  window.rpBuscaOnlineMapear = mapear;   // para testes
  window.rpBuscaOnlineOficial = oficial;
})();
