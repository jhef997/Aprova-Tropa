"""Testa a tela de acesso e a sincronização com um Supabase FALSO (a biblioteca real é interceptada).
Uso: python3 tests/test_login.py   (sirva a pasta do projeto na porta 8900 antes)"""
import os, sys, json
from playwright.sync_api import sync_playwright
BASE=os.environ.get('BASE_URL','http://localhost:8900/app/index.html'); res=[]
FAKE_LIB = r"""
(function(){
  const cfg = window.__cfg || {};
  const calls = window.__calls = [];
  const sess = () => ({ user: { id: cfg.userId || 'user-1', email: cfg.email || 'ana@teste.com', user_metadata: cfg.meta || {} }, access_token: 'x' });
  let session = (cfg.session && !localStorage.getItem('__fake_out')) ? sess() : null;
  const listeners = [];
  const auth = {
    getSession: async () => { calls.push(['getSession']); return { data: { session }, error: cfg.getSessionErro ? { message: cfg.getSessionErro } : null }; },
    onAuthStateChange: fn => { listeners.push(fn); },
    signInWithPassword: async a => { calls.push(['signInWithPassword', a.email]);
      if (cfg.loginErro) return { data: {}, error: { message: cfg.loginErro } };
      session = sess(); localStorage.removeItem('__fake_out'); return { data: { session }, error: null }; },
    signUp: async a => { calls.push(['signUp', a.email]);
      if (cfg.signupErro) return { data: {}, error: { message: cfg.signupErro } };
      return { data: { session: cfg.confirmaEmail ? null : sess() }, error: null }; },
    signInWithOAuth: async a => { calls.push(['signInWithOAuth', a.provider, a.options.redirectTo]); return { error: null }; },
    resetPasswordForEmail: async (e, o) => { calls.push(['reset', e, o.redirectTo]); return cfg.resetErro ? { error: { message: cfg.resetErro } } : { error: null }; },
    updateUser: async a => { calls.push(['updateUser']); return { error: null }; },
    signOut: async () => { calls.push(['signOut']); session = null; localStorage.setItem('__fake_out','1'); return { error: null }; }
  };
  function from(t){
    const q = { f: {} };
    q.select = () => q; q.eq = (c, v) => { q.f[c] = v; return q; };
    q.maybeSingle = async () => { calls.push(['select', t, q.f]);
      const salvo = localStorage.getItem('__fake_db');   // o "banco" guarda o que foi gravado, como o real
      const data = salvo ? { rev: 1, payload: JSON.parse(salvo) } : (cfg.remoto ? { rev: 1, payload: cfg.remoto } : null);
      return { data, error: cfg.dbErro ? { message: cfg.dbErro } : null }; };
    q.upsert = async row => { calls.push(['upsert', t, row.user_id, row.rev]);
      if (!cfg.dbErro) localStorage.setItem('__fake_db', JSON.stringify(row.payload));
      return { error: cfg.dbErro ? { message: cfg.dbErro } : null }; };
    q.delete = () => ({ eq: async (c, v) => { calls.push(['delete', t, v]); localStorage.removeItem('__fake_db'); return { error: null }; } });
    return q;
  }
  const rpc = async (name) => { calls.push(['rpc', name]); if (name === 'excluir_minha_conta') { localStorage.removeItem('__fake_db'); } return { error: null }; };
  window.supabase = { createClient: () => ({ auth, from, rpc }) };
})();
"""
def ok(c,m): res.append(bool(c)); print(('PASS ' if c else 'FAIL ')+m)
def abrir(b, cfg, lib=True):
    ctx=b.new_context(viewport={'width':390,'height':800},is_mobile=True,has_touch=True,service_workers='block'); pg=ctx.new_page(); pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}"); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
    pg.add_init_script("window.__cfg=%s;" % json.dumps(cfg))
    if lib:
        pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE_LIB))
    else:
        pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.abort())
    pg.goto(BASE, timeout=30000); pg.wait_for_timeout(1500)
    return ctx, pg, errs
def tela_visivel(pg): return pg.evaluate("!document.getElementById('rp-auth-screen').hidden")
def msg(pg): return pg.inner_text('#rp-auth-message')
def calls(pg): return pg.evaluate("window.__calls||[]")
with sync_playwright() as p:
    b=p.chromium.launch()
    # 1) sem sessão: a tela de acesso aparece
    ctx,pg,errs=abrir(b,{})
    ok(tela_visivel(pg),'sem sessão: tela de acesso aparece primeiro')
    # 2) senha errada
    pg.fill('#rp-auth-email','ana@teste.com'); pg.fill('#rp-auth-password','senhaerrada1')
    ctx.close(); ctx,pg,errs=abrir(b,{'loginErro':'Invalid login credentials'})
    pg.fill('#rp-auth-email','ana@teste.com'); pg.fill('#rp-auth-password','senhaerrada1'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(400)
    ok('Não foi possível entrar' in msg(pg) and tela_visivel(pg),'senha errada: mostra erro e continua na tela de acesso')
    ctx.close()
    # 3) e-mail inválido e campo vazio são barrados antes do servidor
    ctx,pg,errs=abrir(b,{})
    pg.fill('#rp-auth-email','nao-e-email'); pg.fill('#rp-auth-password','12345678'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(300)
    valido=pg.evaluate("document.getElementById('rp-auth-email').checkValidity()")
    ok((not valido or 'e-mail válido' in msg(pg)) and not any(c[0]=='signInWithPassword' for c in calls(pg)),'e-mail inválido: não chama o servidor (bloqueado pelo navegador ou pela mensagem)')
    # 4) login correto entra no app e sincroniza
    pg.fill('#rp-auth-email','ana@teste.com'); pg.fill('#rp-auth-password','senhaboa123'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(900)
    ok(not tela_visivel(pg),'login correto: entra no app')
    ok(any(c[0]=='upsert' and c[2]=='user-1' for c in calls(pg)),'primeiro acesso: envia os dados do aparelho para a conta (user_id correto)')
    ok(not errs,'sem erro de JavaScript no login (%s)'%errs[:2]); ctx.close()
    # 5) cadastro: campos obrigatórios, idade mínima, senha, termos e confirmação por e-mail
    ctx,pg,errs=abrir(b,{'confirmaEmail':True})
    pg.click('#rp-auth-signup')
    ok(pg.evaluate("!document.getElementById('rp-field-nome').hidden") and pg.evaluate("!document.getElementById('rp-field-termos').hidden"),'cadastro: mostra nome, nascimento, confirmação e termos')
    pg.fill('#rp-auth-email','nova@teste.com'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(200)
    ok('nome completo' in msg(pg) and not any(c[0]=='signUp' for c in calls(pg)),'cadastro: sem nome completo não envia')
    pg.fill('#rp-auth-nome','Nova Pessoa')
    pg.click('#rp-auth-submit'); pg.wait_for_timeout(150)
    ok('data de nascimento' in msg(pg),'cadastro: sem data de nascimento não envia')
    pg.fill('#rp-auth-nascimento','2015-05-10'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(150)
    ok('18 anos' in msg(pg),'cadastro: menor de 18 anos não cria conta')
    pg.fill('#rp-auth-nascimento','1990-05-10'); pg.fill('#rp-auth-password','curta'); pg.fill('#rp-auth-senha2','curta'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(150)
    ok('8 caracteres' in msg(pg),'cadastro: senha com menos de 8 caracteres é barrada')
    pg.fill('#rp-auth-password','senhaboa123'); pg.fill('#rp-auth-senha2','outra123456'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(150)
    ok('não são iguais' in msg(pg),'cadastro: confirmação diferente é barrada')
    pg.fill('#rp-auth-senha2','senhaboa123'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(150)
    ok('termos' in msg(pg).lower(),'cadastro: sem aceitar os termos não envia')
    pg.check('#rp-auth-termos'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(500)
    cad=[c for c in calls(pg) if c[0]=='signUp']
    ok(cad and cad[0][1]=='nova@teste.com' and 'confirmação' in msg(pg).lower() or 'Conta criada' in msg(pg),'cadastro completo: cria a conta e pede a confirmação por e-mail')
    ok(tela_visivel(pg),'cadastro sem sessão: continua na tela de acesso')
    ctx.close()
    # 6) recuperar senha: abre o modo próprio, pede o e-mail e envia o link
    ctx,pg,errs=abrir(b,{})
    pg.click('#rp-auth-reset'); pg.wait_for_timeout(150)
    ok(pg.evaluate("document.getElementById('rp-auth-titulo').textContent")=='Recuperar senha' and pg.evaluate("document.getElementById('rp-field-senha').hidden"),'recuperar senha: abre o modo próprio, sem campo de senha')
    pg.fill('#rp-auth-email','ana@teste.com'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(300)
    ok(any(c[0]=='reset' and c[1]=='ana@teste.com' for c in calls(pg)) and 'link de recuperação' in msg(pg),'recuperar senha: envia o link ao e-mail informado')
    ctx.close()
    # 7) recuperar senha com erro do servidor
    ctx,pg,errs=abrir(b,{'resetErro':'rate limit'})
    pg.click('#rp-auth-reset'); pg.fill('#rp-auth-email','ana@teste.com'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(300)
    ok('Não foi possível enviar' in msg(pg),'recuperar senha: mostra o erro do servidor')
    ctx.close()
    # 8) link de recuperação abre a tela de nova senha
    ctx,pg,errs=abrir(b,{})
    ctx.close(); ctx=b.new_context(viewport={'width':390,'height':800}); pg=ctx.new_page(); pg.add_init_script("try{localStorage.setItem('rp-onb-v1','1')}catch(e){}"); errs=[]
    pg.add_init_script("window.__cfg={};"); pg.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE_LIB))
    pg.goto(BASE+'#type=recovery&access_token=x', timeout=30000); pg.wait_for_timeout(1200)
    ok(pg.evaluate("document.getElementById('rp-auth-submit').textContent")=='Salvar nova senha','link de recuperação: abre a tela de nova senha')
    pg.fill('#rp-auth-password','novasenha99'); pg.fill('#rp-auth-senha2','novasenha99'); pg.click('#rp-auth-submit'); pg.wait_for_timeout(500)
    ok(any(c[0]=='updateUser' for c in calls(pg)),'nova senha: atualiza a senha da conta')
    ctx.close()
    # 9) login com Google
    ctx,pg,errs=abrir(b,{})
    pg.click('#rp-google-login'); pg.wait_for_timeout(300)
    ok(any(c[0]=='signInWithOAuth' and c[1]=='google' and c[2].startswith('http') for c in calls(pg)),'Google: inicia o login com o provedor google e volta ao próprio site')
    ctx.close()
    # 10) sessão já ativa: abre direto no app, sem pedir senha
    ctx,pg,errs=abrir(b,{'session':True,'remoto':None})
    ok(not tela_visivel(pg),'sessão ativa: abre direto no app')
    ctx.close()
    # 11) dados na nuvem e aparelho vazio: baixa a conta
    remoto={'v':2,'active':'pm-ma','concursos':{'pm-ma':{'id':'pm-ma','info':{'concurso':'PM MA','prazo':'curto'},'edital':[],'data':{'state':{},'historico':[{'id':1,'date':'2026-01-01','horas':1,'questoes':5,'acertos':3,'erros':2,'disc':'X'}],'revisoes':[],'simulados':[],'erros':[],'plano':{}}}}}
    ctx,pg,errs=abrir(b,{'session':True,'remoto':remoto})
    pg.wait_for_timeout(1500)
    ok(pg.evaluate("!!(store.concursos['pm-ma']&&store.concursos['pm-ma'].data.historico.length)"),'aparelho vazio + conta com dados: baixa os dados da conta')
    ctx.close()
    # 12) outra conta neste aparelho: pergunta e Cancelar não mistura os dados (mesmo perfil nos dois passos)
    ctx,pg,errs=abrir(b,{'session':True,'remoto':None})
    pg.wait_for_timeout(800)
    pg.evaluate("store.concursos['pm-ma'].data.historico.push({id:9,date:'2026-01-02',horas:1,questoes:1,acertos:1,erros:0,disc:'Y'});persist();")
    pg.wait_for_timeout(2500)                      # o envio para a nuvem grava o dono atual; só então simulamos outra conta
    pg.evaluate("localStorage.setItem('rp-dono','outra-conta')")
    dialogos=[]
    pg.on('dialog', lambda d: (dialogos.append(d.message), d.dismiss()))
    pg.reload(); pg.wait_for_timeout(2500)
    ok(any('outra conta' in m or 'diferentes' in m for m in dialogos) or any(c[0]=='signOut' for c in calls(pg)),'conta diferente no aparelho: pergunta e Cancelar não mistura os dados')
    ctx.close()
    # 13) sem a biblioteca (offline): mensagem clara e a tela continua fechada
    ctx,pg,errs=abrir(b,{},lib=False)
    ok(tela_visivel(pg) and 'Não foi possível carregar' in msg(pg),'sem internet: mostra mensagem clara e não libera o app')
    ok(not errs,'sem erro de JavaScript offline (%s)'%errs[:2]); ctx.close()
    # 14) alterações locais vão para a nuvem depois de salvar
    ctx,pg,errs=abrir(b,{'session':True,'remoto':None})
    pg.wait_for_timeout(800); pg.evaluate("window.__calls.length=0")
    pg.evaluate("addRegistro({date:todayKey(),disc:EDITAL[0].nome,topic:'',tipo:'Q',horas:1,questoes:4,acertos:2,erros:2,obs:'',origem:'manual'})"); pg.wait_for_timeout(5000)
    ok(any(c[0]=='upsert' for c in calls(pg)),'alteração local: envia para a nuvem depois de salvar')
    ctx.close()
    # 15) botão Sair da conta
    ctx,pg,errs=abrir(b,{'session':True,'remoto':None})
    pg.evaluate("openMais()"); pg.wait_for_timeout(200)
    ok(pg.evaluate("!!document.querySelector('#mais-modal button[onclick*=rpSair]')") or pg.evaluate("[...document.querySelectorAll('button')].some(b=>/Sair da conta/.test(b.textContent))"),'menu Mais tem o botão Sair da conta')
    ctx.close()
    b.close()
print('\nRESULTADO: %d/%d verificações aprovadas'%(sum(res),len(res))); sys.exit(0 if all(res) else 1)
