
(function(){
  'use strict';
  window.APP_VERSION='1.4.9';
  const SUPABASE_URL='https://svikcbddicgicnvotlew.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY='sb_publishable_GqOk_TTOJCb8WfeCwtiZyg_-hkQPkPK';
  const MIN_SENHA=8;
  const $=id=>document.getElementById(id);
  const screen=$('rp-auth-screen'), msg=$('rp-auth-message'), form=$('rp-auth-form'), email=$('rp-auth-email'),
        password=$('rp-auth-password'), submit=$('rp-auth-submit'), googleBtn=$('rp-google-login'),
        signupBtn=$('rp-auth-signup'), resetBtn=$('rp-auth-reset');
  let client=null, mode='login', user=null, cloudTimer=null, sincronizando=false;

  function message(text,error){ msg.textContent=text; msg.className='show'+(error?' error':''); }
  const MIN_IDADE=18;
  const TITULOS={login:['Entrar','Use sua conta para continuar seus estudos.','Entrar'],
    signup:['Criar sua conta','Leva menos de um minuto. Seus dados ficam protegidos.','Criar conta'],
    reset:['Recuperar senha','Informe o e-mail da sua conta. Enviaremos um link para criar uma nova senha.','Enviar link'],
    update:['Definir nova senha','Escolha uma senha nova para a sua conta.','Salvar nova senha']};
  function busy(on,label){
    submit.disabled=on;
    submit.textContent=on?'Aguarde...':(label||TITULOS[mode][2]);
    googleBtn.disabled=on;
  }
  // versão do app mostrada no menu (troque a versão a cada mudança)
  document.querySelectorAll('[data-app-version]').forEach(function(e){ e.textContent='Versão '+window.APP_VERSION; });
  function showApp(){ screen.hidden=true; document.body.classList.remove('rp-auth-locked'); }
  function showLogin(){ screen.hidden=false; }
  function ready(){
    if(!window.supabase||!window.supabase.createClient){
      message('Não foi possível carregar o serviço de autenticação. Verifique sua conexão e atualize a página.',true); return false;
    }
    if(!client) client=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    return true;
  }
  const emailValido=e=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  function show(id,on){ const el=$(id); if(el) el.hidden=!on; }
  function setMode(m){
    mode=m; message('');
    const [titulo,sub,botao]=TITULOS[m];
    $('rp-auth-titulo').textContent=titulo; $('rp-auth-sub').textContent=sub; submit.textContent=botao;
    const cadastro=m==='signup', login=m==='login', reset=m==='reset', update=m==='update';
    show('rp-field-nome',cadastro);
    show('rp-field-email',!update);
    show('rp-field-nascimento',cadastro);
    show('rp-field-senha',!reset);
    show('rp-field-senha2',cadastro||update);
    show('rp-field-termos',cadastro);
    show('rp-senha-ajuda',cadastro||update);
    show('rp-google-login',login||cadastro);
    show('rp-auth-divider',login||cadastro);
    password.autocomplete=(cadastro||update)?'new-password':'current-password';
    $('rp-auth-signup').hidden=update||reset;
    $('rp-auth-reset').hidden=update||reset?true:false;
    if(login){ signupBtn.textContent='Criar conta'; resetBtn.textContent='Esqueci minha senha'; }
    if(cadastro){ signupBtn.textContent='Já tenho conta'; }
    if(reset){ signupBtn.textContent='Voltar para entrar'; signupBtn.hidden=false; }
    signupBtn.hidden=update;
    busy(false);
  }
  function idadeEmAnos(iso){
    const n=new Date(iso+'T00:00:00'), h=new Date();
    let idade=h.getFullYear()-n.getFullYear();
    if(h.getMonth()<n.getMonth()||(h.getMonth()===n.getMonth()&&h.getDate()<n.getDate())) idade--;
    return idade;
  }
  function campoInvalido(el,texto){ el.setAttribute('aria-invalid','true'); el.focus(); message(texto,true); return false; }
  function limparInvalidos(){ form.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid')); }

  /* ---------- sincronização com o banco (tabela user_backups; RLS: cada pessoa só acessa a própria linha) ---------- */
  const temDados=s=>!!(s&&s.concursos&&Object.keys(s.concursos).some(id=>{const d=s.concursos[id].data||{};
    return (d.historico||[]).length||(d.erros||[]).length||(d.simulados||[]).length||(d.revisoes||[]).length;}));
  // compara só o conteúdo que importa: ignora campos internos (_rev, _t, schema, kb) e a ordem das chaves
  function canon(o){
    if(Array.isArray(o)) return '['+o.map(canon).join(',')+']';
    if(o&&typeof o==='object'){
      return '{'+Object.keys(o).filter(k=>k[0]!=='_'&&k!=='schema'&&k!=='kb').sort().map(k=>JSON.stringify(k)+':'+canon(o[k])).join(',')+'}';
    }
    return JSON.stringify(o===undefined?null:o);
  }
  // só o que é do usuário: concursos escolhidos ou com algum dado (os pré-cadastrados vazios são o modelo do app)
  function resumoUsuario(s){
    const out={active:s.active||null, concursos:{}};
    Object.keys(s.concursos||{}).forEach(function(id){
      const c=s.concursos[id], d=c.data||{};
      const tem=(d.historico||[]).length||(d.erros||[]).length||(d.simulados||[]).length||(d.revisoes||[]).length||Object.keys(d.state||{}).length||(c.info&&(c.info.provaRealizada||c.info.notaProva!=null));
      if(c.chosen===true||tem) out.concursos[id]={chosen:c.chosen===true,info:c.info,edital:c.edital,data:c.data};
    });
    return out;
  }
  const copia=o=>JSON.parse(JSON.stringify(o));
  async function subirNuvem(){
    const row={user_id:user.id,rev:Number(store._rev)||0,esquema:Number(store.v)||2,payload:copia(store),atualizado_em:new Date().toISOString()};
    const {error}=await client.from('user_backups').upsert(row,{onConflict:'user_id'});
    if(error) throw error;
    localStorage.setItem('rp-dono',user.id);
  }
  function agendarNuvem(){
    if(!user||!client) return;
    clearTimeout(cloudTimer);
    cloudTimer=setTimeout(()=>{ subirNuvem().catch(e=>showToast&&showToast('⚠️','Não foi possível salvar na nuvem agora: '+(e.message||'erro'))); },1500);
  }
  async function aplicarRemoto(remoto){
    store=copia(remoto);
    if(!store.concursos[store.active]) store.active=Object.keys(store.concursos)[0]||null;
    if(store.active) loadConcurso(store.active);      // primeiro carrega os dados da conta nas telas...
    migrateStore();                                    // ...depois migra (a migração copia as telas de volta: já estão certas)
    if(window.Armazenamento) Armazenamento.salvar(store); else localStorage.setItem(STORE_KEY,JSON.stringify(store));
    refreshAll();
    localStorage.setItem('rp-dono',user.id);
    await subirNuvem();   // a conta passa a ter exatamente esta versão organizada
    showToast&&showToast('☁️','Dados da sua conta carregados.');
  }
  async function limparAparelho(){
    localStorage.removeItem(STORE_KEY);
    await new Promise(r=>{const q=indexedDB.deleteDatabase('rumo-posse');q.onsuccess=q.onerror=q.onblocked=()=>r();});
  }
  // espera o armazenamento terminar de carregar: só então lê ou grava dados da conta (evita a corrida)
  function aguardarArmazenamento(){
    return new Promise(function(res){
      const t0=Date.now();
      (function ver(){
        if(!window.Armazenamento||Armazenamento.status().pronto||Date.now()-t0>5000) return res();
        setTimeout(ver,100);
      })();
    });
  }
  async function sincronizarAoEntrar(){
    if(sincronizando) return; sincronizando=true;
    try{
      await aguardarArmazenamento();
      const dono=localStorage.getItem('rp-dono');
      if(dono&&dono!==user.id&&temDados(store)){
        const ok=window.confirm('Os dados deste aparelho são de outra conta. OK = apagar os dados deste aparelho e usar a sua conta. Cancelar = sair.');
        if(!ok){ await client.auth.signOut(); return; }
        await limparAparelho(); location.reload(); return;
      }
      const {data,error}=await client.from('user_backups').select('rev,payload').eq('user_id',user.id).maybeSingle();
      if(error) throw error;
      if(!data){ await subirNuvem(); return; }
      const remoto=data.payload;
      if(canon(resumoUsuario(remoto))===canon(resumoUsuario(store))) { localStorage.setItem('rp-dono',user.id); return; }
      if(!temDados(store)&&temDados(remoto)){ await aplicarRemoto(remoto); return; }
      if(temDados(store)&&!temDados(remoto)){ await subirNuvem(); return; }
      const usarNuvem=window.confirm('Há dados diferentes neste aparelho e na sua conta. OK = usar os da conta. Cancelar = manter os deste aparelho e enviá-los para a conta.');
      if(usarNuvem) await aplicarRemoto(remoto); else await subirNuvem();
    }catch(e){
      showToast&&showToast('⚠️','Sincronização adiada: '+(e.message||'erro')+'. Seus dados continuam neste aparelho.');
    }finally{ sincronizando=false; }
  }
  // mensagens do Supabase traduzidas para quem usa o app
  function traduzirErro(e){
    const m=String((e&&e.message)||e||'').toLowerCase();
    if(m.includes('invalid login')) return 'E-mail ou senha incorretos. Se você criou a conta por Google, use o botão Google.';
    if(m.includes('email not confirmed')) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
    if(m.includes('already registered')||m.includes('already been registered')) return 'Este e-mail já tem conta. Use Entrar ou Esqueci a senha.';
    if(m.includes('password')&&(m.includes('least')||m.includes('short')||m.includes('characters'))) return 'A senha precisa ter pelo menos '+MIN_SENHA+' caracteres.';
    if(m.includes('rate limit')||m.includes('too many')||m.includes('over_email')||m.includes('security purposes')) return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';
    if(m.includes('invalid email')||m.includes('email address')) return 'E-mail inválido. Confira o endereço.';
    if(m.includes('signups not allowed')||m.includes('signup')&&m.includes('disabled')) return 'O cadastro por e-mail está desativado no servidor. Fale com o administrador.';
    if(m.includes('redirect')) return 'Endereço de retorno não autorizado no Supabase (Site URL / Redirect URLs).';
    if(m.includes('failed to fetch')||m.includes('network')) return 'Sem conexão com o servidor. Verifique a internet.';
    return (e&&e.message)?e.message:'Tente novamente.';
  }
  // nome e foto da conta no menu
  function renderPerfil(u){
    const meta=(u&&u.user_metadata)||{};
    const email=(u&&u.email)||'';
    const nome=meta.full_name||meta.name||(email?email.split('@')[0]:'Estudante');
    const foto=meta.avatar_url||meta.picture||'';
    const ini=nome.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0].toUpperCase()).join('')||'?';
    ['perfil','sb-user','perfil-home'].forEach(function(pre){
      const n=$(pre+'-nome'), e=$(pre+'-email'), f=$(pre+'-foto'), i=$(pre+'-ini');
      if(n) n.textContent=nome;
      if(e) e.textContent=email;
      if(f){ if(foto){ f.src=foto; f.hidden=false; if(i) i.hidden=true; } else { f.hidden=true; f.removeAttribute('src'); if(i){ i.textContent=ini; i.hidden=false; } } }
    });
    const card=$('perfil-card'); if(card) card.hidden=false;
    const su=$('sb-user'); if(su) su.hidden=false;
    const ph=$('perfil-home'); if(ph) ph.hidden=false;
  }
  function onSessao(session){
    user=session?session.user:null;
    if(user){ renderPerfil(user); showApp(); sincronizarAoEntrar(); } else showLogin();
  }
  // toda alteração local vai para a nuvem (com atraso curto), quando há conta
  { const _persist=persist; persist=function(){ _persist.apply(this,arguments); agendarNuvem(); }; }

  /* ---------- eventos da tela de acesso ---------- */
  googleBtn.addEventListener('click',async function(){
    if(!ready()) return;
    try{
      message('Conectando ao Google...');
      const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin}});
      if(error) throw error;
    }catch(e){ message('Não foi possível entrar com Google. '+traduzirErro(e),true); }
  });
  form.addEventListener('submit',async function(e){
    e.preventDefault(); if(!ready()) return;
    limparInvalidos();
    const em=email.value.trim(), senha=password.value, senha2=$('rp-auth-senha2').value;
    const nome=$('rp-auth-nome').value.trim().replace(/\s+/g,' '), nasc=$('rp-auth-nascimento').value;
    if(mode!=='update'&&!emailValido(em)) return campoInvalido(email,'Informe um e-mail válido, como nome@exemplo.com.');
    if(mode==='signup'){
      if(nome.split(' ').length<2||nome.length<5) return campoInvalido($('rp-auth-nome'),'Informe seu nome completo (nome e sobrenome).');
      if(!nasc) return campoInvalido($('rp-auth-nascimento'),'Informe sua data de nascimento.');
      if(idadeEmAnos(nasc)<MIN_IDADE||isNaN(idadeEmAnos(nasc))) return campoInvalido($('rp-auth-nascimento'),'Para criar a conta é preciso ter '+MIN_IDADE+' anos ou mais.');
      if(senha.length<8) return campoInvalido(password,'A senha precisa ter pelo menos 8 caracteres.');
      if(senha!==senha2) return campoInvalido($('rp-auth-senha2'),'As senhas não são iguais. Digite a mesma senha nos dois campos.');
      if(!$('rp-auth-termos').checked) return campoInvalido($('rp-auth-termos'),'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.');
    }
    if(mode==='login'&&!senha) return campoInvalido(password,'Digite sua senha.');
    if(mode==='update'){
      if(senha.length<8) return campoInvalido(password,'A senha precisa ter pelo menos 8 caracteres.');
      if(senha!==senha2) return campoInvalido($('rp-auth-senha2'),'As senhas não são iguais.');
    }
    busy(true);
    try{
      if(mode==='reset'){
        const {error}=await client.auth.resetPasswordForEmail(em,{redirectTo:window.location.origin});
        if(error) throw error;
        message('Enviamos um link de recuperação para '+em+'. Abra o e-mail e siga as instruções.');
        setMode('login'); message('Enviamos um link de recuperação para '+em+'. Abra o e-mail e siga as instruções.'); return;
      }
      let r;
      if(mode==='signup') r=await client.auth.signUp({email:em,password:senha,options:{emailRedirectTo:window.location.origin,data:{full_name:nome,birth_date:nasc}}});
      else if(mode==='update') r=await client.auth.updateUser({password:senha});
      else r=await client.auth.signInWithPassword({email:em,password:senha});
      if(r.error) throw r.error;
      if(mode==='update'){ setMode('login'); message('Senha alterada. Agora entre com a nova senha.'); return; }
      if(mode==='signup'&&!(r.data&&r.data.session)){
        setMode('login'); email.value=em;
        message('Conta criada! Enviamos um link de confirmação para '+em+'. Confirme e depois entre.'); return;
      }
      if(r.data&&r.data.session) onSessao(r.data.session);
    }catch(err){
      const acao=mode==='signup'?'Não foi possível criar a conta. ':mode==='reset'?'Não foi possível enviar o link. ':'Não foi possível entrar. ';
      message(acao+traduzirErro(err),true);
    }finally{ busy(false); }
  });
  signupBtn.addEventListener('click',function(){ setMode(mode==='signup'||mode==='reset'?'login':'signup'); });
  resetBtn.addEventListener('click',function(){ setMode(mode==='reset'?'login':'reset'); });
  // volta do link de recuperação: mostra a tela de nova senha
  if(/type=recovery/.test(window.location.hash)){ showLogin(); setMode('update'); }
  else setMode('login');

  /* ---------- sessão ---------- */
  if(ready()){
    client.auth.onAuthStateChange(function(event,session){
      if(event==='SIGNED_OUT'){ user=null; showLogin(); }
      else if(session&&event!=='PASSWORD_RECOVERY') onSessao(session);
    });
    client.auth.getSession().then(function(r){
      if(r.error){ message('Não foi possível verificar sua sessão: '+r.error.message,true); showLogin(); return; }
      if(r.data.session) onSessao(r.data.session); else showLogin();
    });
  }

  /* ---------- Data & segurança (menu Mais) ---------- */
  window.rpBackupNuvem=async function(){
    if(!ready()||!user) return showToast&&showToast('⚠️','Entre na sua conta para salvar na nuvem.');
    try{
      clearTimeout(cloudTimer); await subirNuvem();
      const h=new Date(); showToast&&showToast('☁️','Backup salvo na nuvem às '+String(h.getHours()).padStart(2,'0')+':'+String(h.getMinutes()).padStart(2,'0')+'.');
    }catch(e){ showToast&&showToast('⚠️','Não foi possível salvar na nuvem: '+traduzirErro(e)); }
  };
  window.rpRestaurarNuvem=async function(){
    if(!ready()||!user) return showToast&&showToast('⚠️','Entre na sua conta para restaurar.');
    try{
      const {data,error}=await client.from('user_backups').select('payload').eq('user_id',user.id).maybeSingle();
      if(error) throw error;
      if(!data||!data.payload) return showToast&&showToast('ℹ️','Ainda não há backup na nuvem para esta conta.');
      if(!window.confirm('Substituir os dados deste aparelho pelo último backup da nuvem?')) return;
      await aplicarRemoto(data.payload);
    }catch(e){ showToast&&showToast('⚠️','Não foi possível restaurar: '+traduzirErro(e)); }
  };
  window.rpExcluirDados=async function(){
    if(!ready()||!user) return showToast&&showToast('⚠️','Entre na sua conta para excluir os dados.');
    const r=window.prompt('Isto apaga TODOS os seus dados deste aparelho e da nuvem, e não tem volta.\n\n• Para apagar só os dados, digite EXCLUIR\n• Para apagar também a conta, digite EXCLUIR CONTA');
    if(r!=='EXCLUIR'&&r!=='EXCLUIR CONTA') return;
    try{
      clearTimeout(cloudTimer);
      const {error}=await client.from('user_backups').delete().eq('user_id',user.id);
      if(error) throw error;
      if(r==='EXCLUIR CONTA'){ const {error:e2}=await client.rpc('excluir_minha_conta'); if(e2) throw e2; }
      await limparAparelho();
      await client.auth.signOut();
      location.reload();
    }catch(e){ showToast&&showToast('⚠️','Não foi possível excluir: '+traduzirErro(e)); }
  };
  window.rpExcluirConta=async function(){
    if(!ready()||!user) return showToast&&showToast('⚠️','Entre na sua conta para excluir a conta.');
    const r=window.prompt('Isto apaga a sua CONTA e TODOS os seus dados (deste aparelho e da nuvem). Não tem volta.\n\nPara confirmar, digite EXCLUIR CONTA:');
    if(r!=='EXCLUIR CONTA') return;
    try{
      clearTimeout(cloudTimer);
      const {error:e1}=await client.from('user_backups').delete().eq('user_id',user.id);
      if(e1) throw e1;
      const {error:e2}=await client.rpc('excluir_minha_conta');
      if(e2) throw e2;
      await limparAparelho();
      await client.auth.signOut();
      location.reload();
    }catch(e){ showToast&&showToast('⚠️','Não foi possível excluir a conta: '+traduzirErro(e)); }
  };
  // sair da conta (o botão fica em Mais)
  window.rpSair=async function(){
    try{ if(client) await client.auth.signOut(); }catch(e){}
    location.reload();
  };
})();
