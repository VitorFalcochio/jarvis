// Escolhas clicáveis: o modelo oferece de 2 a 4 caminhos e a interface mostra botões
// (no PC, no chat; no Telegram, botões embaixo da resposta). Também dá para responder por voz.
module.exports = {
  name: 'conversa',
  tools: [
    {
      name: 'offer_choices',
      description: 'Mostra de 2 a 4 botões de escolha embaixo da sua resposta. Chame SEMPRE que você for fazer uma pergunta com respostas previsíveis (ex.: "Qual tipo de projeto?" → ["Site", "API", "App mobile", "Script/automação"]), quando o pedido for ambíguo (em vez de chutar) ou quando houver próximos passos naturais e úteis. Não use em respostas que já resolvem tudo.',
      parameters: {
        type: 'object',
        properties: {
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'De 2 a 4 opções curtas (até 40 caracteres), escritas como o usuário diria. Ex: ["Toca o álbum inteiro", "Só essa música", "Monta uma playlist parecida"]',
          },
        },
        required: ['options'],
      },
      async run({ options }, ctx) {
        const list = (Array.isArray(options) ? options : [])
          .map((o) => String(o).trim())
          .filter(Boolean)
          .slice(0, 4);
        if (list.length < 2) return { ok: false, error: 'Mande de 2 a 4 opções.' };
        ctx.lastChoices = list;
        if (ctx.channel === 'pc') ctx.send('ai-choices', list);
        return {
          ok: true,
          shown: true,
          instruction: 'Os botões já estão na tela. Faça a pergunta em UMA frase curta e natural; não leia a lista inteira. Se o usuário responder "a primeira", "a segunda" etc., é a ordem destas opções.',
        };
      },
    },
  ],
};
