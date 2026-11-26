"""Busca online: só fontes oficiais; erro da API é avisado; nada é inventado. API simulada (a sandbox não acessa a internet)."""
import json, sys
from playwright.sync_api import sync_playwright
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
DADOS={'sucesso':True,'total':3,'dados':[
  {'id':'1','titulo':'Concurso Guarda Municipal Teste','orgao':'Prefeitura Teste','cargo':'Guarda','banca':'Banca X','situacao':'ABERTO','linkFonte':'https://www.prefeitura.gov.br/edital.pdf','fonteOrigem':'Base Local','atualizadoEm':'2026-11-20T10:00:00Z'},
  {'id':'2','titulo':'Concurso vindo de agregador','orgao':'Órgão Y','cargo':'Agente','banca':'Banca Z','situacao':'ABERTO','linkFonte':'https://www.pcisite.com.br/x','fonteOrigem':'PCI Concursos (Ao Vivo)','atualizadoEm':'2026-11-19T10:00:00Z'},
  {'id':'3','titulo':'Sem link oficial','orgao':'Órgão W','cargo':'Auxiliar','banca':'Banca V','situacao':'ABERTO','linkFonte':'http://insegura.exemplo/x','fonteOrigem':'Base Local','atualizadoEm':'2026-11-18T10:00:00Z'}]}
with sync_playwright() as p:
    b=p.chromium.launch()
    def abrir(status=200):
        ctx=b.new_context(viewport={'width':390,'height':800},service_workers='block'); pg=ctx.new_page(); errs=[]
        pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
        pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}")
        pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.abort())
        def api(route):
            if status==200: route.fulfill(status=200,content_type='application/json',body=json.dumps(DADOS))
            else: route.fulfill(status=status,content_type='application/json',body='{"erro":"x"}')
        pg.route('https://api-busca-concursos.onrender.com/**', api)
        pg.goto(BASE,timeout=30000); pg.wait_for_timeout(1200)
        pg.evaluate("document.querySelectorAll('.xmodal').forEach(m=>m.classList.remove('open'))")
        return ctx,pg,errs
    ctx,pg,errs=abrir()
    pg.evaluate("openBusca()"); pg.fill('#bs-q','guarda'); pg.evaluate("void buscarConc()"); pg.wait_for_timeout(800)
    nomes=pg.evaluate("[...document.querySelectorAll('#bs-res .bs-t')].map(e=>e.textContent)")
    ok('Concurso Guarda Municipal Teste' in nomes,'busca online: traz o resultado oficial')
    ok(not any('agregador' in n for n in nomes),'busca online: descarta agregador (PCI)')
    ok(not any('Sem link oficial' in n for n in nomes),'busca online: descarta link sem https')
    pg.evaluate("selecionarConc((window._bsRes||[]).findIndex(r=>r.nome==='Concurso Guarda Municipal Teste'))"); pg.wait_for_timeout(200)
    ok(pg.evaluate("store.sel && store.sel.fonte")=='https://www.prefeitura.gov.br/edital.pdf','selecionar: guarda o link oficial da fonte')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); ctx.close()
    ctx,pg,errs=abrir(status=500)
    pg.evaluate("openBusca()"); pg.fill('#bs-q','guarda'); pg.evaluate("void buscarConc()"); pg.wait_for_timeout(800)
    ok('não respondeu' in pg.inner_text('#bs-res'),'API com erro: avisa e não inventa resultados')
    ok('Concurso Guarda Municipal Teste' not in pg.inner_text('#bs-res'),'API com erro: nenhum resultado online aparece')
    ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
