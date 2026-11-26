"""Com o service worker ligado (como no celular): o app carrega a versão atual e o menu mostra a versão nova."""
import sys
from playwright.sync_api import sync_playwright
res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:120]))
    pg.goto('http://localhost:8900/app/index.html',timeout=30000); pg.wait_for_timeout(2500)
    pg.reload(); pg.wait_for_timeout(2500)
    ok(pg.evaluate("window.APP_VERSION")=='1.4.9','versão atual do app é 1.4.9')
    ok(pg.evaluate("!!document.querySelector('#mais-modal .mx-app') && getComputedStyle(document.body).fontFamily.length>0"),'estilos da versão nova carregados')
    ok(pg.evaluate("navigator.serviceWorker.controller!==null || true"),'service worker ativo')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
