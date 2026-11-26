"""Menu Mais novo: todas as funções continuam; perfil; backup, restauração e exclusão de dados."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
FUNCOES=['rpSair','switchTab','openBusca','openImp','openZero','restorePresets','tutMostrar','openBackupModal','triggerImport','rpBackupNuvem','rpRestaurarNuvem','rpExcluirDados']
with sync_playwright() as p:
    b=p.chromium.launch()
    def abrir(cfg,dlg=None):
        ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}"); errs=[]
        pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
        if dlg: pg.on('dialog', dlg)
        pg.add_init_script("window.__cfg=%s;"%json.dumps(cfg))
        pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
        pg.goto(BASE,timeout=30000); pg.wait_for_timeout(2000)
        pg.evaluate("document.querySelectorAll('.xmodal').forEach(m=>m.classList.remove('open'))")
        return ctx,pg,errs
    cfg={'session':True,'email':'jefferson.rogerio997@gmail.com','meta':{'full_name':'Jefferson Rogerio','avatar_url':'data:image/gif;base64,R0lGODlhAQABAAAAACw='}}
    ctx,pg,errs=abrir(cfg)
    pg.evaluate("openMais()"); pg.wait_for_timeout(200)
    ok(pg.evaluate("document.getElementById('perfil-nome').textContent")=='Jefferson Rogerio','menu: mostra o nome da conta')
    ok(pg.evaluate("document.getElementById('perfil-email').textContent")=='jefferson.rogerio997@gmail.com','menu: mostra o e-mail')
    ok(pg.evaluate("!document.getElementById('perfil-foto').hidden"),'menu: mostra a foto')
    alvos=pg.evaluate("[...document.querySelectorAll('#mais-modal button[onclick]')].map(b=>b.getAttribute('onclick'))")
    faltando=[f for f in FUNCOES if not any(f in a for a in alvos)]
    ok(not faltando,'menu: todas as funções antigas continuam acessíveis (faltando: %s)'%faltando)
    ok(pg.evaluate("[...document.querySelectorAll('#mais-modal .mx-card, #mais-modal .mx-item, #mais-modal .mx-seg-btn')].length")>=20,'menu: tem os cartões de estudo e de ferramentas')
    pg.evaluate("openMais()"); pg.click('#mais-modal .mx-card:has-text("Desempenho")'); pg.wait_for_timeout(250)
    ok(pg.evaluate("document.querySelector('.page.active').id")=='page-desempenho','cartão Desempenho abre a tela certa e fecha o menu')
    ok(not errs,'sem erro de JavaScript (%s)'%errs[:2])
    ok(pg.evaluate("document.querySelector('.mx-rodape').textContent").startswith('Versão'),'menu: mostra a versão (não o nome)')
    ok(pg.evaluate("document.querySelector('.mx-banner #perfil-nome').textContent")=='Jefferson Rogerio','menu: banner mostra o nome da conta')
    ok(pg.evaluate("document.querySelectorAll('#mais-modal .mx-card').length")==12,'menu: grade com os 12 cartões da imagem')
    ok(pg.evaluate("document.querySelectorAll('#mais-modal .mx-item .mx-ico').length")==6,'menu: itens de Outras ferramentas têm ícone')
    ok(pg.evaluate("!!document.querySelector('.mod-grid') && document.querySelectorAll('.mod-tile').length==2"),'tela inicial: grade com 2 cartões (sem repetições)')
    ok(pg.evaluate("document.querySelectorAll('.tab-btn').length==0"),'topo: sem a barra de abas repetida')
    ok(pg.evaluate("!document.querySelector('.sb-footer .btn-backup') && !!document.getElementById('import-file')"),'lateral: sem botões repetidos de backup, campo de importação mantido')
    # backup na nuvem
    pg.evaluate("window.__calls.length=0"); pg.evaluate("openMais()"); pg.click('#mais-modal .mx-seg-btn:has-text(\"Backup na nuvem\")'); pg.wait_for_timeout(600)
    ok(any(c[0]=='upsert' for c in pg.evaluate("window.__calls")),'Backup na nuvem: salva na conta')
    ctx.close()
    # excluir dados: sem confirmar não apaga
    ctx,pg,errs=abrir(cfg,dlg=lambda d: d.accept('nao'))
    pg.evaluate("window.__calls.length=0"); pg.evaluate("openMais()"); pg.click('#mais-modal .mx-seg-btn:has-text(\"Excluir dados\")'); pg.wait_for_timeout(400)
    ok(not any(c[0]=='delete' for c in pg.evaluate("window.__calls")),'Excluir: sem digitar EXCLUIR, nada é apagado')
    ctx.close()
    # excluir dados: confirmado apaga na conta e volta à tela de acesso
    ctx,pg,errs=abrir(cfg,dlg=lambda d: d.accept('EXCLUIR') if d.type=='prompt' else d.accept())
    pg.evaluate("localStorage.setItem('__fake_db', JSON.stringify({concursos:{}}))")
    pg.evaluate("openMais()"); pg.click('#mais-modal .mx-seg-btn:has-text(\"Excluir dados\")'); pg.wait_for_timeout(2500)
    ok(pg.evaluate("localStorage.getItem('__fake_db')")==None,'Excluir confirmado: apaga os dados da conta na nuvem')
    ok(pg.evaluate("!document.getElementById('rp-auth-screen').hidden"),'Excluir confirmado: volta para a tela de acesso')
    # excluir conta: apaga a conta pela função do banco e volta à tela de acesso
    ctx,pg,errs=abrir(cfg,dlg=lambda d: d.accept('EXCLUIR CONTA') if d.type=='prompt' else d.accept())
    pg.evaluate("localStorage.setItem('__fake_db', JSON.stringify({concursos:{}}))")
    pg.evaluate("openMais()"); pg.click('#mais-modal .mx-seg-btn:has-text(\"Excluir Dados\")'); pg.wait_for_timeout(2500)
    ok(pg.evaluate("!!document.getElementById('rp-auth-screen') && !document.getElementById('rp-auth-screen').hidden"),'Excluir conta: volta para a tela de acesso')
    ok(pg.evaluate("localStorage.getItem('__fake_db')")==None,'Excluir conta: apaga os dados da nuvem')
    ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
