// Carrega todas as skills da pasta e expõe as ferramentas no formato do tool calling.
// Para criar uma skill nova: adicione um arquivo aqui com { name, tools: [{ name, description, parameters, run }], init? }.
//
// Ferramentas perigosas declaram `confirm(args, ctx) => "descrição do que vai acontecer"`.
// A primeira chamada só devolve um pedido de confirmação; a execução só acontece numa chamada
// com confirmed=true feita num turno POSTERIOR (ou seja, depois de uma nova fala do usuário).
// Isso impede o modelo de se autoconfirmar.
const fs = require('fs');
const path = require('path');

const CONFIRM_TTL = 3 * 60 * 1000;
const AFFIRMATIVE = /\b(sim|pode|confirm[oa]|manda|faz|fa[çc]a|vai|bora|ok|okay|beleza|claro|isso|positivo|com certeza|yes)\b/i;
const NEGATIVE = /(^|\s)(n[ãa]o|cancela|espera|nem)\b/i;

function loadSkills(ctx) {
  const skills = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => require(path.join(__dirname, f)));

  const tools = new Map();
  const skillOf = new Map(); // nome da ferramenta -> nome da skill
  for (const skill of skills) {
    if (skill.init) skill.init(ctx);
    for (const tool of skill.tools || []) { tools.set(tool.name, tool); skillOf.set(tool.name, skill.name); }
  }

  const pending = new Map(); // nome da ferramenta -> { key, turn, at }
  const keyOf = (args) => JSON.stringify(Object.keys(args).filter((k) => k !== 'confirmed').sort().map((k) => [k, args[k]]));

  function definition(t) {
    let parameters = t.parameters;
    if (t.confirm) {
      parameters = {
        ...parameters,
        properties: {
          ...parameters.properties,
          confirmed: { type: 'boolean', description: 'Só true depois que o usuário respondeu "sim" ao seu pedido de confirmação.' },
        },
      };
    }
    const description = t.confirm
      ? `${t.description} AÇÃO SENSÍVEL: chame direto (sem confirmed); o sistema devolve o pedido de confirmação. Não pergunte por conta própria antes de chamar.`
      : t.description;
    return { type: 'function', function: { name: t.name, description, parameters } };
  }

  async function checkConfirmation(tool, args) {
    const { confirmed, ...rest } = args;
    const key = keyOf(rest);
    const p = pending.get(tool.name);
    const said = ctx.lastUserText || '';
    const userAgreed = AFFIRMATIVE.test(said) && !NEGATIVE.test(said);
    if (confirmed && p && p.key === key && p.turn < ctx.turnId && Date.now() - p.at < CONFIRM_TTL && userAgreed) {
      pending.delete(tool.name);
      return null; // liberado
    }
    if (confirmed && p && p.turn >= ctx.turnId) {
      return { needs_confirmation: true, error: 'A confirmação precisa vir do usuário. Pergunte e espere a resposta dele.' };
    }
    if (confirmed && p && !userAgreed) {
      pending.delete(tool.name);
      return { cancelled: true, reason: 'O usuário não confirmou. Não execute.' };
    }
    const summary = await tool.confirm(rest, ctx);
    if (summary && summary.error) return summary;
    pending.set(tool.name, { key, turn: ctx.turnId, at: Date.now() });
    return {
      needs_confirmation: true,
      what_will_happen: summary,
      instruction: 'Fale em uma frase o que vai acontecer e pergunte "Confirma?". Se o usuário disser sim, chame esta ferramenta de novo com EXATAMENTE os mesmos argumentos de args_after_yes.',
      args_after_yes: { ...rest, confirmed: true },
    };
  }

  return {
    skills,
    // Ferramentas enviadas ao modelo, sem as das skills desligadas nas Configurações
    definitions(disabled = []) {
      return [...tools.values()].filter((t) => !disabled.includes(skillOf.get(t.name))).map(definition);
    },
    // Cliques na interface: o usuário já agiu diretamente, então não passa pela confirmação por voz
    // (a própria tela pede confirmação antes de ações destrutivas)
    async runDirect(name, args) {
      const tool = tools.get(name);
      if (!tool) return { error: `Ferramenta desconhecida: ${name}` };
      try {
        return (await tool.run(args || {}, ctx)) ?? { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    async run(name, args) {
      const tool = tools.get(name);
      if (!tool) return { error: `Ferramenta desconhecida: ${name}` };
      if ((ctx.config.disabledSkills || []).includes(skillOf.get(name))) return { error: 'Essa função está desligada nas Configurações' };
      args = args || {};
      try {
        if (tool.confirm) {
          const blocked = await checkConfirmation(tool, args);
          if (blocked) return blocked;
        }
        const { confirmed, ...clean } = args;
        return (await tool.run(clean, ctx)) ?? { ok: true };
      } catch (e) {
        console.error(`[skill] ${name} falhou:`, e);
        return { ok: false, error: e.message };
      }
    },
    get: (name) => skills.find((s) => s.name === name),
  };
}

module.exports = { loadSkills };
