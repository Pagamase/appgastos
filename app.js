"use strict";

const STORAGE_KEY = "fluge_travel_expenses_v1";
const FIXED_CLOUD_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbzjDcaLbBCrEcYF-2yh1x-ArrdCrRihi-aZJyjTQbHVIPt8QC6VPBCPiRMiQvtygUQ/exec";
const FIXED_CLOUD_TOKEN = "";
const REMOTE_TIMEOUT_MS = 12000;
const REMOTE_SAVE_DEBOUNCE_MS = 700;
const MAX_PHOTO_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_SIDE = 1400;
const PHOTO_JPEG_QUALITY = 0.78;

const CATEGORIES = [
  "Desayuno",
  "Comida",
  "Cena",
  "Taxi",
  "Alojamiento",
  "Otro",
];

const CATEGORY_ALIASES = {
  desayuno: "Desayuno",
  comida: "Comida",
  comidas: "Comida",
  cena: "Cena",
  taxi: "Taxi",
  transporte: "Taxi",
  alojamiento: "Alojamiento",
  otro: "Otro",
  otros: "Otro",
  cliente: "Otro",
  material: "Otro",
};

const PAYMENT_METHODS = [
  "Tarjeta empresa",
  "Tarjeta personal",
  "Efectivo",
  "Transferencia",
  "Otro",
];

const state = {
  trips: [],
  activeTripId: null,
};

const syncState = {
  endpoint: FIXED_CLOUD_ENDPOINT,
  token: FIXED_CLOUD_TOKEN,
  saveTimerId: null,
  saveInFlight: false,
  hasPendingSave: false,
};

const uiState = {
  editingExpenseId: null,
};

const refs = {};

document.addEventListener("DOMContentLoaded", () => {
  void init();
});

async function init() {
  cacheRefs();
  populateStaticSelects();
  refs.expenseDate.value = todayIso();
  bindEvents();
  await loadState();
  renderAll();
}

function cacheRefs() {
  refs.tripForm = document.getElementById("trip-form");
  refs.activeTrip = document.getElementById("active-trip");
  refs.deleteTrip = document.getElementById("delete-trip");
  refs.tripEmpty = document.getElementById("trip-empty");

  refs.expenseForm = document.getElementById("expense-form");
  refs.expenseFormTitle = document.getElementById("expense-form-title");
  refs.expenseFormSubtitle = document.getElementById("expense-form-subtitle");
  refs.expenseSubmitBtn = document.getElementById("expense-submit-btn");
  refs.expenseCancelEdit = document.getElementById("expense-cancel-edit");
  refs.expenseDate = document.getElementById("expense-date");
  refs.expenseCategory = document.getElementById("expense-category");
  refs.paymentMethod = document.getElementById("payment-method");
  refs.expensePhoto = document.getElementById("expense-photo");
  refs.expensePhotoStatus = document.getElementById("expense-photo-status");

  refs.totalSpent = document.getElementById("total-spent");
  refs.totalBudget = document.getElementById("total-budget");
  refs.totalRemaining = document.getElementById("total-remaining");
  refs.totalBillable = document.getElementById("total-billable");
  refs.budgetFill = document.getElementById("budget-fill");
  refs.budgetLabel = document.getElementById("budget-label");
  refs.categoryBreakdown = document.getElementById("category-breakdown");
  refs.exportCsv = document.getElementById("export-csv");

  refs.listTitle = document.getElementById("list-title");
  refs.searchExpense = document.getElementById("search-expense");
  refs.filterCategory = document.getElementById("filter-category");
  refs.filterDate = document.getElementById("filter-date");
  refs.expenseList = document.getElementById("expense-list");
  refs.expenseEmpty = document.getElementById("expense-empty");

  refs.syncNow = document.getElementById("sync-now");
  refs.syncStatus = document.getElementById("sync-status");
}

function bindEvents() {
  refs.tripForm.addEventListener("submit", onTripSubmit);
  refs.activeTrip.addEventListener("change", onActiveTripChange);
  refs.deleteTrip.addEventListener("click", onTripDelete);

  refs.expenseForm.addEventListener("submit", (event) => {
    void onExpenseSubmit(event);
  });
  refs.expenseCancelEdit.addEventListener("click", onCancelExpenseEdit);
  refs.expenseList.addEventListener("click", onExpenseListClick);

  refs.searchExpense.addEventListener("input", renderExpenses);
  refs.filterCategory.addEventListener("change", renderExpenses);
  refs.filterDate.addEventListener("change", renderExpenses);
  refs.exportCsv.addEventListener("click", onExportCsv);

  refs.syncNow.addEventListener("click", () => {
    void onSyncNow();
  });

  document.addEventListener("visibilitychange", () => {
    void onVisibilitySync();
  });
  window.addEventListener("online", onBrowserOnline);
}

function populateStaticSelects() {
  setOptions(refs.expenseCategory, CATEGORIES);
  setOptions(refs.paymentMethod, PAYMENT_METHODS);
  setOptions(refs.filterCategory, CATEGORIES, true);
}

function onTripSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  const name = safeTrim(formData.get("tripName"));
  const destination = safeTrim(formData.get("destination"));
  const startDate = safeTrim(formData.get("startDate"));
  const endDate = safeTrim(formData.get("endDate"));
  const budgetRaw = safeTrim(formData.get("budget"));

  if (!name) {
    window.alert("El nombre del viaje es obligatorio.");
    return;
  }

  if (startDate && endDate && startDate > endDate) {
    window.alert("La fecha de fin no puede ser anterior al inicio.");
    return;
  }

  let budget = 0;
  if (budgetRaw) {
    budget = parseAmount(budgetRaw);
    if (!Number.isFinite(budget) || budget < 0) {
      window.alert("El presupuesto debe ser un numero valido.");
      return;
    }
  }

  const trip = {
    id: createId(),
    name,
    destination,
    startDate,
    endDate,
    budget,
    createdAt: Date.now(),
    expenses: [],
  };

  state.trips.unshift(trip);
  state.activeTripId = trip.id;
  exitExpenseEditMode({ resetForm: true });
  saveState();

  event.currentTarget.reset();
  renderAll();
}

function onActiveTripChange(event) {
  state.activeTripId = event.target.value || null;
  exitExpenseEditMode({ resetForm: true });
  saveState();
  renderAll();
}

function onTripDelete() {
  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    return;
  }

  const confirmed = window.confirm(
    `Eliminar "${activeTrip.name}" y todos sus gastos? Esta accion no se puede deshacer.`,
  );
  if (!confirmed) {
    return;
  }

  state.trips = state.trips.filter((trip) => trip.id !== activeTrip.id);
  state.activeTripId = state.trips[0]?.id ?? null;
  exitExpenseEditMode({ resetForm: true });
  saveState();
  renderAll();
}

async function onExpenseSubmit(event) {
  event.preventDefault();

  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    window.alert("Primero crea o selecciona un viaje.");
    return;
  }

  const formData = new FormData(event.currentTarget);
  const editingExpense =
    uiState.editingExpenseId
      ? activeTrip.expenses.find((expense) => expense.id === uiState.editingExpenseId) || null
      : null;

  if (uiState.editingExpenseId && !editingExpense) {
    exitExpenseEditMode({ resetForm: false });
    window.alert("El gasto que estabas editando ya no existe.");
    renderAll();
    return;
  }

  const date = safeTrim(formData.get("expenseDate")) || todayIso();
  const category = normalizeCategory(formData.get("category"));
  const description = safeTrim(formData.get("description"));
  const amountRaw = safeTrim(formData.get("amount"));
  const paymentMethod = safeTrim(formData.get("paymentMethod"));
  const notes = safeTrim(formData.get("notes"));
  const billable = formData.get("billable") === "true";
  const photoFile = formData.get("photo");

  if (!description) {
    window.alert("La descripcion del gasto es obligatoria.");
    return;
  }

  const amount = parseAmount(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    window.alert("El importe debe ser mayor que cero.");
    return;
  }

  let photoDataUrl = "";
  let photoName = "";
  let hasNewPhoto = false;
  if (photoFile instanceof File && photoFile.size > 0) {
    if (!String(photoFile.type || "").startsWith("image/")) {
      window.alert("La foto debe ser un archivo de imagen.");
      return;
    }
    if (photoFile.size > MAX_PHOTO_FILE_BYTES) {
      window.alert("La foto es demasiado grande. Maximo 8MB.");
      return;
    }
    try {
      photoDataUrl = await readAndCompressImageFile(photoFile);
      photoName = safeTrim(photoFile.name);
      hasNewPhoto = true;
    } catch (error) {
      console.error("No se pudo procesar la foto:", error);
      window.alert("No se pudo procesar la foto seleccionada.");
      return;
    }
  }

  if (editingExpense) {
    editingExpense.date = date;
    editingExpense.category = category;
    editingExpense.description = description;
    editingExpense.amount = amount;
    editingExpense.paymentMethod = paymentMethod || editingExpense.paymentMethod || "Otro";
    editingExpense.billable = billable;
    editingExpense.notes = notes;

    if (hasNewPhoto) {
      // Para reemplazar foto, limpiamos la URL previa y forzamos nueva subida.
      editingExpense.photoDataUrl = photoDataUrl;
      editingExpense.photoName = photoName;
      editingExpense.photoUrl = "";
      editingExpense.photoFileId = "";
    }
  } else {
    const expense = {
      id: createId(),
      date,
      category,
      description,
      amount,
      paymentMethod,
      billable,
      notes,
      photoDataUrl,
      photoName,
      photoUrl: "",
      photoFileId: "",
      createdAt: Date.now(),
    };

    activeTrip.expenses.push(expense);
  }

  saveState();

  exitExpenseEditMode({ resetForm: true });
  renderAll();
}

function onExpenseListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  if (!action) {
    return;
  }

  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    return;
  }

  const expenseId = button.dataset.id;
  if (!expenseId) {
    return;
  }

  if (action === "edit-expense") {
    startExpenseEditById(expenseId);
    return;
  }

  if (action !== "delete-expense") {
    return;
  }

  const expense = activeTrip.expenses.find((item) => item.id === expenseId);
  if (!expense) {
    return;
  }

  const confirmed = window.confirm(
    `Eliminar el gasto "${expense.description}"? Esta accion no se puede deshacer.`,
  );
  if (!confirmed) {
    return;
  }

  activeTrip.expenses = activeTrip.expenses.filter((item) => item.id !== expenseId);
  if (uiState.editingExpenseId === expenseId) {
    exitExpenseEditMode({ resetForm: true });
  }

  saveState();
  renderAll();
}

function onCancelExpenseEdit() {
  exitExpenseEditMode({ resetForm: true });
  renderAll();
}

function startExpenseEditById(expenseId) {
  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    return;
  }

  const expense = activeTrip.expenses.find((item) => item.id === expenseId);
  if (!expense) {
    return;
  }

  uiState.editingExpenseId = expense.id;
  fillExpenseFormForEdit(expense);
  updateExpenseFormUi();

  refs.expenseForm.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function fillExpenseFormForEdit(expense) {
  if (!refs.expenseForm || !expense) {
    return;
  }

  refs.expenseForm.elements.expenseDate.value = expense.date || todayIso();
  refs.expenseForm.elements.category.value = normalizeCategory(expense.category);
  refs.expenseForm.elements.description.value = expense.description || "";
  refs.expenseForm.elements.amount.value = String(expense.amount || "");
  refs.expenseForm.elements.paymentMethod.value = expense.paymentMethod || "Otro";
  refs.expenseForm.elements.billable.checked = Boolean(expense.billable);
  refs.expenseForm.elements.notes.value = expense.notes || "";
  refs.expensePhoto.value = "";
}

function exitExpenseEditMode({ resetForm = false } = {}) {
  uiState.editingExpenseId = null;
  if (resetForm) {
    resetExpenseFormInputs_();
  }
  updateExpenseFormUi();
}

function resetExpenseFormInputs_() {
  if (!refs.expenseForm) {
    return;
  }

  refs.expenseForm.reset();
  refs.expenseDate.value = todayIso();
  refs.expensePhoto.value = "";
}

function updateExpenseFormUi() {
  const activeTrip = getActiveTrip();
  let editingExpense = null;

  if (activeTrip && uiState.editingExpenseId) {
    editingExpense =
      activeTrip.expenses.find((expense) => expense.id === uiState.editingExpenseId) || null;
  }

  if (!editingExpense && uiState.editingExpenseId) {
    uiState.editingExpenseId = null;
  }

  const isEditing = Boolean(editingExpense);
  refs.expenseFormTitle.textContent = isEditing ? "Editar gasto" : "Nuevo gasto";
  refs.expenseFormSubtitle.textContent = isEditing
    ? "Puedes corregir el gasto y adjuntar foto si faltaba."
    : "Se guarda en local y sincroniza automaticamente con tu Sheet.";
  refs.expenseSubmitBtn.textContent = isEditing ? "Guardar cambios" : "Guardar gasto";
  refs.expenseCancelEdit.classList.toggle("hidden", !isEditing);

  refs.expensePhotoStatus.classList.toggle("hidden", !isEditing);
  if (!isEditing) {
    refs.expensePhotoStatus.textContent = "";
    return;
  }

  const hasPhoto = Boolean(
    safeTrim(editingExpense.photoUrl) ||
      safeTrim(editingExpense.photoFileId) ||
      safeTrim(editingExpense.photoDataUrl),
  );
  refs.expensePhotoStatus.textContent = hasPhoto
    ? "Este gasto ya tiene foto. Si eliges otra, se reemplazara la actual."
    : "Este gasto no tiene foto. Puedes anadirla ahora.";
}

function onExportCsv() {
  const activeTrip = getActiveTrip();
  if (!activeTrip || activeTrip.expenses.length === 0) {
    window.alert("No hay gastos para exportar en el viaje activo.");
    return;
  }

  const headers = [
    "Fecha",
    "Categoria",
    "Descripcion",
    "Importe",
    "MedioPago",
    "Facturable",
    "Notas",
    "Foto",
  ];

  const rows = activeTrip.expenses
    .slice()
    .sort(sortExpensesDesc)
    .map((expense) => [
      expense.date,
      expense.category,
      expense.description,
      expense.amount.toFixed(2),
      expense.paymentMethod,
      expense.billable ? "si" : "no",
      expense.notes,
      expense.photoUrl || "",
    ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => csvEscape(cell)).join(","))
    .join("\n");

  const nameSafe = activeTrip.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const fileName = `gastos_${nameSafe || "viaje"}.csv`;
  downloadCsv(fileName, csv);
}

async function onSyncNow() {
  if (!hasCloudConfig()) {
    window.alert("No hay conexion configurada con Google Sheets.");
    return;
  }

  await pushStateToCloud({ updateStatus: true });
}

async function onVisibilitySync() {
  if (document.hidden || !hasCloudConfig()) {
    return;
  }

  await pullStateFromCloud({
    updateStatus: false,
    preserveLocalWhenRemoteEmpty: true,
  });
}

function onBrowserOnline() {
  queueRemoteSave(true);
}

function renderAll() {
  enforceActiveTrip();
  updateExpenseFormUi();
  renderTripControls();
  renderSummary();
  renderExpenses();
}

function renderTripControls() {
  if (state.trips.length === 0) {
    refs.activeTrip.innerHTML = '<option value="">Sin viajes</option>';
    refs.activeTrip.disabled = true;
    refs.deleteTrip.disabled = true;
    refs.tripEmpty.textContent = "No hay viajes creados.";
    refs.listTitle.textContent = "Selecciona un viaje para ver gastos.";
    return;
  }

  refs.activeTrip.disabled = false;
  refs.deleteTrip.disabled = false;

  refs.activeTrip.innerHTML = state.trips
    .map((trip) => {
      const detail = trip.destination ? ` - ${trip.destination}` : "";
      return `<option value="${trip.id}">${escapeHtml(trip.name)}${escapeHtml(detail)}</option>`;
    })
    .join("");

  refs.activeTrip.value = state.activeTripId;

  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    return;
  }

  const datePart =
    activeTrip.startDate || activeTrip.endDate
      ? ` (${activeTrip.startDate || "?"} a ${activeTrip.endDate || "?"})`
      : "";

  refs.tripEmpty.textContent = `${activeTrip.name}${activeTrip.destination ? ` - ${activeTrip.destination}` : ""}${datePart}`;
  refs.listTitle.textContent = `Viaje activo: ${activeTrip.name}`;
}

function renderSummary() {
  const activeTrip = getActiveTrip();

  if (!activeTrip) {
    refs.totalSpent.textContent = formatCurrency(0);
    refs.totalBudget.textContent = formatCurrency(0);
    refs.totalRemaining.textContent = formatCurrency(0);
    refs.totalBillable.textContent = formatCurrency(0);
    refs.totalRemaining.classList.remove("negative", "positive");
    refs.budgetFill.style.width = "0%";
    refs.budgetLabel.textContent = "0%";
    refs.categoryBreakdown.innerHTML = '<p class="empty-state">No hay datos para mostrar.</p>';
    return;
  }

  const totals = activeTrip.expenses.reduce(
    (acc, expense) => {
      acc.totalSpent += expense.amount;
      if (expense.billable) {
        acc.totalBillable += expense.amount;
      }
      const dayKey = safeTrim(expense.date) || todayIso();
      if (!acc.byDay[dayKey]) {
        acc.byDay[dayKey] = { total: 0, count: 0 };
      }
      acc.byDay[dayKey].total += expense.amount;
      acc.byDay[dayKey].count += 1;
      return acc;
    },
    { totalSpent: 0, totalBillable: 0, byDay: {} },
  );

  const budget = activeTrip.budget || 0;
  const remaining = budget - totals.totalSpent;

  refs.totalSpent.textContent = formatCurrency(totals.totalSpent);
  refs.totalBudget.textContent = formatCurrency(budget);
  refs.totalRemaining.textContent = formatCurrency(remaining);
  refs.totalBillable.textContent = formatCurrency(totals.totalBillable);
  refs.totalRemaining.classList.toggle("negative", remaining < 0);
  refs.totalRemaining.classList.toggle("positive", remaining >= 0);

  const usage = budget > 0 ? (totals.totalSpent / budget) * 100 : 0;
  const visualUsage = Math.max(0, Math.min(usage, 100));
  refs.budgetFill.style.width = `${visualUsage}%`;
  refs.budgetLabel.textContent = budget > 0 ? `${Math.round(usage)}%` : "Sin presupuesto";

  const dayEntries = Object.entries(totals.byDay).sort((a, b) => {
    const aRank = Date.parse(`${a[0]}T00:00:00`);
    const bRank = Date.parse(`${b[0]}T00:00:00`);
    if (Number.isFinite(aRank) && Number.isFinite(bRank)) {
      return bRank - aRank;
    }
    return b[0].localeCompare(a[0]);
  });

  if (dayEntries.length === 0) {
    refs.categoryBreakdown.innerHTML = '<p class="empty-state">Todavia no hay gastos cargados.</p>';
    return;
  }

  refs.categoryBreakdown.innerHTML = dayEntries
    .map(([dayKey, data]) => {
      const countLabel = data.count === 1 ? "1 gasto" : `${data.count} gastos`;
      return `
        <div class="category-row">
          <div class="category-head">
            <span>${escapeHtml(formatDate(dayKey))}</span>
            <strong>${formatCurrency(data.total)}</strong>
          </div>
          <p class="day-meta">${escapeHtml(countLabel)}</p>
        </div>
      `;
    })
    .join("");
}

function renderExpenses() {
  const activeTrip = getActiveTrip();
  if (!activeTrip) {
    refs.expenseList.innerHTML = "";
    refs.expenseEmpty.textContent = "Crea un viaje para empezar.";
    refs.expenseEmpty.classList.remove("hidden");
    return;
  }

  const search = refs.searchExpense.value.trim().toLowerCase();
  const categoryFilter = refs.filterCategory.value;
  const dateFilter = safeTrim(refs.filterDate.value);

  const filtered = activeTrip.expenses
    .slice()
    .sort(sortExpensesDesc)
    .filter((expense) => {
      if (categoryFilter !== "all" && expense.category !== categoryFilter) {
        return false;
      }
      if (dateFilter && safeTrim(expense.date) !== dateFilter) {
        return false;
      }

      if (!search) {
        return true;
      }

      const searchableText =
        `${expense.description} ${expense.notes} ${expense.category} ${expense.paymentMethod}`.toLowerCase();
      return searchableText.includes(search);
    });

  if (filtered.length === 0) {
    refs.expenseList.innerHTML = "";
    refs.expenseEmpty.textContent = "No hay gastos que coincidan con el filtro.";
    refs.expenseEmpty.classList.remove("hidden");
    return;
  }

  refs.expenseEmpty.classList.add("hidden");
  refs.expenseList.innerHTML = filtered.map(renderExpenseItem).join("");
}

function renderExpenseItem(expense) {
  const isEditing = uiState.editingExpenseId === expense.id;
  const meta = [
    formatDate(expense.date),
    expense.category,
    expense.paymentMethod,
    expense.billable ? "Facturable" : "No facturable",
  ].join(" | ");

  const notes = expense.notes ? `<p class="expense-notes">${escapeHtml(expense.notes)}</p>` : "";
  const photoAction = expense.photoUrl
    ? `<a class="btn secondary small" href="${escapeHtml(expense.photoUrl)}" target="_blank" rel="noopener noreferrer">Ver foto</a>`
    : "";

  return `
    <article class="expense-item${isEditing ? " expense-item-editing" : ""}">
      <div class="expense-main">
        <p class="expense-title">${escapeHtml(expense.description)}</p>
        <p class="expense-meta">${escapeHtml(meta)}</p>
        ${notes}
      </div>
      <div class="expense-side">
        <span class="expense-amount">${formatCurrency(expense.amount)}</span>
        ${photoAction}
        <button type="button" class="btn secondary small" data-action="edit-expense" data-id="${expense.id}">
          Editar
        </button>
        <button type="button" class="btn ghost small" data-action="delete-expense" data-id="${expense.id}">
          Eliminar
        </button>
      </div>
    </article>
  `;
}

function setSyncStatus(message, tone = "") {
  if (!refs.syncStatus) {
    return;
  }
  refs.syncStatus.textContent = message;
  refs.syncStatus.classList.remove("status-ok", "status-warn", "status-bad");
  if (tone === "ok") {
    refs.syncStatus.classList.add("status-ok");
  } else if (tone === "warn") {
    refs.syncStatus.classList.add("status-warn");
  } else if (tone === "bad") {
    refs.syncStatus.classList.add("status-bad");
  }
}

function hasCloudConfig() {
  return Boolean(syncState.endpoint);
}

async function loadState() {
  loadLocalState();
  if (!hasCloudConfig()) {
    setSyncStatus("Modo local (sin nube).");
    return;
  }
  await bootstrapCloudSync();
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    applyState(normalizeStatePayload(parsed));
  } catch (error) {
    console.error("No se pudo cargar estado local:", error);
  }
}

async function bootstrapCloudSync() {
  setSyncStatus("Conectando con nube...", "warn");

  try {
    const remoteState = await fetchCloudState();
    const remoteHasData = hasAnyData(remoteState);
    const localHasData = hasAnyData(state);

    if (remoteHasData) {
      applyState(remoteState);
      saveLocalStateOnly();
      setSyncStatus(`Nube conectada. Sync ${formatClock(new Date())}.`, "ok");
      return;
    }

    if (localHasData) {
      await pushStateToCloud({ updateStatus: false });
      setSyncStatus(`Nube conectada. Datos locales subidos ${formatClock(new Date())}.`, "ok");
      return;
    }

    setSyncStatus("Nube conectada. Sin datos todavia.", "ok");
  } catch (error) {
    console.error("No se pudo conectar a la nube:", error);
    setSyncStatus("Error de nube. Guardando solo en local.", "bad");
  }
}

async function pullStateFromCloud({ updateStatus = true, preserveLocalWhenRemoteEmpty = true } = {}) {
  if (!hasCloudConfig()) {
    return false;
  }

  if (updateStatus) {
    setSyncStatus("Descargando datos de nube...", "warn");
  }

  try {
    const remoteState = await fetchCloudState();
    const remoteHasData = hasAnyData(remoteState);

    if (!remoteHasData && preserveLocalWhenRemoteEmpty && hasAnyData(state)) {
      if (updateStatus) {
        setSyncStatus("Nube vacia. Se mantiene tu copia local.", "warn");
      }
      return false;
    }

    applyState(remoteState);
    saveLocalStateOnly();
    renderAll();

    if (updateStatus) {
      setSyncStatus(`Datos de nube cargados ${formatClock(new Date())}.`, "ok");
    }
    return true;
  } catch (error) {
    console.error("No se pudo descargar estado de nube:", error);
    if (updateStatus) {
      setSyncStatus("No se pudo traer datos de nube.", "bad");
    }
    return false;
  }
}

async function fetchCloudState() {
  const response = await requestCloud("load");
  return normalizeStatePayload(response.state);
}

function saveState({ immediateRemote = false } = {}) {
  saveLocalStateOnly();
  queueRemoteSave(immediateRemote);
}

function saveLocalStateOnly() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSerializableState()));
}

function queueRemoteSave(immediate = false) {
  if (!hasCloudConfig()) {
    return;
  }

  if (syncState.saveTimerId) {
    clearTimeout(syncState.saveTimerId);
    syncState.saveTimerId = null;
  }

  if (immediate) {
    void pushStateToCloud({ updateStatus: true });
    return;
  }

  syncState.saveTimerId = window.setTimeout(() => {
    syncState.saveTimerId = null;
    void pushStateToCloud({ updateStatus: true });
  }, REMOTE_SAVE_DEBOUNCE_MS);
}

async function pushStateToCloud({ updateStatus = true } = {}) {
  if (!hasCloudConfig()) {
    return false;
  }

  if (syncState.saveInFlight) {
    syncState.hasPendingSave = true;
    return false;
  }

  syncState.saveInFlight = true;
  if (updateStatus) {
    setSyncStatus("Sincronizando...", "warn");
  }

  try {
    const response = await requestCloud("save", { state: buildSerializableState() });
    if (response && response.state) {
      applyState(normalizeStatePayload(response.state));
      saveLocalStateOnly();
      renderAll();
    }
    if (updateStatus) {
      setSyncStatus(`En nube (${formatClock(new Date())}).`, "ok");
    }
    return true;
  } catch (error) {
    console.error("No se pudo guardar en nube:", error);
    if (updateStatus) {
      setSyncStatus("Error de nube. Guardado local activo.", "bad");
    }
    return false;
  } finally {
    syncState.saveInFlight = false;
    if (syncState.hasPendingSave) {
      syncState.hasPendingSave = false;
      queueRemoteSave(true);
    }
  }
}

async function requestCloud(action, payload = {}) {
  if (!hasCloudConfig()) {
    throw new Error("Sin configuracion de nube.");
  }

  const endpoint = syncState.endpoint;

  if (action === "load") {
    const url = new URL(endpoint);
    url.searchParams.set("action", "load");
    if (syncState.token) {
      url.searchParams.set("token", syncState.token);
    }
    return fetchJson(url.toString(), { method: "GET" });
  }

  if (action === "save") {
    return fetchJson(endpoint, {
      method: "POST",
      body: JSON.stringify({
        action: "save",
        token: syncState.token,
        state: payload.state,
      }),
    });
  }

  throw new Error("Accion remota no soportada.");
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });

    const rawText = await response.text();
    let parsed = {};

    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error("La respuesta remota no es JSON valido.");
      }
    }

    if (!response.ok) {
      throw new Error(parsed.error || `HTTP ${response.status}`);
    }

    if (parsed.ok === false) {
      throw new Error(parsed.error || "La nube devolvio un error.");
    }

    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeStatePayload(value) {
  if (!value || !Array.isArray(value.trips)) {
    return { trips: [], activeTripId: null };
  }
  return {
    trips: value.trips.map(normalizeTrip).filter(Boolean),
    activeTripId: typeof value.activeTripId === "string" ? value.activeTripId : null,
  };
}

function applyState(nextState) {
  state.trips = nextState.trips;
  state.activeTripId = nextState.activeTripId;
  enforceActiveTrip();
}

function buildSerializableState() {
  return {
    trips: state.trips,
    activeTripId: state.activeTripId,
  };
}

function hasAnyData(source) {
  return Array.isArray(source?.trips) && source.trips.length > 0;
}

function normalizeTrip(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const budget = Number(value.budget);
  return {
    id: typeof value.id === "string" ? value.id : createId(),
    name: safeTrim(value.name) || "Viaje sin nombre",
    destination: safeTrim(value.destination),
    startDate: safeTrim(value.startDate),
    endDate: safeTrim(value.endDate),
    budget: Number.isFinite(budget) && budget >= 0 ? budget : 0,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    photoFolderId: safeTrim(value.photoFolderId),
    photoFolderName: safeTrim(value.photoFolderName),
    photoFolderError: safeTrim(value.photoFolderError),
    expenses: Array.isArray(value.expenses)
      ? value.expenses.map(normalizeExpense).filter(Boolean)
      : [],
  };
}

function normalizeExpense(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    id: typeof value.id === "string" ? value.id : createId(),
    date: safeTrim(value.date) || todayIso(),
    category: normalizeCategory(value.category),
    description: safeTrim(value.description) || "Gasto",
    amount,
    paymentMethod: safeTrim(value.paymentMethod) || "Otro",
    billable: Boolean(value.billable),
    notes: safeTrim(value.notes),
    photoDataUrl: safeTrim(value.photoDataUrl),
    photoName: safeTrim(value.photoName),
    photoUrl: safeTrim(value.photoUrl),
    photoFileId: safeTrim(value.photoFileId),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
  };
}

async function readAndCompressImageFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  return compressImageDataUrl(dataUrl, MAX_PHOTO_SIDE, PHOTO_JPEG_QUALITY);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer archivo."));
    reader.readAsDataURL(file);
  });
}

function compressImageDataUrl(dataUrl, maxSidePx, quality) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        reject(new Error("Imagen invalida."));
        return;
      }

      const scale = Math.min(1, maxSidePx / Math.max(sourceWidth, sourceHeight));
      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("No se pudo inicializar canvas."));
        return;
      }

      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => reject(new Error("No se pudo cargar imagen."));
    image.src = dataUrl;
  });
}

function enforceActiveTrip() {
  if (state.trips.length === 0) {
    state.activeTripId = null;
    return;
  }

  const exists = state.trips.some((trip) => trip.id === state.activeTripId);
  if (!exists) {
    state.activeTripId = state.trips[0].id;
  }
}

function getActiveTrip() {
  return state.trips.find((trip) => trip.id === state.activeTripId) || null;
}

function setOptions(select, options, withAllOption = false) {
  const optionList = withAllOption ? ["all", ...options] : options.slice();
  select.innerHTML = optionList
    .map((option) => {
      if (option === "all") {
        return '<option value="all">Todas</option>';
      }
      return `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`;
    })
    .join("");
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseAmount(value) {
  return Number.parseFloat(String(value).replace(",", "."));
}

function normalizeCategory(value) {
  const raw = safeTrim(value);
  if (!raw) {
    return "Otro";
  }

  const key = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, key)) {
    return CATEGORY_ALIASES[key];
  }

  if (CATEGORIES.includes(raw)) {
    return raw;
  }

  return "Otro";
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sortExpensesDesc(a, b) {
  const aTime = dateRank(a);
  const bTime = dateRank(b);
  if (bTime !== aTime) {
    return bTime - aTime;
  }
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function dateRank(expense) {
  const value = Date.parse(`${expense.date || ""}T00:00:00`);
  if (Number.isFinite(value)) {
    return value;
  }
  return Number(expense.createdAt) || 0;
}

function formatCurrency(value) {
  const numeric = Number(value) || 0;
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatClock(date) {
  return date.toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function downloadCsv(fileName, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  const text = String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
