// Navegação entre as telas do JARVIS por voz.
const SCREENS = {
  hud: 'Tela principal (orb, chat, painéis)',
  music: 'Música: letra sincronizada, fila, playlists',
  projects: 'Projetos: git, abrir, rodar, portas, Docker',
  agenda: 'Agenda: kanban de tarefas, notas, lembretes, horas de foco',
  memory: 'Memória: o que o JARVIS sabe e conversas antigas',
  research: 'Pesquisas: relatórios, comparações e resumos de links salvos',
  oficina: 'Oficina: local de trabalho das agentes de código (FRIDAY, EDITH, KAREN), com o progresso de cada uma',
  settings: 'Configurações',
};

module.exports = {
  name: 'nav',
  SCREENS,
  tools: [
    {
      name: 'workshop_window',
      description: 'Abre (ou fecha) a Oficina numa janela dedicada em tela cheia no segundo monitor ("modo oficina", "abre a oficina no outro monitor", "fecha a oficina").',
      parameters: { type: 'object', properties: { open: { type: 'boolean', description: 'true abre, false fecha' } }, required: ['open'] },
      async run({ open }, ctx) {
        const r = await ctx.oficinaWindow(open);
        return { ...r, how_to_answer: open ? 'Uma frase curta e com estilo, tipo "Oficina online no segundo monitor".' : 'Confirme em poucas palavras.' };
      },
    },
    {
      name: 'open_screen',
      description: `Abre uma tela do JARVIS ("abre a tela de música", "mostra minhas tarefas no kanban", "volta pra tela inicial"). Telas: ${Object.entries(SCREENS).map(([k, v]) => `${k} = ${v}`).join('; ')}.`,
      parameters: { type: 'object', properties: { screen: { type: 'string', enum: Object.keys(SCREENS) } }, required: ['screen'] },
      async run({ screen }, ctx) {
        if (!SCREENS[screen]) return { ok: false, error: 'Tela desconhecida' };
        ctx.send('navigate', screen);
        return { ok: true, opened: screen };
      },
    },
  ],
};
