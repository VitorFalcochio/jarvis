// Bot do Telegram: falar com o JARVIS de qualquer lugar, receber alertas e controlar o PC por botões.
// Usa long polling (getUpdates), então não precisa abrir porta no roteador.
// Segurança: só responde ao chat que fez o pareamento com o código mostrado no JARVIS.
const crypto = require('crypto');

// Comandos que aparecem ao digitar "/" no Telegram
const COMMANDS = [
  { command: 'menu', description: 'Botões de ação rápida' },
  { command: 'status', description: 'Como está o PC agora' },
  { command: 'print', description: 'Print da tela do PC' },
  { command: 'briefing', description: 'Briefing do dia' },
  { command: 'musica', description: 'Controles da música' },
  { command: 'tarefas', description: 'Minhas tarefas' },
  { command: 'financas', description: 'Resumo financeiro do mês' },
  { command: 'contas', description: 'Contas fixas do mês' },
  { command: 'sentinela', description: 'Ligar/desligar o modo sentinela' },
];

// Converte o markdown que o modelo costuma escrever para o HTML que o Telegram aceita
function toHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = [];
  let t = String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre>${esc(code.trim())}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  t = esc(t)
    .replace(/&lt;(\/?(?:b|i|code))&gt;/g, '<$1>') // tags simples escritas à mão nas mensagens (ex: "<b>Tarefas</b>")
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

const keyboard = (buttons) => (buttons ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined);

class Telegram {
  constructor({ token, chatId, onPaired, onText, onVoice, onPhoto, onCallback }) {
    this.token = token;
    this.chatId = chatId || null;
    this.onPaired = onPaired;
    this.onText = onText;
    this.onVoice = onVoice;
    this.onPhoto = onPhoto;
    this.onCallback = onCallback;
    this.offset = 0;
    this.running = false;
    this.pairCode = String(crypto.randomInt(100000, 1000000));
    this.bot = null;
  }

  async api(method, body, { form } = {}) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: form ? undefined : { 'Content-Type': 'application/json' },
      body: form || JSON.stringify(body || {}),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 65000 : 60000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  async start() {
    this.bot = await this.api('getMe'); // valida o token
    this.api('setMyCommands', { commands: COMMANDS }).catch(() => {});
    this.running = true;
    this.loop();
    return this.bot;
  }

  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) this.handle(u.message).catch((e) => console.error('[telegram]', e.message));
          if (u.callback_query) this.handleCallback(u.callback_query).catch((e) => console.error('[telegram]', e.message));
        }
      } catch (e) {
        if (!this.running) break;
        console.error('[telegram] polling:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async handle(msg) {
    const chat = msg.chat.id;
    const text = (msg.text || msg.caption || '').trim();

    // Pareamento: o primeiro chat que mandar o código vira o dono
    if (!this.chatId) {
      if (text.replace(/^\/start\s*/, '').trim() === this.pairCode) {
        this.chatId = chat;
        this.onPaired(chat, msg.from);
        await this.send(`Pareado, ${msg.from.first_name}. A partir de agora sou seu JARVIS por aqui também.\n\nMande texto, áudio ou foto, ou use /menu.`);
      } else {
        await this.send('Olá. Para parear, envie o código de 6 dígitos que aparece nas Configurações do JARVIS.', { chatId: chat });
      }
      return;
    }
    if (chat !== this.chatId) {
      await this.send('Este JARVIS é privado.', { chatId: chat }).catch(() => {});
      return;
    }

    this.typing();
    if (msg.voice || msg.audio) {
      await this.onVoice(await this.download((msg.voice || msg.audio).file_id));
    } else if (msg.photo) {
      await this.onPhoto(await this.download(msg.photo[msg.photo.length - 1].file_id), text);
    } else if (text) {
      await this.onText(text === '/start' ? '/menu' : text);
    }
  }

  async handleCallback(q) {
    if (q.message?.chat?.id !== this.chatId) { await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Privado' }).catch(() => {}); return; }
    const toast = await this.onCallback(q.data, q.message).catch((e) => `Erro: ${e.message}`);
    await this.api('answerCallbackQuery', { callback_query_id: q.id, text: typeof toast === 'string' ? toast.slice(0, 190) : undefined }).catch(() => {});
  }

  typing(action = 'typing') { if (this.chatId) this.api('sendChatAction', { chat_id: this.chatId, action }).catch(() => {}); }

  // Mensagem de voz (bolinha com a onda): precisa ser OGG/Opus
  async sendVoice(ogg, caption = '', { buttons } = {}) {
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    if (caption) { form.append('caption', toHtml(caption).slice(0, 1000)); form.append('parse_mode', 'HTML'); }
    if (buttons) form.append('reply_markup', JSON.stringify(keyboard(buttons)));
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'jarvis.ogg');
    return this.api('sendVoice', null, { form });
  }

  async download(fileId) {
    const { file_path: path } = await this.api('getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${path}`, { signal: AbortSignal.timeout(30000) });
    return Buffer.from(await res.arrayBuffer());
  }

  // Texto com formatação (HTML); se o Telegram recusar a formatação, manda sem
  async send(text, { chatId = this.chatId, buttons, html = true } = {}) {
    if (!chatId || !text) return null;
    let last = null;
    const parts = [];
    for (let i = 0; i < text.length; i += 3800) parts.push(text.slice(i, i + 3800));
    for (const [i, part] of parts.entries()) {
      const markup = i === parts.length - 1 ? keyboard(buttons) : undefined;
      try {
        last = await this.api('sendMessage', { chat_id: chatId, text: html ? toHtml(part) : part, parse_mode: html ? 'HTML' : undefined, reply_markup: markup, disable_web_page_preview: true });
      } catch {
        last = await this.api('sendMessage', { chat_id: chatId, text: part, reply_markup: markup });
      }
    }
    return last;
  }

  async edit(messageId, text, { buttons } = {}) {
    if (!messageId) return;
    try {
      await this.api('editMessageText', { chat_id: this.chatId, message_id: messageId, text: toHtml(text), parse_mode: 'HTML', reply_markup: keyboard(buttons), disable_web_page_preview: true });
    } catch (e) {
      if (!/not modified/.test(e.message)) await this.api('editMessageText', { chat_id: this.chatId, message_id: messageId, text, reply_markup: keyboard(buttons) }).catch(() => {});
    }
  }

  async sendPhoto(image, caption = '', { buttons } = {}) {
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    if (caption) { form.append('caption', toHtml(caption).slice(0, 1000)); form.append('parse_mode', 'HTML'); }
    if (buttons) form.append('reply_markup', JSON.stringify(keyboard(buttons)));
    form.append('photo', new Blob([image], { type: 'image/jpeg' }), 'jarvis.jpg');
    return this.api('sendPhoto', null, { form });
  }

  // Várias imagens de uma vez (ex: print dos dois monitores)
  async sendAlbum(images, caption = '') {
    if (images.length === 1) return this.sendPhoto(images[0], caption);
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    form.append('media', JSON.stringify(images.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}) }))));
    images.forEach((img, i) => form.append(`p${i}`, new Blob([img], { type: 'image/jpeg' }), `tela${i + 1}.jpg`));
    return this.api('sendMediaGroup', null, { form });
  }

  async sendDocument(content, filename, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    return this.api('sendDocument', null, { form });
  }

  // Alertas por iniciativa do JARVIS (sentinela, lembretes, agente de código)
  async notify(text, image, buttons) {
    if (!this.chatId) return;
    if (image) await this.sendPhoto(image, `⚠ ${text}`, { buttons });
    else await this.send(`🔔 ${text}`, { buttons });
  }
}

module.exports = { Telegram, toHtml };
