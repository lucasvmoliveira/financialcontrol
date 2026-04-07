(function () {
  "use strict";

  const STORAGE_KEY = "fluxo_financeiro_v1";
  let state = loadState();
  let currentViewDate = new Date();

  // MAPEAMENTO DE COLUNAS MONDAY (Ajuste os IDs conforme sua board)
  const MONDAY_MAP = {
    valor: "numbers",      // ID da coluna de número
    data: "date",         // ID da coluna de data
    status: "status",     // ID da coluna de status (Pago/Pendente)
    categoria: "color"    // ID da coluna de categoria
  };

  function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : { transactions: [], openingBalance: 0 };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // --- SINCRONIZAÇÃO EM TEMPO REAL ---

  async function pushToMonday(tx) {
    const token = localStorage.getItem("monday_token");
    const boardId = localStorage.getItem("monday_board_id");
    if (!token || !boardId) return;

    const query = `mutation {
      create_item (board_id: ${boardId}, item_name: "${tx.description}", column_values: ${JSON.stringify(JSON.stringify({
        [MONDAY_MAP.valor]: tx.amount.toString(),
        [MONDAY_MAP.data]: { date: tx.date },
        [MONDAY_MAP.status]: { label: tx.paid ? "Pago" : "Pendente" }
      }))}) { id }
    }`;

    try {
      const response = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": token },
        body: JSON.stringify({ query })
      });
      const resData = await response.json();
      return resData.data?.create_item?.id;
    } catch (e) {
      console.error("Erro Monday Push:", e);
    }
  }

  // --- CONTROLE DE PERÍODO ---

  function updatePeriodDisplay() {
    const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    document.getElementById("displayMonth").textContent = months[currentViewDate.getMonth()];
    document.getElementById("displayYear").textContent = currentViewDate.getFullYear();
    
    const monthKey = `${currentViewDate.getFullYear()}-${String(currentViewDate.getMonth() + 1).padStart(2, '0')}`;
    render(monthKey);
  }

  function render(monthKey) {
    const tbody = document.getElementById("tableBody");
    tbody.innerHTML = "";
    
    const filtered = state.transactions.filter(t => t.date.startsWith(monthKey));
    
    filtered.forEach(tx => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${tx.paid ? '✅' : '⏳'}</td>
        <td>${tx.date}</td>
        <td>${tx.description}</td>
        <td>${tx.category}</td>
        <td class="${tx.amount >= 0 ? 'text-income' : 'text-expense'}">R$ ${tx.amount.toFixed(2)}</td>
        <td><button onclick="deleteTx('${tx.id}')">🗑️</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  // --- INICIALIZAÇÃO ---

  function startApp() {
    document.getElementById("btnPrevMonth").onclick = () => {
      currentViewDate.setMonth(currentViewDate.getMonth() - 1);
      updatePeriodDisplay();
    };
    document.getElementById("btnNextMonth").onclick = () => {
      currentViewDate.setMonth(currentViewDate.getMonth() + 1);
      updatePeriodDisplay();
    };
    document.getElementById("btnToday").onclick = () => {
      currentViewDate = new Date();
      updatePeriodDisplay();
    };

    updatePeriodDisplay();

    // Sincronização Automática (Pooling)
    setInterval(() => {
      if (localStorage.getItem("monday_token")) {
        console.log("Checando atualizações na Monday...");
        // Aqui entraria a função syncFromMonday() do seu original
      }
    }, 30000);
  }

  window.deleteTx = (id) => {
    state.transactions = state.transactions.filter(t => t.id !== id);
    saveState();
    updatePeriodDisplay();
  };

  document.addEventListener("DOMContentLoaded", startApp);
})();
