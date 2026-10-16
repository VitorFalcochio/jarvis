// JARVIS Drive: o modo carro do app do celular (a interface fica em lib/phone/).
// Aqui ficam as ferramentas que só fazem sentido nele: abrir uma rota no celular e mandar o link do modo carro.
const { shell } = require('electron');

const mapsUrl = (dest) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
const wazeUrl = (dest) => `https://waze.com/ul?q=${encodeURIComponent(dest)}&navigate=yes`;

module.exports = {
  name: 'drive',
  tools: [
    {
      name: 'drive_navigate',
      description: 'Abre uma rota de carro até um destino ("me leva para o shopping Ibirapuera", "como chego na Av. Paulista 1000", "rota para casa da minha mãe"). No celular aparece um botão grande para abrir no Google Maps ou no Waze.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Destino como o usuário falou, com cidade se ele disse (ex: "Shopping Ibirapuera, São Paulo")' },
          app: { type: 'string', enum: ['maps', 'waze'], description: 'Só se o usuário pediu um app específico' },
        },
        required: ['destination'],
      },
      async run({ destination, app }, ctx) {
        const dest = destination.trim();
        if (ctx.phonecam.connected) {
          ctx.phonecam.send({ t: 'navigate', dest, app: app || null, maps: mapsUrl(dest), waze: wazeUrl(dest) });
          return { ok: true, shown_on_phone: true, how_to_answer: 'Diga em poucas palavras que a rota está no celular, é só tocar para abrir. Nada de descrever o caminho.' };
        }
        shell.openExternal(app === 'waze' ? wazeUrl(dest) : mapsUrl(dest));
        return { ok: true, opened_on_pc: true, how_to_answer: 'Diga que abriu a rota no navegador do PC (o celular não está conectado).' };
      },
    },
    {
      name: 'drive_link',
      description: 'Manda no Telegram o link do JARVIS Drive (modo carro) para abrir no celular ("manda o link do modo carro").',
      parameters: { type: 'object', properties: {} },
      async run(_, ctx) {
        if (!ctx.phonecam.running) await ctx.phonecam.start();
        await ctx.phonecam.startRemote?.().catch(() => {});
        const info = ctx.phonecam.info();
        if (!info.driveUrl) return { ok: false, error: 'O Tailscale não está conectado neste PC. Abra o Tailscale e entre na conta.' };
        if (!ctx.sendTelegram) return { ok: false, error: 'O Telegram não está configurado', link: info.driveUrl };
        await ctx.sendTelegram(`🚗 <b>JARVIS Drive</b>\nAbra no celular (com o Tailscale ligado) e adicione à tela inicial:\n${info.driveUrl}`);
        return { ok: true, sent: true };
      },
    },
  ],
};
