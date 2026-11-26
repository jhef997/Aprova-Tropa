"""A pergunta de sincronização aparece só quando os dados realmente divergem, e não se repete depois da escolha."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
BASE='http://localhost:8900/app/index.html'; res=[]
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
def hist(id_,disc): return [{'id':id_,'date':'2026-01-01','horas':1,'questoes':5,'acertos':3,'erros':2,'disc':disc}]
def conta(h): return {'v':2,'active':'pm-ma','concursos':{'pm-ma':{'id':'pm-ma','info':{'concurso':'PM MA','prazo':'curto'},'edital':[],'data':{'state':{},'historico':h,'revisoes':[],'simulados':[],'erros':[],'plano':{}}}}}
def abrir(b,cfg,resposta):
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,service_workers='block'); pg=ctx.new_page(); dl=[]
    pg.on('dialog', lambda d: (dl.append(d.message[:20]), d.accept() if resposta=='ok' else d.dismiss()))
    pg.add_init_script("window.__cfg=%s;"%json.dumps(cfg))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
    pg.goto(BASE,timeout=30000); pg.wait_for_timeout(2200); return ctx,pg,dl
with sync_playwright() as p:
    b=p.chromium.launch()
    # 1) conta com dados, aparelho vazio: baixa sem perguntar
    ctx,pg,dl=abrir(b,{'session':True,'remoto':conta(hist(1,'X'))},'ok')
    ok(len(dl)==0 and pg.evaluate("historico.length")==1,'aparelho vazio: baixa a conta sem perguntar')
    pg.reload(); pg.wait_for_timeout(2200); ok(len(dl)==0,'recarregar depois disso não pergunta')
    ctx.close()
    # 2) dados diferentes de verdade: pergunta UMA vez; OK = usar a conta; depois não repete
    ctx,pg,dl=abrir(b,{'session':True,'remoto':None},'ok')
    pg.evaluate("store.concursos['pm-ma'].data.historico.push({id:9,date:'2026-02-02',horas:1,questoes:1,acertos:1,erros:0,disc:'Local'});persist();")
    pg.wait_for_timeout(2500)
    pg.evaluate("localStorage.setItem('__fake_db', JSON.stringify(%s))" % json.dumps(conta(hist(1,'Conta'))))
    pg.reload(); pg.wait_for_timeout(2500)
    ok(len(dl)==1,'dados diferentes: pergunta uma vez')
    ok(pg.evaluate("store.concursos['pm-ma'].data.historico.some(r=>r.disc==='Conta')"),'OK: passa a usar os dados da conta')
    pg.reload(); pg.wait_for_timeout(2500); pg.reload(); pg.wait_for_timeout(2500)
    ok(len(dl)==1,'depois da escolha, recarregar não pergunta de novo')
    ctx.close()
    # 3) cancelar = manter o aparelho e enviar para a conta; depois não repete
    ctx,pg,dl=abrir(b,{'session':True,'remoto':None},'cancel')
    pg.evaluate("store.concursos['pm-ma'].data.historico.push({id:9,date:'2026-02-02',horas:1,questoes:1,acertos:1,erros:0,disc:'Local'});persist();")
    pg.wait_for_timeout(2500)
    pg.evaluate("localStorage.setItem('__fake_db', JSON.stringify(%s))" % json.dumps(conta(hist(1,'Conta'))))
    pg.reload(); pg.wait_for_timeout(2500)
    ok(len(dl)==1 and pg.evaluate("store.concursos['pm-ma'].data.historico.some(r=>r.disc==='Local')"),'Cancelar: mantém os dados deste aparelho')
    pg.reload(); pg.wait_for_timeout(2500)
    ok(len(dl)==1,'depois de cancelar, recarregar não pergunta de novo')
    ctx.close(); b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
