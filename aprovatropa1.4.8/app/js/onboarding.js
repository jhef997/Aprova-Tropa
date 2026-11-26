/* Tutorial de primeira instalação: aparece uma única vez neste aparelho.
   Pode ser pulado a qualquer momento. Não tem entrada no menu. */
(function () {
  'use strict';
  var CHAVE = 'rp-onb-v1';
  var PASSOS = [
    { t: 'Bem-vindo ao Rumo à Posse', d: 'Este app organiza seus estudos para concursos: o que estudar, quando revisar e como está sua evolução. Vamos ver o essencial em 9 telas rápidas. Você pode pular a qualquer momento.' },
    { t: '1. Escolha o seu concurso', d: 'No topo da tela inicial, a lista mostra os concursos que você escolheu. Para adicionar um, toque em "Pesquisar concurso" e depois em "Selecionar", ou em "＋" para criar um concurso do zero. Só aparecem os concursos que você escolher.' },
    { t: '2. Registre o seu edital', d: 'No menu Mais, use "Importar edital" e cole o texto ou envie o PDF do edital. O app separa as matérias e os tópicos, mostra o que encontrou e pede a sua confirmação antes de salvar.' },
    { t: '3. Comece pelo "Hora de ser aprovado"', d: 'O botão "Começar a estudar" mostra o tópico do dia e o que fazer: estudar o conteúdo, resolver questões e revisar. Ele usa o concurso que estiver ativo na lista do topo.' },
    { t: '4. Estude e registre o tempo', d: 'Em Estudar, use o cronômetro ou lance o tempo manualmente, escolhendo horas e minutos. Registre também as questões, os acertos e os erros. Cada registro alimenta o seu plano e o seu desempenho.' },
    { t: '5. Caderno de erros e revisões', d: 'Os erros vão para o Caderno de erros. O app agenda revisões automaticamente (1, 7 e 30 dias depois), para você rever o que errou antes de esquecer.' },
    { t: '6. Raio-X da banca', d: 'Mostra o quadro da prova (itens por bloco e notas mínimas), sua projeção de nota e onde estão seus pontos. Também registra quais assuntos mais caíram nas provas anteriores. Use só dados reais: do edital, das provas e gabaritos oficiais e do seu próprio desempenho.' },
    { t: '7. Seus dados', d: 'Entrando na sua conta, seus dados são salvos na nuvem e aparecem em outros aparelhos. No menu Mais, em "Data e segurança", você faz backup, restaura ou exclui os seus dados quando quiser.' },
    { t: 'Tudo pronto!', d: 'Comece escolhendo o seu concurso. Bons estudos e boa caminhada rumo à posse!' }
  ];
  var atual = 0, el = null;

  function marcarVisto() { try { localStorage.setItem(CHAVE, '1'); } catch (e) {} }
  function jaVisto() { try { return localStorage.getItem(CHAVE) === '1'; } catch (e) { return true; } }

  function montar() {
    el = document.createElement('div');
    el.id = 'onb';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Tutorial de primeiro uso');
    el.innerHTML =
      '<div class="onb-box">' +
        '<div class="onb-top"><span class="onb-cont" id="onb-cont"></span>' +
        '<button type="button" class="onb-pular" id="onb-pular">Pular</button></div>' +
        '<div class="onb-corpo"><h2 id="onb-t"></h2><p id="onb-d"></p></div>' +
        '<div class="onb-pontos" id="onb-pontos"></div>' +
        '<div class="onb-nav">' +
          '<button type="button" class="onb-voltar" id="onb-voltar">Voltar</button>' +
          '<button type="button" class="onb-prox" id="onb-prox">Próximo</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById('onb-pular').addEventListener('click', terminar);
    document.getElementById('onb-voltar').addEventListener('click', function () { if (atual > 0) { atual--; desenhar(); } });
    document.getElementById('onb-prox').addEventListener('click', function () {
      if (atual < PASSOS.length - 1) { atual++; desenhar(); } else terminar();
    });
  }

  function desenhar() {
    var p = PASSOS[atual];
    document.getElementById('onb-cont').textContent = (atual + 1) + ' de ' + PASSOS.length;
    document.getElementById('onb-t').textContent = p.t;
    document.getElementById('onb-d').textContent = p.d;
    document.getElementById('onb-pontos').innerHTML = PASSOS.map(function (_, i) {
      return '<i class="' + (i === atual ? 'on' : '') + '"></i>';
    }).join('');
    document.getElementById('onb-voltar').style.visibility = atual === 0 ? 'hidden' : 'visible';
    document.getElementById('onb-prox').textContent = atual === PASSOS.length - 1 ? 'Começar' : 'Próximo';
  }

  function terminar() {
    marcarVisto();
    if (el) { el.remove(); el = null; }
  }

  function iniciar() {
    if (jaVisto()) return;
    atual = 0; montar(); desenhar();
  }

  window.rpTutorialIniciar = iniciar;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
