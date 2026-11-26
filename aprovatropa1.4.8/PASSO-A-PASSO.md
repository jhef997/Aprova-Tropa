# AprovaTropa com login e banco — passo a passo (faça nesta ordem)

Estrutura: `app/` é o que vai para o ar (`index.html`, `css/app.css`, `js/app.js`, `js/auth/auth.js`, `pdfjs/`, `icons/`, `manifest.webmanifest`, `sw.js`). `tests/` e `supabase-inicio.sql` ficam fora do ar.

## 1. Banco (Supabase) — já feito antes, confira
1. Painel do Supabase → **SQL Editor** → cole o conteúdo de `supabase-inicio.sql` → **Run**.
2. **Table Editor** → deve existir `user_backups` com **RLS enabled** e 4 políticas.

## 2. Login por e-mail (Supabase)
1. **Authentication → Sign In / Providers → Email**: ativado.
2. **Confirm email**: ligado (o usuário confirma o cadastro pelo link do e-mail).
3. Obs.: o envio de e-mail padrão tem limite baixo por hora. Para uso real, configure **SMTP próprio** (Project Settings → Auth → SMTP).

## 3. Login com Google
1. **Google Cloud Console** (console.cloud.google.com) → crie um projeto → **APIs e serviços → Tela de consentimento OAuth** (Externo; nome do app; e-mail de suporte).
2. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**.
3. Em **URIs de redirecionamento autorizados**, cole exatamente:
   `https://svikcbddicgicnvotlew.supabase.co/auth/v1/callback`
4. Copie o **Client ID** e o **Client Secret**.
5. Supabase → **Authentication → Providers → Google**: ative, cole Client ID e Client Secret, **Save**.

## 4. Publicar no Netlify (deploy direto do Git)
1. Suba o repositório para o GitHub (ou GitLab/Bitbucket).
2. No Netlify: **Add new site → Import an existing project** → escolha o repositório.
3. O arquivo `netlify.toml` já define a pasta de publicação (`app`). Não precisa mudar nada.
4. Cada `git push` na branch principal publica uma nova versão. Para voltar, use **Deploys → Publish deploy** de uma versão anterior, ou `git revert`.
5. A tela de acesso aparece primeiro porque o `app/index.html` é a entrada do site.

## 5. Ligar o endereço do Netlify ao Supabase
1. Supabase → **Authentication → URL Configuration**:
   - **Site URL**: `https://nome-escolhido.netlify.app`
   - **Redirect URLs**: adicione `https://nome-escolhido.netlify.app` e `https://nome-escolhido.netlify.app/**`
2. Sem isso, o link de confirmação e o login com Google voltam para o lugar errado.

## 6. Testar do começo ao fim (no seu celular)
1. Abra o endereço do Netlify → deve aparecer a **tela de acesso**.
2. **Criar conta**: digite e-mail e senha (mínimo 8 caracteres) → confirme pelo link do e-mail → entre.
3. **Entrar** com e-mail e senha. Senha errada deve mostrar mensagem e não entrar.
4. **Entrar com Google** → escolha a conta → volta logado.
5. **Esqueci a senha**: digite o e-mail → **Recuperar senha** → abra o link do e-mail → defina a nova senha.
6. Use o app (registre um estudo). No Supabase → **Table Editor → user_backups** deve aparecer a sua linha, com `payload` preenchido.
7. Menu **Mais → Sair da conta** → volta para a tela de acesso.
8. Entre de novo: seus dados devem voltar (vindos da nuvem).

## 7. Problemas comuns
- **"Não foi possível carregar o serviço de autenticação"**: sem internet, ou o bloqueador de anúncios bloqueou o Supabase. Atualize a página com internet.
- **Google: "redirect_uri_mismatch"**: o endereço do item 3 não bate com o Supabase. Confira o passo 3.4 exatamente.
- **Não chega o e-mail**: confira a caixa de spam; configure SMTP próprio (passo 2.3).
- **"Os dados deste aparelho são de outra conta"**: escolha OK para apagar os dados do aparelho e usar a sua conta, ou Cancelar para sair.

## 8. O que ainda NÃO está pronto (seja honesto com quem for usar)
- Os testes automáticos foram feitos com um Supabase falso no navegador. O teste com a conta real (itens 2 a 7) precisa ser feito por você.
- A tela de acesso protege a entrada no app. Os dados guardados no aparelho continuam acessíveis a quem tiver o aparelho desbloqueado. A proteção dos dados na nuvem vem das regras do banco (cada pessoa só acessa a própria linha).
- Chave secreta (`service_role`) nunca vai para o app. Só a chave publicável está no código.
