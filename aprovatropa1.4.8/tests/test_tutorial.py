"""Tutorial de primeira instalação: aparece uma vez, navega, pode ser pulado e não tem entrada no menu."""
import sys
from playwright.sync_api import sync_playwright
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.abort())
    pg.goto(BASE,timeout=30000); pg.wait_for_timeout(1200); pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(1200)
    ok(pg.evaluate("!!document.getElementById('onb')"),'primeira vez: tutorial aparece')
    ok(pg.evaluate("document.getElementById('onb-cont').textContent")=='1 de 9','tutorial: começa em "1 de 8"')
    ok(pg.evaluate("getComputedStyle(document.getElementById('onb-voltar')).visibility")=='hidden','tutorial: "Voltar" escondido no primeiro passo')
    pg.click('#onb-prox'); pg.wait_for_timeout(100)
    ok(pg.evaluate("document.getElementById('onb-cont').textContent")=='2 de 9' and 'concurso' in pg.inner_text('#onb-t').lower(),'tutorial: "Próximo" avança com o conteúdo do passo')
    pg.click('#onb-voltar'); pg.wait_for_timeout(100)
    ok(pg.evaluate("document.getElementById('onb-cont').textContent")=='1 de 9','tutorial: "Voltar" retorna')
    ok(pg.evaluate("document.querySelectorAll('#onb-pontos i').length")==9,'tutorial: 9 marcadores de progresso')
    pg.click('#onb-pular'); pg.wait_for_timeout(150)
    ok(not pg.evaluate("!!document.getElementById('onb')"),'Pular: fecha o tutorial')
    ok(pg.evaluate("localStorage.getItem('rp-onb-v1')")=='1','Pular: grava que já foi visto')
    pg.reload(); pg.wait_for_timeout(1200)
    ok(not pg.evaluate("!!document.getElementById('onb')"),'depois de pular, não aparece de novo')
    ok(not pg.evaluate("/ver tutorial/i.test(document.getElementById('mais-modal').textContent)"),'menu Mais: sem entrada para o tutorial')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); ctx.close()
    # percorrer até o fim
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,service_workers='block'); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.abort())
    pg.goto(BASE,timeout=30000); pg.wait_for_timeout(1200); pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(1200)
    for _ in range(8): pg.click('#onb-prox')
    ok(pg.evaluate("document.getElementById('onb-prox').textContent")=='Começar','último passo: botão vira "Começar"')
    pg.click('#onb-prox'); pg.wait_for_timeout(150)
    ok(not pg.evaluate("!!document.getElementById('onb')") and pg.evaluate("localStorage.getItem('rp-onb-v1')")=='1','concluir o tutorial: fecha e não volta')
    ok(not errs,'sem erro de JavaScript ao concluir (%s)'%errs[:2]); ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
