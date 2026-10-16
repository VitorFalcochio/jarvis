// Desenho → código: o usuário rabisca uma tela no papel, mostra para a câmera e o JARVIS gera o HTML.
// Passo 1: a IA de visão descreve o rascunho em detalhes (layout, textos, elementos)
// Passo 2: o Nemotron escreve um HTML completo a partir da descrição
const { shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let last = null; // { file, description, html }

function extractHtml(text) {
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const html = (fenced ? fenced[1] : text).trim();
  if (!/<html|<!doctype|<body|<div/i.test(html)) throw new Error('O modelo não devolveu HTML');
  return html;
}

function save(ctx, html, image) {
  const dir = path.join(ctx.dataDir, 'sketches');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `prototipo-${stamp}.html`);
  fs.writeFileSync(file, html);
  if (image) fs.writeFileSync(file.replace(/\.html$/, '-rascunho.jpg'), image);
  return file;
}

function open(file, where) {
  if (where === 'vscode') {
    spawn('cmd.exe', ['/d', '/s', '/c', `"code "${file}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else {
    shell.openPath(file);
  }
}

const CODE_RULES = `Regras do código:
- As "Anotações" do rascunho são instruções para você aplicar (cores, comportamento); nunca as desenhe como elementos na página.
- Um único arquivo HTML completo (<!doctype html> até </html>), com CSS e JavaScript embutidos, sem bibliotecas externas.
- Visual moderno e caprichado: boa tipografia (fonte do sistema), espaçamentos generosos, cantos arredondados, sombras suaves, estados de hover/focus.
- Responsivo (funciona no celular e no PC). Textos em português do Brasil.
- Elementos interativos devem ter comportamento simples quando fizer sentido (abas trocam, botões dão feedback, formulários validam).
- Responda SOMENTE com o código dentro de um bloco \`\`\`html.`;

module.exports = {
  name: 'sketch',
  tools: [
    {
      name: 'sketch_to_code',
      description: 'Transforma um desenho/rascunho de interface em código HTML funcional. O desenho vem da câmera do celular (papel) ou da tela do PC. Use para "transforma esse desenho em código", "cria esse site que desenhei", "faz essa tela".',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['camera', 'screen'], description: 'camera = papel na frente do celular; screen = desenho aberto na tela do PC. Padrão: camera se conectada' },
          instructions: { type: 'string', description: 'Pedidos extras do usuário (cores, estilo, o que o app faz)' },
          open_in: { type: 'string', enum: ['browser', 'vscode'], description: 'Onde abrir o resultado (padrão: navegador)' },
        },
      },
      async run({ source, instructions = '', open_in = 'browser' }, ctx) {
        const cam = ctx.phonecam;
        const camReady = cam.connected && cam.latest && Date.now() - cam.latestAt < 5000;
        if (!source) source = camReady ? 'camera' : 'screen';
        if (source === 'camera' && !camReady) return { ok: false, error: 'A câmera do celular não está ligada. Ligue-a no app do celular ou peça para usar a tela.' };

        let image;
        if (source === 'camera') { ctx.send('camera-snap'); image = cam.latest; }
        else image = Buffer.from(await ctx.captureScreen(), 'base64');
        ctx.toast('Analisando o rascunho...');

        const description = await ctx.vision(
          'Esta imagem mostra um RASCUNHO de interface (desenho à mão em papel, quadro ou tela). Descreva-o em detalhes para um desenvolvedor reproduzir fielmente: ' +
          'o tipo de tela/app, o layout de cima para baixo e da esquerda para a direita, CADA elemento (cabeçalho, menu, cards, campos, botões, imagens, listas, ícones) com o TEXTO EXATO escrito, ' +
          'posições e tamanhos relativos e cores. ATENÇÃO: setas, notas nas margens ou textos em outra cor apontando para algo são ANOTAÇÕES do autor ' +
          '(instruções como "botão azul", "isso é um menu"): liste-as separadamente numa seção "Anotações" e NÃO as trate como elementos da tela. ' +
          'Se algo estiver ilegível, dê o palpite mais provável. Se não for uma interface, diga o que é.',
          image.toString('base64'));
        if (/não (é|parece) (uma )?interface|nenhum (desenho|rascunho)/i.test(description) && description.length < 300) {
          return { ok: false, error: `Não identifiquei um rascunho de interface: ${description}` };
        }

        ctx.toast('Escrevendo o código...');
        const answer = await ctx.complete(
          `Você é um desenvolvedor front-end sênior. Implemente a interface descrita abaixo, que veio de um rascunho desenhado à mão.\n\n` +
          `DESCRIÇÃO DO RASCUNHO:\n${description}\n\n${instructions ? `PEDIDOS EXTRAS DO USUÁRIO: ${instructions}\n\n` : ''}${CODE_RULES}`,
          { maxTokens: 8000 });
        const html = extractHtml(answer);
        const file = save(ctx, html, image);
        last = { file, description, html };
        open(file, open_in);
        return {
          ok: true, file, opened_in: open_in === 'vscode' ? 'VS Code' : 'navegador',
          how_to_answer: 'Diga em 1 ou 2 frases que o protótipo foi gerado e aberto, e que dá para pedir ajustes ("deixa o botão verde", "adiciona um rodapé").',
        };
      },
    },
    {
      name: 'sketch_refine',
      description: 'Ajusta o último protótipo gerado pelo sketch_to_code ("muda a cor", "adiciona um rodapé", "deixa mais minimalista").',
      parameters: { type: 'object', properties: { instructions: { type: 'string' } }, required: ['instructions'] },
      async run({ instructions }, ctx) {
        if (!last) return { ok: false, error: 'Nenhum protótipo foi gerado ainda nesta sessão' };
        ctx.toast('Aplicando os ajustes...');
        const answer = await ctx.complete(
          `Aqui está um arquivo HTML. Aplique estas alterações pedidas pelo usuário: "${instructions}".\n` +
          `Mantenha todo o resto como está. ${CODE_RULES}\n\nARQUIVO ATUAL:\n\`\`\`html\n${last.html}\n\`\`\``,
          { maxTokens: 8000 });
        const html = extractHtml(answer);
        const file = save(ctx, html);
        last = { ...last, file, html };
        open(file, 'browser');
        return { ok: true, file };
      },
    },
    {
      name: 'sketch_open_code',
      description: 'Abre o código do último protótipo no VS Code.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!last) return { ok: false, error: 'Nenhum protótipo gerado ainda' };
        open(last.file, 'vscode');
        return { ok: true };
      },
    },
  ],
};
