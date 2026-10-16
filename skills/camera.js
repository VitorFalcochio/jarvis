// Câmera do celular: parear por QR code e analisar o que a câmera vê.

module.exports = {
  name: 'camera',
  tools: [
    {
      name: 'camera_connect',
      description: 'Conecta o celular ao JARVIS (app com câmera, conversa por voz, controle da música e tarefas): mostra um QR code na tela para escanear. Depois do primeiro pareamento o link continua valendo.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        const info = await ctx.phonecam.start();
        if (!ctx.config.phoneEnabled) { ctx.config.phoneEnabled = true; ctx.saveConfig(); } // volta sozinho nos próximos inícios
        if (info.connected) return { ok: true, already_connected: true };
        const qr = await require('qrcode').toDataURL(info.url, { margin: 1, width: 260, color: { dark: '#02121c', light: '#cfefff' } });
        ctx.send('camera-pair', { qr, url: info.url });
        return {
          ok: true, shown_qr_code: true,
          how_to_answer: 'Diga em 1 ou 2 frases: escanear o QR code com o celular no mesmo Wi-Fi e aceitar o aviso de segurança do navegador.',
        };
      },
    },
    {
      name: 'camera_look',
      description: 'Olha pela câmera do celular e responde sobre o que vê ("o que você está vendo?", "lê esse texto", "que objeto é esse?", "como estou?").',
      parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      async run({ question }, ctx) {
        const cam = ctx.phonecam;
        if (!cam.connected) return { ok: false, error: 'A câmera do celular não está conectada (use camera_connect)' };
        if (!cam.latest || Date.now() - cam.latestAt > 5000) return { ok: false, error: 'A câmera está conectada mas não está enviando imagem (a tela do celular pode ter apagado)' };
        ctx.send('camera-snap');
        const answer = await ctx.vision(question, cam.latest.toString('base64'));
        return { analysis: answer, how_to_answer: 'Responda falando, em no máximo 3 frases.' };
      },
    },
    {
      name: 'camera_disconnect',
      description: 'Desliga a câmera do celular e o servidor de pareamento.',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        ctx.phonecam.stop();
        ctx.send('camera-state', { connected: false });
        return { ok: true };
      },
    },
  ],
};
