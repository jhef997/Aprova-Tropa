"""Logado, percorre todas as telas e os botões principais e procura erros de JavaScript."""
import json, sys
from playwright.sync_api import sync_playwright
src=open('/home/claude/login-app/tests/test_login.py',encoding='utf-8').read()
FAKE=src.split('FAKE_LIB = r"""')[1].split('"""')[0]
TABS=['hoje','estudos','edital','cronograma','revisoes','desempenho','simulados','erros','cruzar','raiox','historico','bizus','treinador','mapas']
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.add_init_script("window.__cfg=%s;"%json.dumps({'session':True,'remoto':None}))
    pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200,content_type='application/javascript',body=FAKE))
    pg.goto('http://localhost:8900/app/index.html',timeout=30000); pg.wait_for_timeout(2500)
    pg.evaluate("document.querySelectorAll('.xmodal').forEach(m=>m.classList.remove('open'))")
    ok_tabs=0
    for t in TABS:
        pg.evaluate(f"switchTab('{t}')"); pg.wait_for_timeout(120)
        if pg.evaluate("document.querySelector('.page.active') && document.querySelector('.page.active').id")=='page-'+t: ok_tabs+=1
    print(f'telas abertas: {ok_tabs}/{len(TABS)}')
    print('erros de JavaScript:', errs[:3] or 'nenhum')
    b.close()
    sys.exit(0 if (ok_tabs==len(TABS) and not errs) else 1)
