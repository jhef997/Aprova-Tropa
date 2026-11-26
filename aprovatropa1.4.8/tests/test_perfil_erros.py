"""Nome e foto da conta no menu; mensagens de erro claras. Usa o Supabase falso de test_login.py."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
def abrir(b,cfg):
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}"); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.add_init_script("window.__cfg=%s;"%json.dumps(cfg))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
    pg.goto(BASE,timeout=30000); pg.wait_for_timeout(1500); return ctx,pg,errs
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx,pg,errs=abrir(b,{'session':True,'meta':{'full_name':'Ana Silva','avatar_url':'data:image/gif;base64,R0lGODlhAQABAAAAACw='}})
    ok(pg.evaluate("document.getElementById('perfil-nome').textContent")=='Ana Silva','conta Google: mostra o nome da conta')
    ok(pg.evaluate("!document.getElementById('perfil-foto').hidden"),'conta Google: mostra a foto da conta')
    ok(pg.evaluate("!document.getElementById('perfil-card').hidden"),'menu Mais: cartão de perfil visível')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); ctx.close()
    ctx,pg,errs=abrir(b,{'session':True,'meta':{}})
    ok(pg.evaluate("document.getElementById('perfil-nome').textContent")=='ana','conta de e-mail sem nome: usa a parte antes do @')
    ok(pg.evaluate("document.getElementById('perfil-foto').hidden")==True and pg.evaluate("document.getElementById('perfil-ini').textContent")=='A','conta de e-mail sem foto: mostra as iniciais')
    ctx.close()
    ctx,pg,errs=abrir(b,{'loginErro':'Invalid login credentials'})
    pg.fill('#rp-auth-email','ana@teste.com'); pg.fill('#rp-auth-password','senhaerrada1'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(400)
    ok('E-mail ou senha incorretos' in pg.inner_text('#rp-auth-message'),'senha errada: mensagem em português e clara')
    ctx.close()
    ctx,pg,errs=abrir(b,{'signupErro':'User already registered'})
    pg.click('#rp-auth-signup'); pg.fill('#rp-auth-email','ana@teste.com'); pg.fill('#rp-auth-nome','Ana Teste'); pg.fill('#rp-auth-nascimento','1990-05-10'); pg.fill('#rp-auth-password','senhaboa123'); pg.fill('#rp-auth-senha2','senhaboa123'); pg.check('#rp-auth-termos'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(400)
    ok('já tem conta' in pg.inner_text('#rp-auth-message'),'cadastro com e-mail existente: avisa para entrar')
    ctx.close()
    ctx,pg,errs=abrir(b,{'resetErro':'For security purposes, you can only request this after 60 seconds'})
    pg.click('#rp-auth-reset'); pg.fill('#rp-auth-email','ana@teste.com'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(400)
    ok('Muitas tentativas' in pg.inner_text('#rp-auth-message'),'recuperar senha em excesso: pede para aguardar')
    ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
