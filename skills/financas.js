// Gestor financeiro pessoal: gastos e entradas, orçamentos por categoria, contas fixas com aviso de
// vencimento e resumo do mês (painel visual no PC, que no Telegram vira imagem). Tudo em data/finance.json.
const path = require('path');

const CATEGORIES = {
  'Alimentação': { icon: '🍔', words: ['ifood', 'restaurante', 'lanche', 'almoço', 'almoco', 'jantar', 'pizza', 'hamburguer', 'padaria', 'café', 'cafe', 'delivery', 'rappi', 'bar'] },
  'Mercado': { icon: '🛒', words: ['mercado', 'supermercado', 'feira', 'atacadão', 'atacadao', 'assai', 'carrefour', 'hortifruti', 'açougue', 'acougue'] },
  'Transporte': { icon: '🚗', words: ['uber', '99', 'gasolina', 'combustível', 'combustivel', 'posto', 'estacionamento', 'ônibus', 'onibus', 'metrô', 'metro', 'pedágio', 'pedagio', 'ipva', 'mecânico', 'mecanico'] },
  'Moradia': { icon: '🏠', words: ['aluguel', 'condomínio', 'condominio', 'iptu', 'reforma', 'móveis', 'moveis'] },
  'Contas': { icon: '💡', words: ['luz', 'energia', 'água', 'agua', 'internet', 'gás', 'gas', 'telefone', 'celular', 'plano'] },
  'Saúde': { icon: '💊', words: ['farmácia', 'farmacia', 'remédio', 'remedio', 'médico', 'medico', 'consulta', 'exame', 'dentista', 'academia', 'plano de saúde'] },
  'Lazer': { icon: '🎮', words: ['cinema', 'show', 'jogo', 'game', 'steam', 'viagem', 'passeio', 'balada', 'festa', 'ingresso'] },
  'Assinaturas': { icon: '📺', words: ['netflix', 'spotify', 'youtube', 'prime', 'disney', 'hbo', 'max', 'icloud', 'chatgpt', 'claude', 'assinatura', 'github', 'copilot'] },
  'Compras': { icon: '🛍', words: ['roupa', 'tênis', 'tenis', 'amazon', 'mercado livre', 'shopee', 'shein', 'presente', 'eletrônico', 'eletronico'] },
  'Educação': { icon: '📚', words: ['curso', 'livro', 'faculdade', 'escola', 'udemy', 'alura'] },
  'Investimentos': { icon: '📈', words: ['investimento', 'tesouro', 'cdb', 'ações', 'acoes', 'cripto', 'bitcoin', 'reserva'] },
  'Renda': { icon: '💰', words: ['salário', 'salario', 'freela', 'freelance', 'pix recebido', 'pagamento recebido', 'reembolso', 'venda'] },
  'Outros': { icon: '•', words: [] },
};
const CAT_NAMES = Object.keys(CATEGORIES);

let data = { transactions: [], budgets: {}, bills: [], lastMonthReport: null, lastBillCheck: null };
let ctxRef;
let file;

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD no fuso local
const monthOf = (date) => date.slice(0, 7);
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const round2 = (v) => Math.round(v * 100) / 100;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
const icon = (cat) => CATEGORIES[cat]?.icon || '•';

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function save() { ctxRef.writeJson(file, data); }

function parseAmount(v) {
  if (typeof v === 'number') return Math.abs(v);
  const s = String(v || '').replace(/[^\d,.-]/g, '');
  // "1.234,56" → 1234.56 ; "45,9" → 45.9 ; "45.90" → 45.9
  const n = /,\d{1,2}$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s.replace(/,/g, ''));
  return Math.abs(n);
}

// Categoria: a que o modelo mandou (se existir) ou um palpite pelas palavras da descrição
function pickCategory(category, description, type) {
  if (category) {
    const c = CAT_NAMES.find((n) => norm(n) === norm(category));
    if (c) return c;
  }
  const d = ` ${norm(description)} `;
  for (const [name, { words }] of Object.entries(CATEGORIES)) {
    if (words.some((w) => d.includes(` ${norm(w)} `) || d.includes(` ${norm(w)}`))) return name;
  }
  return type === 'income' ? 'Renda' : 'Outros';
}

function parseDate(date) {
  if (!date) return today();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const t = Date.parse(date);
  return isFinite(t) ? new Date(t).toLocaleDateString('sv-SE') : today();
}

function monthStats(ym) {
  const list = data.transactions.filter((t) => monthOf(t.date) === ym);
  const expenses = list.filter((t) => t.type === 'expense');
  const income = round2(list.filter((t) => t.type === 'income').reduce((a, t) => a + t.amount, 0));
  const spent = round2(expenses.reduce((a, t) => a + t.amount, 0));
  const byCat = {};
  for (const t of expenses) byCat[t.category] = round2((byCat[t.category] || 0) + t.amount);
  return { ym, list, expenses, income, spent, balance: round2(income - spent), byCat };
}

function budgetStatus(cat, ym = monthOf(today())) {
  const limit = data.budgets[cat];
  if (!limit) return null;
  const spent = monthStats(ym).byCat[cat] || 0;
  return { category: cat, spent, limit, percent: Math.round((spent / limit) * 100), left: round2(limit - spent) };
}

// Contas fixas do mês: status de cada uma (paga, vence em N dias, atrasada)
function billsOfMonth(ym = monthOf(today())) {
  const now = new Date();
  const dayNow = now.getDate();
  const isCurrent = ym === monthOf(today());
  return data.bills.map((b) => {
    const paid = (b.paid || []).includes(ym);
    const daysLeft = isCurrent ? b.day - dayNow : null;
    return { ...b, paid, daysLeft, status: paid ? 'paga' : daysLeft === null ? 'pendente' : daysLeft < 0 ? 'atrasada' : daysLeft === 0 ? 'vence hoje' : `vence em ${daysLeft} dia(s)` };
  }).sort((a, b) => a.day - b.day);
}

function findBill(ref) {
  const n = norm(ref);
  return data.bills.find((b) => b.id === ref) || data.bills.find((b) => norm(b.name) === n) || data.bills.find((b) => norm(b.name).includes(n) || n.includes(norm(b.name)));
}

function addTransaction({ type = 'expense', amount, description, category, date, method }) {
  const value = parseAmount(amount);
  if (!isFinite(value) || value <= 0) throw new Error('Valor inválido');
  const t = {
    id: newId(),
    type: type === 'income' ? 'income' : 'expense',
    amount: round2(value),
    description: String(description || '').trim().slice(0, 120) || (type === 'income' ? 'Entrada' : 'Gasto'),
    category: pickCategory(category, description, type),
    date: parseDate(date),
    method: method || null,
    at: Date.now(),
  };
  data.transactions.push(t);
  save();
  return t;
}

function payBill(b, { amount } = {}) {
  const ym = monthOf(today());
  b.paid = [...new Set([...(b.paid || []), ym])].slice(-24);
  const t = addTransaction({ type: 'expense', amount: amount || b.amount, description: b.name, category: b.category });
  t.billId = b.id;
  save();
  return t;
}

// ------------------------------------------------------------ painel visual

function summaryPanel(ym) {
  const s = monthStats(ym);
  const prev = monthStats(prevMonth(ym));
  const change = prev.spent ? ((s.spent - prev.spent) / prev.spent) * 100 : null;
  const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
  const cards = [
    { type: 'stat', title: 'ENTRADAS', value: brl(s.income), caption: `${s.list.filter((t) => t.type === 'income').length} lançamento(s)` },
    { type: 'stat', title: 'SAÍDAS', value: brl(s.spent), change, caption: prev.spent ? `${monthName(prev.ym).split(' ')[0]}: ${brl(prev.spent)}` : 'sem mês anterior' },
    { type: 'stat', title: 'SALDO', value: brl(s.balance), caption: s.balance >= 0 ? 'no azul' : 'no vermelho' },
  ];
  if (cats.length) {
    cards.push({ type: 'chart', kind: 'bar', title: 'Gastos por categoria', size: 'large', labels: cats.map(([c]) => c), series: [{ name: 'Gasto', values: cats.map(([, v]) => v) }], unit: 'R$' });
  }
  // gasto acumulado por dia: este mês x mês anterior
  const days = Number(ym === monthOf(today()) ? new Date().getDate() : new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate());
  const cumulative = (stats, upTo) => {
    let acc = 0;
    return Array.from({ length: upTo }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      acc += stats.expenses.filter((t) => t.date.slice(8, 10) === d).reduce((a, t) => a + t.amount, 0);
      return round2(acc);
    });
  };
  if (s.expenses.length && days > 1) {
    const series = [{ name: monthName(ym).split(' ')[0], values: cumulative(s, days) }];
    if (prev.expenses.length) series.push({ name: monthName(prev.ym).split(' ')[0], values: cumulative(prev, days) });
    cards.push({ type: 'chart', kind: 'line', title: 'Gasto acumulado no mês', size: 'large', labels: Array.from({ length: days }, (_, i) => String(i + 1)), series, unit: 'R$' });
  }
  const budgets = Object.keys(data.budgets).map((c) => budgetStatus(c, ym)).filter(Boolean);
  if (budgets.length) {
    cards.push({ type: 'table', title: 'Orçamentos', columns: ['Categoria', 'Gasto', 'Limite', 'Uso'], rows: budgets.map((b) => [`${icon(b.category)} ${b.category}`, brl(b.spent), brl(b.limit), `${b.percent}%${b.percent >= 100 ? ' ⚠' : ''}`]) });
  }
  const top = s.expenses.slice().sort((a, b) => b.amount - a.amount).slice(0, 6);
  if (top.length) {
    cards.push({ type: 'table', title: 'Maiores gastos', columns: ['Data', 'Descrição', 'Categoria', 'Valor'], rows: top.map((t) => [t.date.slice(8, 10) + '/' + t.date.slice(5, 7), t.description, t.category, brl(t.amount)]) });
  }
  const bills = ym === monthOf(today()) ? billsOfMonth(ym) : [];
  if (bills.length) {
    cards.push({ type: 'list', title: 'Contas fixas', items: bills.map((b) => ({ title: `${b.paid ? '✅' : b.status === 'atrasada' ? '🔴' : '⏳'} ${b.name} · ${brl(b.amount)}`, subtitle: `dia ${b.day} · ${b.status}` })) });
  }
  return { s, prev, change, cards };
}

// ------------------------------------------------------------ texto para o Telegram

function summaryText(ym = monthOf(today())) {
  const s = monthStats(ym);
  const prev = monthStats(prevMonth(ym));
  const lines = [`💰 **${monthName(ym)[0].toUpperCase() + monthName(ym).slice(1)}**`, ''];
  lines.push(`Entradas: **${brl(s.income)}**`);
  lines.push(`Saídas: **${brl(s.spent)}**${prev.spent ? ` (${s.spent >= prev.spent ? '▲' : '▼'} ${Math.abs(Math.round(((s.spent - prev.spent) / prev.spent) * 100))}% vs mês passado)` : ''}`);
  lines.push(`Saldo: **${brl(s.balance)}** ${s.balance >= 0 ? '🟢' : '🔴'}`);
  const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    lines.push('', '**Por categoria**');
    for (const [c, v] of cats.slice(0, 8)) {
      const b = budgetStatus(c, ym);
      lines.push(`${icon(c)} ${c}: ${brl(v)}${b ? ` · ${b.percent}% do orçamento${b.percent >= 100 ? ' ⚠' : ''}` : ''}`);
    }
  } else {
    lines.push('', 'Nenhum gasto registrado ainda. Mande algo como "gastei 45 no ifood".');
  }
  const pending = ym === monthOf(today()) ? billsOfMonth(ym).filter((b) => !b.paid) : [];
  if (pending.length) {
    lines.push('', '**Contas a pagar**');
    for (const b of pending) lines.push(`${b.status === 'atrasada' ? '🔴' : '⏳'} ${b.name} · ${brl(b.amount)} · ${b.status}`);
  }
  return lines.join('\n');
}

function recentText(n = 10) {
  const list = data.transactions.slice(-n).reverse();
  if (!list.length) return '🧾 Nenhum lançamento ainda.';
  return ['🧾 **Últimos lançamentos**', '', ...list.map((t) => `${t.type === 'income' ? '🟢 +' : '🔴 −'}${brl(t.amount)} · ${t.description} · ${icon(t.category)} ${t.category} · ${t.date.slice(8, 10)}/${t.date.slice(5, 7)}`)].join('\n');
}

const MENU_BUTTONS = [
  [{ text: '📊 Painel do mês', data: 'fin:panel' }, { text: '🧾 Últimos', data: 'fin:recent' }],
  [{ text: '📅 Contas', data: 'fin:bills' }, { text: '↩ Desfazer último', data: 'fin:undo' }],
];

function billsMessage() {
  const bills = billsOfMonth();
  if (!bills.length) return { text: '📅 Nenhuma conta fixa cadastrada. Diga algo como "cadastra a conta de luz, 180 reais, vence dia 10".' };
  return {
    text: ['📅 **Contas do mês**', '', ...bills.map((b) => `${b.paid ? '✅' : b.status === 'atrasada' ? '🔴' : '⏳'} ${b.name} · ${brl(b.amount)} · dia ${b.day} · ${b.status}`)].join('\n'),
    buttons: bills.filter((b) => !b.paid).slice(0, 8).map((b) => [{ text: `✓ Paguei ${b.name.slice(0, 28)}`, data: `fin:pay:${b.id}` }]),
  };
}

// ------------------------------------------------------------ avisos automáticos

function checkAlerts() {
  const now = new Date();
  const d = today();
  if (now.getHours() < 9 || data.lastBillCheck === d) return;
  data.lastBillCheck = d;
  // contas vencendo em até 2 dias (ou atrasadas)
  const due = billsOfMonth().filter((b) => !b.paid && b.daysLeft <= 2);
  if (due.length && ctxRef.notifyRemote) {
    const text = `📅 Contas para pagar:\n${due.map((b) => `• ${b.name} · ${brl(b.amount)} · ${b.status}`).join('\n')}`;
    ctxRef.notifyRemote(text, { phone: true, buttons: due.slice(0, 6).map((b) => [{ text: `✓ Paguei ${b.name.slice(0, 28)}`, data: `fin:pay:${b.id}` }]) });
  }
  // dia 1: fechamento do mês anterior
  const last = prevMonth(monthOf(d));
  if (now.getDate() === 1 && data.lastMonthReport !== last && monthStats(last).list.length && ctxRef.notifyRemote) {
    data.lastMonthReport = last;
    ctxRef.notifyRemote(`Fechamento do mês\n\n${summaryText(last)}`, { phone: false });
  }
  save();
}

// ------------------------------------------------------------ API para o Telegram e a interface

const api = {
  summaryText,
  recentText,
  billsMessage,
  menuButtons: MENU_BUTTONS,
  // Cliques nos botões "fin:..." do Telegram. Devolve { toast, text?, buttons?, edit? }
  async button(arg) {
    const [act, id] = arg.split(':');
    if (act === 'recent') return { text: recentText() };
    if (act === 'bills') return { ...billsMessage() };
    if (act === 'undo') {
      const t = data.transactions.pop();
      if (!t) return { toast: 'Nada para desfazer' };
      if (t.billId) { const b = data.bills.find((x) => x.id === t.billId); if (b) b.paid = (b.paid || []).filter((m) => m !== monthOf(t.date)); }
      save();
      return { toast: `Removido: ${brl(t.amount)} ${t.description}`.slice(0, 190) };
    }
    if (act === 'pay') {
      const b = data.bills.find((x) => x.id === id);
      if (!b) return { toast: 'Conta não encontrada' };
      if ((b.paid || []).includes(monthOf(today()))) return { toast: 'Já estava paga' };
      payBill(b);
      return { toast: `✓ ${b.name} paga (${brl(b.amount)})`, edit: billsMessage() };
    }
    if (act === 'receipt') {
      const r = pendingReceipts.get(id);
      if (!r) return { toast: 'Esse comprovante expirou' };
      pendingReceipts.delete(id);
      const t = addTransaction(r);
      return { toast: `✓ Registrado: ${brl(t.amount)} em ${t.category}`, edit: { text: `🧾 Registrado: **${brl(t.amount)}** · ${t.description} · ${icon(t.category)} ${t.category}` } };
    }
    if (act === 'skip') { pendingReceipts.delete(id); return { toast: 'Ignorado', edit: { text: '🧾 Comprovante ignorado.' } }; }
    return { toast: null };
  },
  // Comprovante lido pela visão (foto no Telegram): fica esperando o "Registrar"
  stageReceipt(r) {
    const id = newId();
    pendingReceipts.set(id, r);
    setTimeout(() => pendingReceipts.delete(id), 6 * 3600 * 1000);
    return id;
  },
  categories: CAT_NAMES,
};
const pendingReceipts = new Map();

// ------------------------------------------------------------ skill

module.exports = {
  name: 'financas',
  api,
  init(ctx) {
    ctxRef = ctx;
    file = path.join(ctx.dataDir, 'finance.json');
    data = { ...data, ...ctx.readJson(file, {}) };
    setInterval(checkAlerts, 15 * 60 * 1000);
    setTimeout(checkAlerts, 60 * 1000);
  },
  tools: [
    {
      name: 'finance_add',
      description: `Registra um GASTO ou uma ENTRADA de dinheiro ("gastei 45 no ifood", "paguei 120 de gasolina", "recebi 3500 de salário", "caiu um pix de 200 do freela"). Categorias: ${CAT_NAMES.join(', ')}. Depois confirme em UMA frase curta com o valor e a categoria; se vier budget_alert, avise.`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['expense', 'income'], description: 'expense = gasto, income = entrada' },
          amount: { type: 'number', description: 'Valor em reais' },
          description: { type: 'string', description: 'O que foi (ex: "iFood", "Gasolina", "Salário")' },
          category: { type: 'string', enum: CAT_NAMES },
          date: { type: 'string', description: 'YYYY-MM-DD; omita se foi hoje ("ontem" → calcule a data)' },
          method: { type: 'string', description: 'Opcional: pix, crédito, débito, dinheiro' },
        },
        required: ['type', 'amount', 'description'],
      },
      async run(args) {
        const t = addTransaction(args);
        const out = { ok: true, id: t.id, saved: `${t.type === 'income' ? '+' : '-'}${brl(t.amount)} · ${t.description} · ${t.category} · ${t.date}` };
        if (t.type === 'expense') {
          const b = budgetStatus(t.category, monthOf(t.date));
          if (b && b.percent >= 80) out.budget_alert = b.percent >= 100 ? `Estourou o orçamento de ${t.category}: ${brl(b.spent)} de ${brl(b.limit)} (${b.percent}%).` : `Já usou ${b.percent}% do orçamento de ${t.category} (restam ${brl(b.left)}).`;
          out.month_spent = brl(monthStats(monthOf(t.date)).spent);
        }
        return out;
      },
    },
    {
      name: 'finance_undo',
      description: 'Apaga um lançamento financeiro: o último ("apaga o último gasto", "desfaz") ou um id específico (de finance_list).',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Opcional; sem id apaga o último' } } },
      async run({ id }) {
        const t = id ? data.transactions.find((x) => x.id === id) : data.transactions[data.transactions.length - 1];
        if (!t) return { ok: false, error: 'Lançamento não encontrado' };
        data.transactions = data.transactions.filter((x) => x !== t);
        if (t.billId) { const b = data.bills.find((x) => x.id === t.billId); if (b) b.paid = (b.paid || []).filter((m) => m !== monthOf(t.date)); }
        save();
        return { ok: true, removed: `${brl(t.amount)} · ${t.description} · ${t.date}` };
      },
    },
    {
      name: 'finance_summary',
      description: 'Resumo financeiro do mês ("quanto gastei esse mês?", "como estão minhas finanças?", "gastos de setembro"). Por padrão mostra o painel visual (no Telegram vira imagem). Fale só o principal em 1 a 2 frases.',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'YYYY-MM; omita para o mês atual' },
          show: { type: 'boolean', description: 'Mostrar o painel visual (padrão true)' },
        },
      },
      async run({ month, show = true }, ctx) {
        const ym = /^\d{4}-\d{2}$/.test(month || '') ? month : monthOf(today());
        const { s, prev, change, cards } = summaryPanel(ym);
        if (show && s.list.length) {
          ctx.send('visual', { kicker: 'J.A.R.V.I.S. · FINANÇAS', title: monthName(ym)[0].toUpperCase() + monthName(ym).slice(1), subtitle: `${s.list.length} lançamento(s)`, cards: cards.map(ctx.sanitizeCard || ((c) => c)).filter(Boolean) });
        }
        const top = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
        return {
          month: monthName(ym),
          income: brl(s.income), spent: brl(s.spent), balance: brl(s.balance),
          vs_last_month: change === null ? 'sem dados do mês anterior' : `${change >= 0 ? '+' : ''}${change.toFixed(0)}% (${brl(prev.spent)})`,
          top_categories: top.map(([c, v]) => `${c}: ${brl(v)}`),
          budgets_over_80: Object.keys(data.budgets).map((c) => budgetStatus(c, ym)).filter((b) => b && b.percent >= 80).map((b) => `${b.category} ${b.percent}%`),
          bills_pending: ym === monthOf(today()) ? billsOfMonth().filter((b) => !b.paid).map((b) => `${b.name} ${brl(b.amount)} (${b.status})`) : [],
          shown_on_screen: !!(show && s.list.length),
          how_to_answer: s.list.length ? 'Fale 1 a 2 frases: quanto saiu, o saldo e o destaque (categoria que mais pesou ou orçamento estourado). Não leia a lista.' : 'Diga que ainda não há lançamentos neste mês e como registrar (ex: "gastei 45 no ifood").',
        };
      },
    },
    {
      name: 'finance_list',
      description: 'Lista lançamentos ("o que eu gastei com uber esse mês?", "meus últimos gastos", "quanto gastei no mercado em setembro?"). Para muitos itens, mostre com show_in_chat.',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'YYYY-MM (opcional)' },
          category: { type: 'string', enum: CAT_NAMES },
          query: { type: 'string', description: 'Texto da descrição (ex: "uber")' },
          limit: { type: 'number' },
        },
      },
      async run({ month, category, query, limit = 15 }) {
        let list = data.transactions;
        if (month) list = list.filter((t) => monthOf(t.date) === month);
        if (category) list = list.filter((t) => t.category === pickCategory(category, '', 'expense'));
        if (query) list = list.filter((t) => norm(t.description).includes(norm(query)));
        const total = round2(list.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0));
        return {
          count: list.length,
          total_spent: brl(total),
          items: list.slice(-Math.min(50, limit)).reverse().map((t) => ({ id: t.id, date: t.date, type: t.type, amount: brl(t.amount), description: t.description, category: t.category })),
        };
      },
    },
    {
      name: 'finance_budget',
      description: 'Define o orçamento mensal de uma categoria ("meu limite de lazer é 300 por mês"); limit 0 remove. Sem argumentos, devolve como estão os orçamentos.',
      parameters: {
        type: 'object',
        properties: { category: { type: 'string', enum: CAT_NAMES }, limit: { type: 'number', description: 'Reais por mês' } },
      },
      async run({ category, limit }) {
        if (category && typeof limit === 'number') {
          const cat = pickCategory(category, '', 'expense');
          if (limit > 0) data.budgets[cat] = round2(limit); else delete data.budgets[cat];
          save();
        }
        return { budgets: Object.keys(data.budgets).map((c) => budgetStatus(c)).map((b) => ({ ...b, spent: brl(b.spent), limit: brl(b.limit), left: brl(b.left) })) };
      },
    },
    {
      name: 'finance_bill',
      description: 'Contas fixas mensais (luz, aluguel, internet, cartão...). action: "add" cadastra (name, amount, day = dia do vencimento), "paid" marca como paga este mês (registra o gasto), "remove" apaga, "list" mostra o status do mês. O JARVIS avisa no Telegram 2 dias antes do vencimento.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'paid', 'remove', 'list'] },
          name: { type: 'string' },
          amount: { type: 'number', description: 'Valor; em "paid", o valor real se for diferente do cadastrado' },
          day: { type: 'number', description: 'Dia do vencimento (1 a 31)' },
          category: { type: 'string', enum: CAT_NAMES },
        },
        required: ['action'],
      },
      async run({ action, name, amount, day, category }) {
        if (action === 'add') {
          if (!name || !(parseAmount(amount) > 0) || !(day >= 1 && day <= 31)) return { ok: false, error: 'Preciso do nome, do valor e do dia do vencimento.' };
          const existing = findBill(name);
          const b = existing || { id: newId(), paid: [] };
          Object.assign(b, { name: name.trim(), amount: round2(parseAmount(amount)), day: Math.round(day), category: pickCategory(category || 'Contas', name, 'expense') });
          if (!existing) data.bills.push(b);
          save();
          return { ok: true, saved: `${b.name} · ${brl(b.amount)} · todo dia ${b.day}`, updated: !!existing };
        }
        if (action === 'paid') {
          const b = name && findBill(name);
          if (!b) return { ok: false, error: 'Conta não encontrada', bills: data.bills.map((x) => x.name) };
          if ((b.paid || []).includes(monthOf(today()))) return { ok: true, already_paid: true };
          const t = payBill(b, { amount: parseAmount(amount) || undefined });
          return { ok: true, paid: `${b.name} · ${brl(t.amount)}` };
        }
        if (action === 'remove') {
          const b = name && findBill(name);
          if (!b) return { ok: false, error: 'Conta não encontrada' };
          data.bills = data.bills.filter((x) => x !== b);
          save();
          return { ok: true, removed: b.name };
        }
        return { bills: billsOfMonth().map((b) => ({ name: b.name, amount: brl(b.amount), day: b.day, status: b.status })) };
      },
    },
  ],
};
