// Conteúdo rico no chat: formulários de perguntas/enquetes e galerias de imagens.
// (Gráficos, tabelas e números usam show_visual, que aparece dentro do chat quando a tela de Chat está aberta.)
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const KINDS = ['single', 'multi', 'text', 'scale', 'poll'];

// Imagens livres do Wikimedia Commons (só bitmaps: nada de PDF/SVG)
async function commonsImages(query, count) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: String(count * 2),
    gsrsearch: `${query} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '640', origin: '*',
  });
  const r = await fetch(url, { headers: { 'User-Agent': 'JARVIS-pessoal/2.0' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Wikimedia ${r.status}`);
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  return pages
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ info }) => info && /image\/(jpeg|png|webp)/.test(info.mime) && info.thumburl)
    .slice(0, count)
    .map(({ p, info }) => ({
      thumb: info.thumburl,
      url: info.url,
      page: info.descriptionurl,
      title: str((info.extmetadata?.ObjectName?.value || p.title.replace(/^File:|\.\w+$/g, '')).replace(/<[^>]+>/g, ''), 90),
    }));
}

module.exports = {
  name: 'chat',
  tools: [
    {
      name: 'chat_ask',
      description: 'Mostra no chat um formulário interativo para o usuário responder clicando: várias perguntas de uma vez, enquete, nota de 1 a 5, múltipla escolha ou campo de texto. Use para levantar requisitos ("que tipo de site? quais páginas? qual estilo?"), montar planos, quizzes e pesquisas de preferência. Para UMA pergunta simples com 2 a 4 respostas prefira offer_choices. As respostas chegam como a próxima mensagem do usuário. Faça a introdução em uma frase; não repita as perguntas no texto.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título curto do formulário' },
          questions: {
            type: 'array',
            description: 'De 1 a 6 perguntas',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                kind: { type: 'string', enum: KINDS, description: 'single = uma opção; multi = várias; text = resposta livre; scale = nota de 1 a 5; poll = enquete (uma opção, com cartões grandes)' },
                options: { type: 'array', items: { type: 'string' }, description: 'Para single/multi/poll: 2 a 8 opções' },
              },
              required: ['text', 'kind'],
            },
          },
        },
        required: ['questions'],
      },
      async run({ title, questions }, ctx) {
        if (ctx.channel !== 'pc') return { ok: false, error: 'Formulários só aparecem no PC. Use offer_choices ou pergunte em texto.' };
        const qs = (Array.isArray(questions) ? questions : []).slice(0, 6).map((q, i) => {
          const kind = KINDS.includes(q.kind) ? q.kind : 'text';
          const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 8);
          return { id: `q${i}`, text: str(q.text, 200), kind: ['single', 'multi', 'poll'].includes(kind) && options.length < 2 ? 'text' : kind, options };
        }).filter((q) => q.text);
        if (!qs.length) return { ok: false, error: 'Mande pelo menos uma pergunta com texto.' };
        ctx.send('ai-form', { title: str(title, 80), questions: qs });
        return { ok: true, shown: true, instruction: 'O formulário está na tela. Diga em UMA frase que deixou as perguntas ali e espere as respostas.' };
      },
    },
    {
      name: 'show_images',
      description: 'Mostra uma galeria de fotos reais no chat (Wikimedia Commons): animais, lugares, objetos, carros, obras, pessoas famosas, "me mostra fotos de X". Escreva a busca em inglês quando o assunto for mais conhecido assim (ex: "Porsche 911 GT3").',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, count: { type: 'number', description: 'Quantas fotos (padrão 6, máx 12)' } },
        required: ['query'],
      },
      async run({ query, count = 6 }, ctx) {
        const n = Math.max(1, Math.min(12, Math.round(count) || 6));
        const images = await commonsImages(str(query, 120), n);
        if (!images.length) return { ok: false, error: `Não encontrei fotos de "${query}". Tente outra busca (em inglês costuma funcionar melhor).` };
        if (ctx.channel === 'pc') ctx.send('ai-images', { query: str(query, 120), images });
        return { ok: true, shown: images.length, titles: images.map((i) => i.title), instruction: 'As fotos já estão no chat. Comente em 1 a 2 frases, sem descrever foto por foto.' };
      },
    },
  ],
};
