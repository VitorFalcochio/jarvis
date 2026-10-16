// Hologramas 3D no HUD (girados com o mouse ou com gestos da mão pela câmera do celular).
const MODELS = {
  arc_reactor: 'reator arc (o do peito do Homem de Ferro)',
  earth: 'planeta Terra com cidades',
  atom: 'átomo com elétrons orbitando',
  solar_system: 'sistema solar com os 8 planetas',
  dna: 'hélice dupla de DNA',
};

module.exports = {
  name: 'holo',
  tools: [
    {
      name: 'hologram_show',
      description: `Projeta um holograma 3D interativo no HUD. Modelos: ${Object.entries(MODELS).map(([k, v]) => `${k} = ${v}`).join('; ')}. Use para "mostra um holograma", "projeta o reator", "me mostra o sistema solar em 3D".`,
      parameters: { type: 'object', properties: { model: { type: 'string', enum: Object.keys(MODELS) } }, required: ['model'] },
      async run({ model }, ctx) {
        ctx.send('hologram', { model });
        return { ok: true, showing: MODELS[model], how_to_answer: 'Uma frase curta, no estilo JARVIS. Pode lembrar que dá para girar com a mão pela câmera do celular (modo Gestos).' };
      },
    },
    {
      name: 'hologram_close',
      description: 'Fecha o holograma 3D.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        ctx.send('hologram-close');
        return { ok: true };
      },
    },
  ],
};
