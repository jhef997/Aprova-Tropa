"""No celular, logado: nome, e-mail e foto aparecem na tela inicial."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.add_init_script("window.__cfg=%s;"%json.dumps({'session':True,'email':'ana@teste.com','meta':{'full_name':'Ana Silva','avatar_url':'data:image/gif;base64,R0lGODlhAQABAAAAACw='}}))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
    pg.goto('http://localhost:8900/app/index.html',timeout=30000); pg.wait_for_timeout(2000)
    ok(pg.evaluate("!document.getElementById('perfil-home').hidden"),'tela inicial: cartão de perfil visível')
    ok(pg.evaluate("document.getElementById('perfil-home-nome').textContent")=='Ana Silva','tela inicial: mostra o nome')
    ok(pg.evaluate("document.getElementById('perfil-home-email').textContent")=='ana@teste.com','tela inicial: mostra o e-mail')
    ok(pg.evaluate("!document.getElementById('perfil-home-foto').hidden"),'tela inicial: mostra a foto')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
