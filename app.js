(function () {
  "use strict";

  const STORAGE_KEY = "fluxo_financeiro_v1";

  const DEFAULT_CATEGORIES = [
    { id: "salario", label: "Salário / renda fixa", kind: "income" },
    { id: "freelance", label: "Freelance / extras", kind: "income" },
    { id: "investimentos", label: "Investimentos", kind: "income" },
    { id: "moradia", label: "Moradia", kind: "expense" },
    { id: "alimentacao", label: "Alimentação", kind: "expense" },
    { id: "transporte", label: "Transporte", kind: "expense" },
    { id: "saude", label: "Saúde", kind: "expense" },
    { id: "lazer", label: "Lazer", kind: "expense" },
    { id: "servicos", label: "Assinaturas / serviços", kind: "expense" },
    { id: "outros", label: "Outros", kind: "both" },
  ];

  /** @type {{ transactions: Array<object>, openingBalance: number, categories: Array<object> }} */
  let state = loadState();

  /** Referências ao DOM (preenchidas em startApp após o documento estar pronto). */
  let el;

  function migrateLegacyFinancas() {
    try {
      const legacy = localStorage.getItem("financas");
      if (!legacy) return null;
      const rows = JSON.parse(legacy);
      if (!Array.isArray(rows)) return null;
      const transactions = rows.map((row) => ({
        id: uid(),
        description: String(row.desc || "").trim() || "Lançamento",
        amount: Math.abs(Number(row.valor) || 0),
        kind: row.tipo === "entrada" ? "income" : "expense",
        categoryId: row.tipo === "entrada" ? "salario" : "outros",
        month: row.mes || monthFromDate(),
        status: "realized",
        recurrence: "none",
        createdAt: new Date().toISOString(),
      }));
      localStorage.removeItem("financas");
      return { openingBalance: 0, categories: DEFAULT_CATEGORIES.slice(), transactions };
    } catch {
      return null;
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const migrated = migrateLegacyFinancas();
        if (migrated) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
        return defaultState();
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.transactions)) return defaultState();
      return {
        openingBalance: typeof parsed.openingBalance === "number" ? parsed.openingBalance : 0,
        categories:
          Array.isArray(parsed.categories) && parsed.categories.length
            ? parsed.categories
            : DEFAULT_CATEGORIES.slice(),
        transactions: parsed.transactions,
      };
    } catch {
      return defaultState();
    }
  }

  function defaultState() {
    return {
      openingBalance: 0,
      categories: DEFAULT_CATEGORIES.slice(),
      transactions: [],
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(36).slice(2);
  }

  function monthFromDate(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function compareMonth(a, b) {
    return a.localeCompare(b);
  }

  function addMonths(ym, delta) {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return monthFromDate(d);
  }

  function parseMoneyInput(el) {
    const v = parseFloat(String(el.value).replace(",", "."), 10);
    return Number.isFinite(v) ? v : NaN;
  }

  function formatBRL(n) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(n);
  }

  function categoriesForKind(kind) {
    return state.categories.filter((c) => c.kind === kind || c.kind === "both");
  }

  function appliesToMonth(t, ym) {
    if (t.recurrence === "monthly") return compareMonth(ym, t.month) >= 0;
    return t.month === ym;
  }

  /**
   * Fluxos do mês com recorrência mensal aplicada (template a partir do mês de referência).
   */
  function flowsForMonth(ym) {
    let incomeR = 0;
    let expenseR = 0;
    let incomeP = 0;
    let expenseP = 0;
    state.transactions.forEach((t) => {
      if (!appliesToMonth(t, ym)) return;
      const amt = t.amount;
      if (t.kind === "income") {
        if (t.status === "realized") incomeR += amt;
        else incomeP += amt;
      } else {
        if (t.status === "realized") expenseR += amt;
        else expenseP += amt;
      }
    });
    return {
      incomeR,
      expenseR,
      incomeP,
      expenseP,
      netTotal: incomeR + incomeP - expenseR - expenseP,
      netRealized: incomeR - expenseR,
      netPlanned: incomeP - expenseP,
    };
  }

  function minAnchorMonth() {
    if (!state.transactions.length) return monthFromDate();
    return state.transactions.reduce((best, t) => (compareMonth(t.month, best) < 0 ? t.month : best), state.transactions[0].month);
  }

  /** Saldo no início do mês `ym` (antes dos lançamentos daquele mês). */
  function balanceBeforeMonth(ym) {
    if (!state.transactions.length) return state.openingBalance;
    const m0 = minAnchorMonth();
    let bal = state.openingBalance;
    let m = m0;
    while (compareMonth(m, ym) < 0) {
      bal += flowsForMonth(m).netTotal;
      m = addMonths(m, 1);
    }
    return bal;
  }

  function sortedUniqueMonthsFromData() {
    return [...new Set(state.transactions.map((t) => t.month))].sort(compareMonth);
  }

  function chartMonthRange(back, ahead) {
    const todayYm = monthFromDate();
    let start = addMonths(todayYm, -back);
    const anchor = state.transactions.length ? minAnchorMonth() : start;
    if (compareMonth(anchor, start) < 0) start = anchor;
    const end = addMonths(todayYm, ahead);
    const list = [];
    let m = start;
    while (compareMonth(m, end) <= 0) {
      list.push(m);
      m = addMonths(m, 1);
    }
    return list;
  }

  function projectionSeries(back = 6, ahead = 14) {
    const months = chartMonthRange(back, ahead);
    const labels = [];
    const balances = [];
    if (!months.length) {
      return { labels, balances };
    }
    let bal = balanceBeforeMonth(months[0]);
    months.forEach((ym) => {
      bal += flowsForMonth(ym).netTotal;
      labels.push(ym);
      balances.push(bal);
    });
    return { labels, balances };
  }

  function categoryExpenseTotals(ymFilter) {
    const totals = {};
    const add = (catId, amt) => {
      const key = categoryLabel(catId);
      totals[key] = (totals[key] || 0) + amt;
    };
    if (ymFilter) {
      state.transactions.forEach((t) => {
        if (t.kind !== "expense") return;
        if (!appliesToMonth(t, ymFilter)) return;
        add(t.categoryId, t.amount);
      });
    } else {
      const todayYm = monthFromDate();
      for (let i = 0; i < 12; i++) {
        const ym = addMonths(todayYm, -i);
        state.transactions.forEach((t) => {
          if (t.kind !== "expense") return;
          if (!appliesToMonth(t, ym)) return;
          add(t.categoryId, t.amount);
        });
      }
    }
    return totals;
  }

  function categoryLabel(id) {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.label : id;
  }

  /** Texto agregado para enviar à IA (sem expor JSON bruto completo). */
  function buildFinancialSummaryForAi() {
    const lines = [];
    lines.push("=== RESUMO FINANCEIRO (BRL) — app Fluxo ===");
    lines.push("Moeda: BRL. Valores arredondados na exibição.");
    lines.push("Saldo inicial (antes do 1º mês com lançamentos): " + formatBRL(state.openingBalance));
    lines.push("Gerado em: " + new Date().toISOString());
    lines.push("");

    const monthsAll = sortedUniqueMonthsFromData();
    const months = monthsAll.slice(-24);

    if (!months.length) {
      lines.push("Nenhum lançamento cadastrado ainda.");
      return lines.join("\n");
    }

    lines.push("--- Por mês (últimos " + months.length + " com dados) — realizado / previsto / resultado ---");
    months.forEach((ym) => {
      const f = flowsForMonth(ym);
      lines.push("");
      lines.push(ym + " (" + formatMonthLabel(ym) + ")");
      lines.push(
        "  Receitas: realizado " +
          formatBRL(f.incomeR) +
          " | previsto " +
          formatBRL(f.incomeP)
      );
      lines.push(
        "  Despesas: realizado " +
          formatBRL(f.expenseR) +
          " | previsto " +
          formatBRL(f.expenseP)
      );
      lines.push("  Resultado líquido do mês (tudo): " + formatBRL(f.netTotal));
      lines.push("  Saldo acumulado ao fim do mês: " + formatBRL(balanceBeforeMonth(addMonths(ym, 1))));
    });

    lines.push("");
    lines.push("--- Despesas por categoria (janela de 12 meses, regra do app) ---");
    const catMap = categoryExpenseTotals(null);
    const sortedCat = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    if (!sortedCat.length) lines.push("  (nenhuma despesa na janela)");
    else sortedCat.slice(0, 20).forEach(([k, v]) => lines.push("  " + k + ": " + formatBRL(v)));

    lines.push("");
    lines.push("--- Itens com recorrência MENSAL (a partir do mês de referência) ---");
    const rec = state.transactions.filter((t) => t.recurrence === "monthly");
    if (!rec.length) lines.push("  (nenhum)");
    else
      rec.forEach((t) => {
        lines.push(
          "  Desde " +
            t.month +
            ": " +
            t.description +
            " | " +
            (t.kind === "income" ? "receita" : "despesa") +
            " " +
            formatBRL(t.amount) +
            " | " +
            t.status +
            " | " +
            categoryLabel(t.categoryId)
        );
      });

    lines.push("");
    lines.push("Total de lançamentos no cadastro: " + state.transactions.length);
    return lines.join("\n");
  }

  // ─── Monday.com integration ───────────────────────────────────────────────
  const MONDAY_BOARD_ID = "18407293573";
  const MONDAY_COLS = {
    date:       "date_mm24p4t0",
    value:      "numeric_mm245wmn",
    category:   "dropdown_mm245cyj",
    notes:      "text_mm24e62a",
    kind:       "color_mm24kjzr",
    status:     "color_mm24ay2x",
    recurrence: "color_mm26we75",
  };

  const MONDAY_DROPDOWN_MAP = {
    "1": "moradia",
    "2": "salario",
    "3": "cartao_de_credito",
    "4": "servicos",
    "5": "outros",
    "6": "outros",
  };
  const MONDAY_DROPDOWN_REVERSE = {
    "moradia": 1,
    "salario": 1, // não existe, usa Moradia como fallback — será corrigido abaixo
    "cartao_de_credito": 3,
    "servicos": 4,
    "outros": 5,
    "freelance": 5,
    "investimentos": 5,
    "alimentacao": 5,
    "transporte": 5,
    "saude": 5,
    "lazer": 5,
  };
  // Mapa correto receita->dropdown
  const CAT_TO_DROPDOWN = {
    "salario": 2,
    "freelance": 5,
    "investimentos": 5,
    "moradia": 1,
    "alimentacao": 5,
    "transporte": 5,
    "saude": 5,
    "lazer": 5,
    "servicos": 4,
    "outros": 5,
    "cartao_de_credito": 3,
  };

  function getMondayToken() {
    return localStorage.getItem("fluxo_monday_token") || "";
  }

  async function mondayRequest(query) {
    const token = getMondayToken();
    if (!token) throw new Error("Token Monday não configurado.");
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token,
        "API-Version": "2024-01",
      },
      body: JSON.stringify({ query }),
    });
    const data = await r.json();
    if (data.errors) throw new Error(data.errors[0]?.message || "Erro Monday API");
    return data;
  }

  async function syncFromMonday() {
    const statusEl = document.getElementById("mondaySyncStatus");
    if (statusEl) statusEl.textContent = "Sincronizando com Monday…";
    try {
      const q = `query {
        boards(ids: [${MONDAY_BOARD_ID}]) {
          items_page(limit: 500) {
            items {
              id name
              column_values {
                id value text type
              }
            }
          }
        }
      }`;
      const data = await mondayRequest(q);
      const items = data.data.boards[0].items_page.items;
      const transactions = items.map((item) => {
        const col = (id) => item.column_values.find((c) => c.id === id);
        const dateText  = col(MONDAY_COLS.date)?.text || monthFromDate() + "-01";
        const month     = dateText.substring(0, 7);
        const amount    = Math.abs(parseFloat(col(MONDAY_COLS.value)?.text || "0"));
        const kindText  = col(MONDAY_COLS.kind)?.text || "Despesa";
        const statusTxt = col(MONDAY_COLS.status)?.text || "Previsto";
        let catId = "outros";
        try {
          const catRaw = col(MONDAY_COLS.category)?.value;
          if (catRaw) {
            const parsed = JSON.parse(catRaw);
            const dropId = String(parsed.ids?.[0] || "");
            catId = MONDAY_DROPDOWN_MAP[dropId] || "outros";
          }
        } catch {}
        const recurrenceTxt = col(MONDAY_COLS.recurrence)?.text || "";
        const recurrence = recurrenceTxt === "Mensal" ? "monthly" : "none";
        return {
          id: "monday_" + item.id,
          mondayId: item.id,
          description: item.name,
          amount,
          kind: kindText === "Receita" ? "income" : "expense",
          categoryId: catId,
          month,
          status: statusTxt === "Realizado" ? "realized" : "planned",
          recurrence,
          createdAt: new Date().toISOString(),
        };
      });
      // Monday é fonte de verdade — substitui tudo
      state.transactions = transactions;
      saveState();
      fullRender();
      if (statusEl) statusEl.textContent = "Sincronizado! " + transactions.length + " lançamentos carregados.";
    } catch (e) {
      if (statusEl) statusEl.textContent = "Erro: " + e.message;
    }
  }


  async function exportAllToMonday() {
    const statusEl = document.getElementById("mondaySyncStatus");
    const token = getMondayToken();
    if (!token) {
      if (statusEl) statusEl.textContent = "Salve o token primeiro.";
      return;
    }
    const toExport = state.transactions.filter(t => !t.mondayId);
    if (!toExport.length) {
      if (statusEl) statusEl.textContent = "Todos os lançamentos já estão no Monday.";
      return;
    }
    if (statusEl) statusEl.textContent = "Exportando " + toExport.length + " lançamentos…";
    let ok = 0;
    let fail = 0;
    for (const t of toExport) {
      try {
        await pushTransactionToMonday(t);
        ok++;
        if (statusEl) statusEl.textContent = "Exportando… " + ok + "/" + toExport.length;
      } catch (e) {
        fail++;
      }
    }
    saveState();
    if (statusEl) statusEl.textContent = "Exportado! " + ok + " enviados" + (fail ? ", " + fail + " erros" : "") + ".";
  }
  async function pushTransactionToMonday(t) {
    const token = getMondayToken();
    if (!token) return;
    const groupId = t.status === "realized" ? "group_mm24q7bz" : "topics";
    const catDropdownId = CAT_TO_DROPDOWN[t.categoryId] || 5;
    const colValues = JSON.stringify({
      [MONDAY_COLS.date]:       { date: t.month + "-01" },
      [MONDAY_COLS.value]:      t.amount,
      [MONDAY_COLS.notes]:      t.description,
      [MONDAY_COLS.kind]:       { index: t.kind === "income" ? 1 : 2 },
      [MONDAY_COLS.status]:     { index: t.status === "realized" ? 2 : 1 },
      [MONDAY_COLS.category]:   { ids: [catDropdownId] },
      [MONDAY_COLS.recurrence]: { index: t.recurrence === "monthly" ? 1 : 2 },
    });
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token,
        "API-Version": "2024-01",
      },
      body: JSON.stringify({
        query: `mutation($board: ID!, $group: String!, $name: String!, $cols: JSON!) {
          create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols) { id }
        }`,
        variables: {
          board: MONDAY_BOARD_ID,
          group: groupId,
          name: t.description,
          cols: colValues,
        }
      }),
    });
    const data = await r.json();
    if (data.errors) throw new Error(data.errors[0]?.message || "Erro Monday");
    const newId = data.data.create_item.id;
    t.mondayId = newId;
    t.id = "monday_" + newId;
    saveState();
  }

  async function deleteFromMonday(mondayId) {
    const token = getMondayToken();
    if (!token || !mondayId) return;
    await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
      body: JSON.stringify({
        query: `mutation($id: ID!) { delete_item(item_id: $id) { id } }`,
        variables: { id: mondayId }
      }),
    });
  }

  async function updateStatusOnMonday(mondayId, status) {
    const token = getMondayToken();
    if (!token || !mondayId) return;
    const colValues = JSON.stringify({
      [MONDAY_COLS.status]: { index: status === "realized" ? 2 : 1 },
    });
    await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
      body: JSON.stringify({
        query: `mutation($id: ID!, $cols: JSON!) { change_multiple_column_values(item_id: $id, board_id: ${MONDAY_BOARD_ID}, column_values: $cols) { id } }`,
        variables: { id: mondayId, cols: colValues }
      }),
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  function openInsightsModal() {
    const keyEl  = document.getElementById("insightsApiKey");
    const tokEl  = document.getElementById("mondayTokenInput");
    const st     = document.getElementById("insightsStatus");
    const out    = document.getElementById("insightsOutput");
    if (keyEl) keyEl.value = localStorage.getItem("fluxo_anthropic_key") || "";
    if (tokEl) tokEl.value = localStorage.getItem("fluxo_monday_token") || "";
    if (st) st.textContent = "";
    if (out) { out.textContent = ""; out.hidden = true; }
    document.getElementById("modalInsights")?.classList.add("open");
  }

  async function generateInsights() {
    const keyEl   = document.getElementById("insightsApiKey");
    const apiKey  = keyEl?.value.trim() || "";
    const statusEl = document.getElementById("insightsStatus");
    const out     = document.getElementById("insightsOutput");
    const btn     = document.getElementById("btnGenerateInsights");

    if (!apiKey) {
      if (statusEl) statusEl.textContent = "Informe sua chave da API Anthropic (sk-ant-…).";
      return;
    }
    localStorage.setItem("fluxo_anthropic_key", apiKey);
    if (statusEl) statusEl.textContent = "Gerando insights… aguarde.";
    if (out) { out.hidden = true; out.textContent = ""; }
    if (btn) btn.disabled = true;

    try {
      const summary = buildFinancialSummaryForAi();
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          system: "Você é um planejador financeiro pessoal objetivo. Responda em português do Brasil. Use markdown (títulos, listas) quando ajudar a leitura. Não invente números. Inclua: (1) visão geral do caixa, (2) riscos ou alertas, (3) até 7 sugestões práticas para o próximo mês.",
          messages: [{ role: "user", content: summary }],
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (statusEl) statusEl.textContent = data.error?.message || "Erro HTTP " + r.status;
        return;
      }
      const text = data.content?.[0]?.text || "";
      if (text && out) {
        out.textContent = text;
        out.hidden = false;
        if (statusEl) statusEl.textContent = "Pronto.";
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = "Erro: " + (e?.message || "verifique sua chave.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function slugFromLabel(label) {
    let s = label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    return s || "categoria";
  }

  function uniqueCategoryId(label, usedIds) {
    let base = slugFromLabel(label);
    let id = base;
    let n = 0;
    while (usedIds.has(id)) {
      id = base + "_" + ++n;
    }
    return id;
  }

  function cacheDom() {
    el = {
      monthFilter: document.getElementById("monthFilter"),
      kpiIncomeR: document.getElementById("kpiIncomeR"),
      kpiExpenseR: document.getElementById("kpiExpenseR"),
      kpiIncomeP: document.getElementById("kpiIncomeP"),
      kpiExpenseP: document.getElementById("kpiExpenseP"),
      kpiNetMonth: document.getElementById("kpiNetMonth"),
      kpiLiquidity: document.getElementById("kpiLiquidity"),
      form: document.getElementById("formLancamento"),
      desc: document.getElementById("desc"),
      amount: document.getElementById("amount"),
      kind: document.getElementById("kind"),
      category: document.getElementById("category"),
      month: document.getElementById("month"),
      status: document.getElementById("status"),
      recurrence: document.getElementById("recurrence"),
      openingInput: document.getElementById("openingBalance"),
      tbody: document.querySelector("#tableTransactions tbody"),
      btnExport: document.getElementById("btnExport"),
      btnImport: document.getElementById("btnImport"),
      fileImport: document.getElementById("fileImport"),
      modalOpening: document.getElementById("modalOpening"),
      btnSaveOpening: document.getElementById("btnSaveOpening"),
      chartFlow: document.getElementById("chartFlow"),
      chartProjection: document.getElementById("chartProjection"),
      chartCategories: document.getElementById("chartCategories"),
      modalCategories: document.getElementById("modalCategories"),
      modalCategoriesBody: document.getElementById("modalCategoriesBody"),
      modalEditTx: document.getElementById("modalEditTx"),
    };
  }

  function onClick(id, handler) {
    const n = document.getElementById(id);
    if (n) n.addEventListener("click", handler);
    else console.warn("[Fluxo] Elemento não encontrado: #" + id);
  }

  let chartFlow;
  let chartProjection;
  let chartCategories;

  let _selectedMonths = new Set([monthFromDate()]);

  function getSelectedMonths() {
    return [..._selectedMonths];
  }

  function populateMonthSelects() {
    const months = sortedUniqueMonthsFromData();
    const cur = monthFromDate();
    const set = new Set([cur, ...months]);
    const sorted = [...set].sort(compareMonth);
    const pills = document.getElementById("monthPills");
    if (!pills) return;

    // Botão "Todos"
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = "Todos";
    allBtn.className = "btn btn-sm" + (_selectedMonths.size === 0 ? " btn-primary" : " btn-ghost");
    allBtn.onclick = () => {
      _selectedMonths.clear();
      populateMonthSelects();
      renderKpis(); renderTable(); renderCharts();
    };
    pills.innerHTML = "";
    pills.appendChild(allBtn);

    sorted.forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = formatMonthLabel(m);
      btn.className = "btn btn-sm" + (_selectedMonths.has(m) ? " btn-primary" : " btn-ghost");
      btn.onclick = (e) => {
        if (e.shiftKey) {
          if (_selectedMonths.has(m)) _selectedMonths.delete(m);
          else _selectedMonths.add(m);
        } else {
          if (_selectedMonths.has(m) && _selectedMonths.size === 1) {
            _selectedMonths.clear();
          } else {
            _selectedMonths.clear();
            _selectedMonths.add(m);
          }
        }
        populateMonthSelects();
        renderKpis(); renderTable(); renderCharts();
      };
      pills.appendChild(btn);
    });

    el.month.value = cur;
  }

  function formatMonthLabel(ym) {
    const [, mo] = ym.split("-");
    const names = [
      "Jan",
      "Fev",
      "Mar",
      "Abr",
      "Mai",
      "Jun",
      "Jul",
      "Ago",
      "Set",
      "Out",
      "Nov",
      "Dez",
    ];
    const y = ym.split("-")[0];
    return `${names[parseInt(mo, 10) - 1]} ${y}`;
  }

  function refreshCategoryOptions() {
    const k = el.kind.value;
    const list = categoriesForKind(k);
    el.category.innerHTML = list.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
  }

  function getSelectedMonths() {
    if (!el.monthFilter) return [];
    // pills-based
    return selected;
  }

  function renderKpis() {
    if (el.openingInput) el.openingInput.value = String(state.openingBalance);
    const selected = getSelectedMonths();
    const months = selected.length ? selected : sortedUniqueMonthsFromData();

    let incomeR = 0, expenseR = 0, incomeP = 0, expenseP = 0;
    months.forEach((m) => {
      const f = flowsForMonth(m);
      incomeR += f.incomeR; expenseR += f.expenseR;
      incomeP += f.incomeP; expenseP += f.expenseP;
    });

    const netTotal = incomeR + incomeP - expenseR - expenseP;
    const netRealized = incomeR - expenseR;

    el.kpiIncomeR.textContent = formatBRL(incomeR);
    el.kpiExpenseR.textContent = formatBRL(expenseR);
    el.kpiIncomeP.textContent = formatBRL(incomeP);
    el.kpiExpenseP.textContent = formatBRL(expenseP);
    el.kpiNetMonth.textContent = formatBRL(netTotal);
    el.kpiNetMonth.className = "kpi-value " + (netTotal >= 0 ? "income" : "expense");

    const kpiDiff = document.getElementById("kpiRealized");
    if (kpiDiff) {
      kpiDiff.textContent = formatBRL(netRealized);
      kpiDiff.className = "kpi-value " + (netRealized >= 0 ? "income" : "expense");
    }

    if (months.length) {
      const lastMonth = months[months.length - 1];
      const endBal = balanceBeforeMonth(addMonths(lastMonth, 1));
      el.kpiLiquidity.textContent = formatBRL(endBal);
      el.kpiLiquidity.className = "kpi-value " + (endBal >= 0 ? "income" : "expense");
    } else {
      el.kpiLiquidity.textContent = formatBRL(state.openingBalance);
      el.kpiLiquidity.className = "kpi-value";
    }
  }

  function renderTable() {
    const selected = getSelectedMonths();
    let rows = [...state.transactions].sort((a, b) => {
      const mc = compareMonth(a.month, b.month);
      if (mc !== 0) return mc;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
    if (selected.length) rows = rows.filter((t) => selected.includes(t.month));

    if (!rows.length) {
      el.tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Nenhum lançamento neste filtro.</td></tr>`;
      return;
    }

    const planned  = rows.filter(t => t.status === "planned");
    const realized = rows.filter(t => t.status === "realized");

    const renderRow = (t) => {
      const signed = t.kind === "income" ? t.amount : -t.amount;
      const moneyClass = t.kind === "income" ? "money-in" : "money-out";
      const rec = t.recurrence === "monthly"
        ? '<span class="badge badge-planned">Mensal</span>' : "—";
      return `<tr data-id="${t.id}">
        <td>${formatMonthLabel(t.month)}</td>
        <td>${escapeHtml(t.description)}</td>
        <td><span class="badge ${t.kind === "income" ? "badge-income" : "badge-expense"}">${t.kind === "income" ? "Receita" : "Despesa"}</span></td>
        <td>${escapeHtml(categoryLabel(t.categoryId))}</td>
        <td class="${moneyClass}">${formatBRL(signed)}</td>
        <td>${rec}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-sm btn-primary js-edit">Editar</button>
          ${t.status === "planned"
            ? `<button type="button" class="btn btn-sm btn-ghost js-realize">✓ Realizar</button>`
            : `<button type="button" class="btn btn-sm btn-ghost js-unrealize">↩ Previsto</button>`}
          <button type="button" class="btn btn-sm btn-danger js-delete">Excluir</button>
        </td>
      </tr>`;
    };

    const totalPlanned  = planned.reduce((s, t) => s + (t.kind === "income" ? t.amount : -t.amount), 0);
    const totalRealized = realized.reduce((s, t) => s + (t.kind === "income" ? t.amount : -t.amount), 0);

    el.tbody.innerHTML = `
      <tr class="group-header">
        <td colspan="5" style="background:var(--planned-soft);color:var(--planned);font-weight:700;padding:.5rem .75rem">
          Previstos (${planned.length})
        </td>
        <td colspan="3" style="background:var(--planned-soft);color:var(--planned);font-weight:700;text-align:right;padding:.5rem .75rem">
          ${formatBRL(totalPlanned)}
        </td>
      </tr>
      ${planned.length ? planned.map(renderRow).join("") : `<tr><td colspan="8" style="padding:.5rem .75rem;color:var(--text-muted)">Nenhum previsto</td></tr>`}
      <tr class="group-header">
        <td colspan="5" style="background:var(--accent-soft);color:var(--accent);font-weight:700;padding:.5rem .75rem">
          Realizados (${realized.length})
        </td>
        <td colspan="3" style="background:var(--accent-soft);color:var(--accent);font-weight:700;text-align:right;padding:.5rem .75rem">
          ${formatBRL(totalRealized)}
        </td>
      </tr>
      ${realized.length ? realized.map(renderRow).join("") : `<tr><td colspan="8" style="padding:.5rem .75rem;color:var(--text-muted)">Nenhum realizado</td></tr>`}
    `;

    el.tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
      const id = tr.getAttribute("data-id");
      tr.querySelector(".js-edit")?.addEventListener("click", () => openEditTxModal(id));
      tr.querySelector(".js-delete")?.addEventListener("click", () => {
        if (confirm("Excluir este lançamento?")) {
          const t = state.transactions.find((x) => x.id === id);
          const mondayId = t?.mondayId;
          state.transactions = state.transactions.filter((x) => x.id !== id);
          saveState();
          fullRender();
          if (mondayId) deleteFromMonday(mondayId);
        }
      });
      tr.querySelector(".js-realize")?.addEventListener("click", () => {
        const t = state.transactions.find((x) => x.id === id);
        if (t) {
          t.status = "realized";
          saveState();
          fullRender();
          if (t.mondayId) updateStatusOnMonday(t.mondayId, "realized");
        }
      });
      tr.querySelector(".js-unrealize")?.addEventListener("click", () => {
        const t = state.transactions.find((x) => x.id === id);
        if (t) {
          t.status = "planned";
          saveState();
          fullRender();
          if (t.mondayId) updateStatusOnMonday(t.mondayId, "planned");
        }
      });
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function kindSelectHtml(selected) {
    const opts = [
      ["income", "Só receitas"],
      ["expense", "Só despesas"],
      ["both", "Receitas e despesas"],
    ];
    const k = ["income", "expense", "both"].includes(selected) ? selected : "both";
    return opts.map(([v, lab]) => `<option value="${v}"${v === k ? " selected" : ""}>${lab}</option>`).join("");
  }

  function renderCategoriesModalRows() {
    const tbody = el.modalCategoriesBody;
    if (!tbody) return;
    tbody.innerHTML = state.categories
      .map((c) => {
        const kid = c.kind === "income" || c.kind === "expense" || c.kind === "both" ? c.kind : "both";
        return `<tr data-cat-id="${escapeHtml(c.id)}">
        <td><input type="text" class="cat-label" value="${escapeHtml(c.label)}" /></td>
        <td><select class="cat-kind">${kindSelectHtml(kid)}</select></td>
        <td><button type="button" class="btn btn-sm btn-danger cat-remove">Remover</button></td>
      </tr>`;
      })
      .join("");
    tbody.querySelectorAll(".cat-remove").forEach((btn) => {
      btn.addEventListener("click", () => btn.closest("tr")?.remove());
    });
  }

  function appendEmptyCategoryRow() {
    if (!el.modalCategoriesBody) return;
    const tr = document.createElement("tr");
    tr.dataset.catId = "";
    tr.innerHTML = `<td><input type="text" class="cat-label" value="" placeholder="Nome da categoria" /></td>
      <td><select class="cat-kind">${kindSelectHtml("expense")}</select></td>
      <td><button type="button" class="btn btn-sm btn-danger cat-remove">Remover</button></td>`;
    tr.querySelector(".cat-remove").addEventListener("click", () => tr.remove());
    el.modalCategoriesBody.appendChild(tr);
  }

  function openCategoriesModal() {
    if (!el.modalCategories || !el.modalCategoriesBody) {
      alert("Faltam os modais no HTML. Envie o index.html completo junto com o app.js para o GitHub.");
      return;
    }
    renderCategoriesModalRows();
    el.modalCategories.classList.add("open");
  }

  function saveCategoriesFromModal() {
    if (!el.modalCategoriesBody) return;
    const rows = [...el.modalCategoriesBody.querySelectorAll("tr")];
    const next = [];
    const usedIds = new Set();

    rows.forEach((tr) => {
      const existingId = (tr.dataset.catId || "").trim();
      const label = tr.querySelector(".cat-label")?.value.trim() || "";
      const kindSel = tr.querySelector(".cat-kind");
      const kind = kindSel && ["income", "expense", "both"].includes(kindSel.value) ? kindSel.value : "both";
      if (!label) return;

      let id = existingId;
      if (!id) {
        id = uniqueCategoryId(label, usedIds);
      }
      usedIds.add(id);
      next.push({ id, label, kind });
    });

    const newIdSet = new Set(next.map((c) => c.id));
    const blocked = [];
    state.categories.forEach((old) => {
      if (!newIdSet.has(old.id)) {
        const inUse = state.transactions.some((t) => t.categoryId === old.id);
        if (inUse) blocked.push(old.label);
      }
    });

    if (blocked.length) {
      alert(
        "Você removeu categorias que ainda têm lançamentos:\n· " +
          blocked.join("\n· ") +
          "\n\nAltere a categoria desses lançamentos (Editar) ou recoloque a linha na tabela antes de salvar."
      );
      return;
    }

    state.categories = next;
    saveState();
    el.modalCategories.classList.remove("open");
    fullRender();
  }

  function refreshEditCategorySelect() {
    const kindEl = document.getElementById("editKind");
    const sel = document.getElementById("editCategory");
    const idEl = document.getElementById("editTxId");
    if (!kindEl || !sel || !idEl) return;
    const kind = kindEl.value;
    const list = categoriesForKind(kind);
    const t = state.transactions.find((x) => x.id === idEl.value);
    const current = t?.categoryId || list[0]?.id;
    sel.innerHTML = list.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
    if (list.some((c) => c.id === current)) sel.value = current;
    else if (list.length) sel.value = list[0].id;
  }

  function openEditTxModal(id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    document.getElementById("editTxId").value = t.id;
    document.getElementById("editDesc").value = t.description;
    document.getElementById("editAmount").value = String(t.amount);
    document.getElementById("editKind").value = t.kind;
    document.getElementById("editMonth").value = t.month;
    document.getElementById("editStatus").value = t.status;
    document.getElementById("editRecurrence").value = t.recurrence || "none";
    refreshEditCategorySelect();
    const sel = document.getElementById("editCategory");
    if (state.categories.some((c) => c.id === t.categoryId)) sel.value = t.categoryId;
    el.modalEditTx.classList.add("open");
  }

  function saveEditTx() {
    const id = document.getElementById("editTxId").value;
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;

    const description = document.getElementById("editDesc").value.trim();
    const amount = parseFloat(String(document.getElementById("editAmount").value).replace(",", "."), 10);
    if (!description || !Number.isFinite(amount) || amount <= 0) {
      alert("Preencha descrição e um valor válido.");
      return;
    }

    t.description = description;
    t.amount = amount;
    t.kind = document.getElementById("editKind").value;
    t.categoryId = document.getElementById("editCategory").value;
    t.month = document.getElementById("editMonth").value;
    t.status = document.getElementById("editStatus").value;
    t.recurrence = document.getElementById("editRecurrence").value;

    saveState();
    el.modalEditTx.classList.remove("open");
    fullRender();
    // Sync ao Monday
    if (t.mondayId) {
      const catDropdownId = CAT_TO_DROPDOWN[t.categoryId] || 5;
      const colValues = JSON.stringify({
        [MONDAY_COLS.date]:       { date: t.month + "-01" },
        [MONDAY_COLS.value]:      t.amount,
        [MONDAY_COLS.notes]:      t.description,
        [MONDAY_COLS.kind]:       { index: t.kind === "income" ? 1 : 2 },
        [MONDAY_COLS.status]:     { index: t.status === "realized" ? 2 : 1 },
        [MONDAY_COLS.category]:   { ids: [catDropdownId] },
        [MONDAY_COLS.recurrence]: { index: t.recurrence === "monthly" ? 1 : 2 },
      });
      fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": getMondayToken(), "API-Version": "2024-01" },
        body: JSON.stringify({
          query: `mutation($id: ID!, $cols: JSON!) { change_multiple_column_values(item_id: $id, board_id: ${MONDAY_BOARD_ID}, column_values: $cols) { id } }`,
          variables: { id: t.mondayId, cols: colValues }
        }),
      });
    } else {
      pushTransactionToMonday(t);
    }
  }

  function renderCharts() {
    if (typeof Chart === "undefined") return;
    const selected = getSelectedMonths();
    const ym = selected.length === 1 ? selected[0] : null;
    const palette = {
      text: "#8b9cb3",
      grid: "rgba(45,58,79,0.45)",
    };

    let flowMonths;
    if (ym) {
      flowMonths = [ym];
    } else {
      flowMonths = chartMonthRange(5, 1);
      if (!flowMonths.length) flowMonths = [monthFromDate()];
    }

    const flowLabels = flowMonths.map(formatMonthLabel);
    const flowRealized = flowMonths.map((m) => flowsForMonth(m).netRealized);
    const flowPlanned = flowMonths.map((m) => flowsForMonth(m).netPlanned);

    const ctxF = el.chartFlow.getContext("2d");
    if (chartFlow) chartFlow.destroy();
    chartFlow = new Chart(ctxF, {
      type: "bar",
      data: {
        labels: flowLabels,
        datasets: [
          {
            label: "Realizado (líquido)",
            data: flowRealized,
            backgroundColor: "rgba(59, 130, 246, 0.7)",
            borderRadius: 6,
          },
          {
            label: "Previsto (líquido)",
            data: flowPlanned,
            backgroundColor: "rgba(167, 139, 250, 0.6)",
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: palette.text } },
          tooltip: {
            callbacks: {
              label(ctx) {
                return `${ctx.dataset.label}: ${formatBRL(ctx.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: palette.text }, grid: { color: palette.grid } },
          y: {
            ticks: {
              color: palette.text,
              callback(v) {
                return formatBRL(v);
              },
            },
            grid: { color: palette.grid },
          },
        },
      },
    });

    const proj = projectionSeries(6, 14);
    const ctxP = el.chartProjection.getContext("2d");
    if (chartProjection) chartProjection.destroy();
    chartProjection = new Chart(ctxP, {
      type: "line",
      data: {
        labels: proj.labels.map(formatMonthLabel),
        datasets: [
          {
            label: "Saldo acumulado",
            data: proj.balances,
            borderColor: "#34d399",
            backgroundColor: "rgba(52, 211, 153, 0.12)",
            fill: true,
            tension: 0.35,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: palette.text } },
          tooltip: {
            callbacks: {
              label(ctx) {
                return formatBRL(ctx.parsed.y);
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: palette.text, maxRotation: 45 }, grid: { color: palette.grid } },
          y: {
            ticks: {
              color: palette.text,
              callback(v) {
                return formatBRL(v);
              },
            },
            grid: { color: palette.grid },
          },
        },
      },
    });

    const catMap = categoryExpenseTotals(ym || null);
    const catLabels = Object.keys(catMap);
    const catData = catLabels.map((k) => catMap[k]);

    const ctxC = el.chartCategories.getContext("2d");
    if (chartCategories) chartCategories.destroy();
    chartCategories = new Chart(ctxC, {
      type: "doughnut",
      data: {
        labels: catLabels.length ? catLabels : ["Sem despesas"],
        datasets: [
          {
            data: catData.length ? catData : [1],
            backgroundColor: [
              "#f87171",
              "#fb923c",
              "#fbbf24",
              "#a78bfa",
              "#60a5fa",
              "#34d399",
              "#2dd4bf",
              "#94a3b8",
            ],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: palette.text, boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label(ctx) {
                if (!catData.length) return "";
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                return `${ctx.label}: ${formatBRL(ctx.parsed)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  function fullRender() {
    populateMonthSelects();
    refreshCategoryOptions();
    renderKpis();
    renderTable();
    if (typeof Chart !== "undefined") renderCharts();
  }

  function startApp() {
    cacheDom();
    if (!el.form || !el.tbody) {
      console.error("[Fluxo] HTML incompleto.");
      return;
    }

    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const description = el.desc.value.trim();
      const amount = parseMoneyInput(el.amount);
      if (!description || !Number.isFinite(amount) || amount <= 0) {
        alert("Preencha descrição e um valor válido.");
        return;
      }
      const t = {
        id: uid(),
        description,
        amount,
        kind: el.kind.value,
        categoryId: el.category.value,
        month: el.month.value,
        status: el.status.value,
        recurrence: el.recurrence.value,
        createdAt: new Date().toISOString(),
      };
      state.transactions.push(t);
      el.desc.value = "";
      el.amount.value = "";
      saveState();
      _selectedMonths.clear();
      _selectedMonths.add(t.month);
      fullRender();
      pushTransactionToMonday(t);
    });

    el.kind.addEventListener("change", refreshCategoryOptions);

    onClick("btnOpening", () => {
      el.modalOpening?.classList.add("open");
      const m = document.getElementById("openingBalanceModal");
      if (m) m.value = String(state.openingBalance);
    });

    onClick("btnCancelOpening", () => el.modalOpening?.classList.remove("open"));

    el.btnSaveOpening?.addEventListener("click", () => {
      const m = document.getElementById("openingBalanceModal");
      const v = parseFloat(String(m?.value ?? "").replace(",", "."), 10);
      state.openingBalance = Number.isFinite(v) ? v : 0;
      saveState();
      el.modalOpening?.classList.remove("open");
      fullRender();
    });

    el.modalOpening?.addEventListener("click", (e) => {
      if (e.target === el.modalOpening) el.modalOpening.classList.remove("open");
    });

    onClick("btnCategories", () => openCategoriesModal());
    onClick("btnAddCategoryRow", () => appendEmptyCategoryRow());
    onClick("btnCancelCategories", () => el.modalCategories?.classList.remove("open"));
    onClick("btnSaveCategories", () => saveCategoriesFromModal());
    el.modalCategories?.addEventListener("click", (e) => {
      if (e.target === el.modalCategories) el.modalCategories.classList.remove("open");
    });

    onClick("btnInsights", () => openInsightsModal());
    onClick("btnCloseInsights", () => document.getElementById("modalInsights")?.classList.remove("open"));
    document.getElementById("modalInsights")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove("open");
    });
    onClick("btnSaveMondayToken", () => {
      const tok = document.getElementById("mondayTokenInput")?.value.trim() || "";
      localStorage.setItem("fluxo_monday_token", tok);
      const st = document.getElementById("mondaySyncStatus");
      if (st) st.textContent = "Token salvo!";
    });
    onClick("btnSyncMonday", () => syncFromMonday());
    onClick("btnExportAllMonday", () => exportAllToMonday());
    onClick("btnSaveInsightsConfig", () => {
      const k = document.getElementById("insightsApiKey")?.value.trim() || "";
      localStorage.setItem("fluxo_anthropic_key", k);
      const st = document.getElementById("insightsStatus");
      if (st) st.textContent = "Chave salva.";
    });
    onClick("btnGenerateInsights", () => generateInsights());

    document.getElementById("editKind")?.addEventListener("change", () => refreshEditCategorySelect());
    onClick("btnCancelEditTx", () => el.modalEditTx?.classList.remove("open"));
    onClick("btnSaveEditTx", () => saveEditTx());
    el.modalEditTx?.addEventListener("click", (e) => {
      if (e.target === el.modalEditTx) el.modalEditTx.classList.remove("open");
    });

    el.openingInput?.addEventListener("change", () => {
      const v = parseFloat(String(el.openingInput.value).replace(",", "."), 10);
      state.openingBalance = Number.isFinite(v) ? v : 0;
      saveState();
      fullRender();
    });

    el.btnExport?.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `fluxo-backup-${monthFromDate()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    el.btnImport?.addEventListener("click", () => el.fileImport?.click());

    el.fileImport?.addEventListener("change", () => {
      const file = el.fileImport.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!Array.isArray(parsed.transactions)) throw new Error("invalid");
          state = {
            openingBalance: typeof parsed.openingBalance === "number" ? parsed.openingBalance : 0,
            categories:
              Array.isArray(parsed.categories) && parsed.categories.length
                ? parsed.categories
                : DEFAULT_CATEGORIES.slice(),
            transactions: parsed.transactions,
          };
          saveState();
          fullRender();
        } catch {
          alert("Arquivo inválido.");
        }
        el.fileImport.value = "";
      };
      reader.readAsText(file);
    });

    populateMonthSelects();
    refreshCategoryOptions();
    fullRender();

    // Auto-sync do Monday ao abrir se tiver token
    if (getMondayToken()) {
      syncFromMonday();
      // Polling a cada 30s para manter em tempo real
      setInterval(() => {
        if (getMondayToken()) syncFromMonday();
      }, 30000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
})();
