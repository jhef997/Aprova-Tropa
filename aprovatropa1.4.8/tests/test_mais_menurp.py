"""Menu Mais no layout MenuRP: cada ação chama a função existente; conta; navegação; dados."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
with sync_playwright() as p:
    b=p.chromium.launch()
    def abrir(cfg,dlg=None):
        ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}"); errs=[]
        pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
        if dlg: pg.on('dialog',dlg)
        pg.add_init_script("window.__cfg=%s;"%json.dumps(cfg))
        pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
        pg.goto(BASE,timeout=30000); pg.wait_for_timeout(2000)
        pg.evaluate("document.querySelectorAll('.xmodal').forEach(m=>m.classList.remove('open'))")
        return ctx,pg,errs
    cfg={'session':True,'email':'jefferson.rogerio997@gmail.com','meta':{'full_name':'Jefferson Rogerio','avatar_url':'data:image/gif;base64,R0lGODlhAQABAAAAACw='}}
    ctx,pg,errs=abrir(cfg)
    pg.evaluate("openMais()"); pg.wait_for_timeout(200)
    ok(pg.evaluate("document.getElementById('perfil-nome').textContent")=='Jefferson Rogerio','menu: nome da conta')
    ok(pg.evaluate("document.getElementById('perfil-email').textContent")=='jefferson.rogerio997@gmail.com','menu: e-mail da conta')
    ok(pg.evaluate("!document.getElementById('perfil-foto').hidden"),'menu: foto da conta')
    acoes=pg.evaluate("[...document.querySelectorAll('#mais-modal [data-action]')].map(b=>({a:b.dataset.action,oc:b.getAttribute('onclick')||''}))")
    faltam=[x['a'] for x in acoes if not x['oc']]
    ok(len(acoes)>=20 and not faltam,'menu: todas as ações têm função ligada (%d botões)'%len(acoes))
    nomes=pg.evaluate("""(acoes=>{const fs=[];return acoes.map(x=>{const m=x.oc.match(/(?:closeMais\\(\\);)?([A-Za-z_]\\w*)\\s*\\(/);return m?m[1]:'';}).filter(f=>f&&typeof window[f]!=='function')})""", acoes)
    ok(not nomes,'menu: todas as funções chamadas existem (faltando: %s)'%nomes)
    ok(pg.evaluate("document.querySelector('#mais-modal .mx-app .count') && true"),'menu: contagem de ferramentas por seção')
    ok(pg.evaluate("document.querySelector('.mx-rodape').textContent").startswith('Versão'),'menu: rodapé com a versão')
    pg.click('#mais-modal .item:has-text("Desempenho")'); pg.wait_for_timeout(300)
    ok(pg.evaluate("document.querySelector('.page.active').id")=='page-desempenho' and not pg.evaluate("document.getElementById('mais-modal').classList.contains('open')"),'Desempenho: abre a tela e fecha o menu')
    pg.evaluate("openMais()"); pg.click('#mais-modal .close'); pg.wait_for_timeout(150)
    ok(not pg.evaluate("document.getElementById('mais-modal').classList.contains('open')"),'botão fechar: fecha o menu')
    pg.evaluate("window.__calls.length=0; openMais()"); pg.evaluate("document.querySelector('#mais-modal [data-action=\"backup\"]').click()"); pg.wait_for_timeout(600)
    ok(any(c[0]=='upsert' for c in pg.evaluate("window.__calls")),'Backup (nuvem): salva na conta')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2]); ctx.close()
    # excluir dados: sem palavra não apaga
    ctx,pg,errs=abrir(cfg,dlg=lambda d: d.accept('nao'))
    pg.evaluate("window.__calls.length=0; openMais()"); pg.click('#mais-modal .danger-btn'); pg.wait_for_timeout(400)
    ok(not any(c[0]=='delete' for c in pg.evaluate("window.__calls")),'Excluir dados: sem confirmar, nada é apagado')
    ctx.close()
    # sair da conta: volta para a tela de acesso
    ctx,pg,errs=abrir(cfg)
    pg.evaluate("openMais()"); pg.click('#mais-modal .logout'); pg.wait_for_timeout(1500)
    ok(pg.evaluate("!document.getElementById('rp-auth-screen').hidden"),'Sair da conta: volta para a tela de acesso')
    ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
