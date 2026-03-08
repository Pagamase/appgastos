const LEGACY_STORAGE_SHEET_NAME = "FlugeData";
const LEGACY_STORAGE_ROW = 2;
const STATE_JSON_PROPERTY_KEY = "FLUGE_STATE_JSON";
const STATE_UPDATED_AT_PROPERTY_KEY = "FLUGE_STATE_UPDATED_AT_ISO";
const SHARED_TOKEN = "";

// Nombre exacto de tu hoja base (pestana) dentro del mismo spreadsheet.
const TEMPLATE_SHEET_NAME = "Gastos_Base";

// Texto marcador dentro del nombre de la plantilla que se reemplaza por el destino.
const TEMPLATE_DESTINATION_TOKEN = "Base";

// Si esta en true, cada viaje nuevo crea su propia pestana desde TEMPLATE_SHEET_NAME.
const AUTO_CREATE_TRIP_SHEETS = true;

const TRIP_MAP_SHEET_NAME = "_TripSheetMap";
const EXPENSES_START_ROW = 3;
const EXPENSES_COL_COUNT = 7;
const PHOTO_FOLDER_NAME = "_FlugeGastosFotos";

function doGet(e) {
  return handleRequest_(e);
}

function doPost(e) {
  return handleRequest_(e);
}

function handleRequest_(e) {
  try {
    const payload = parsePayload_(e);
    const action = getAction_(e, payload);
    const token = String(payload.token || getParam_(e, "token", ""));

    if (!isAuthorized_(token)) {
      return json_({ ok: false, error: "unauthorized" });
    }

    if (action === "load") {
      return json_(loadState_());
    }

    if (action === "save") {
      return json_(saveState_(payload.state));
    }

    return json_({ ok: false, error: "unknown_action" });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function loadState_() {
  const stored = getStoredStatePayload_();
  const jsonText = stored.jsonText;
  const updatedAt = stored.updatedAt;

  if (!jsonText) {
    return {
      ok: true,
      state: { trips: [], activeTripId: null },
      updatedAt: updatedAt,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_error) {
    parsed = { trips: [], activeTripId: null };
  }

  const state = sanitizeState_(parsed);
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const changedFromSheet = reconcileStateExpensesFromSheets_(spreadsheet, state);
  let finalUpdatedAt = updatedAt;

  if (changedFromSheet) {
    finalUpdatedAt = new Date().toISOString();
    writeStoredStatePayload_(JSON.stringify(state), finalUpdatedAt);
  }

  return {
    ok: true,
    state: state,
    updatedAt: finalUpdatedAt,
  };
}

function saveState_(rawState) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const tripMapSheet = getTripMapSheet_(spreadsheet);
  const previousState = readStoredState_();
  const state = sanitizeState_(rawState);
  preserveServerTripMetadata_(previousState, state);
  const nowIso = new Date().toISOString();

  let createdSheets = [];
  let mapByTripId = {};
  if (AUTO_CREATE_TRIP_SHEETS) {
    const ensureResult = ensureTripSheets_(
      spreadsheet,
      tripMapSheet,
      previousState,
      state,
      nowIso,
    );
    createdSheets = ensureResult.createdSheets;
    mapByTripId = ensureResult.mapByTripId;
  } else {
    mapByTripId = readTripMap_(tripMapSheet);
  }

  const syncReport = syncTripExpensesToSheets_(
    spreadsheet,
    tripMapSheet,
    state,
    mapByTripId,
    nowIso,
    createdSheets,
  );
  writeStoredStatePayload_(JSON.stringify(state), nowIso);
  removeLegacyStorageSheetIfPresent_();

  return {
    ok: true,
    state: state,
    updatedAt: nowIso,
    createdSheets: createdSheets,
    syncReport: syncReport,
  };
}

function ensureTripSheets_(spreadsheet, tripMapSheet, previousState, nextState, nowIso) {
  const templateSheet = getTemplateSheet_(spreadsheet);
  const mapByTripId = readTripMap_(tripMapSheet);
  const previousIds = toTripIdMap_(previousState && previousState.trips);
  const createdSheets = [];

  const trips = Array.isArray(nextState.trips) ? nextState.trips : [];
  for (let i = 0; i < trips.length; i += 1) {
    const trip = trips[i];
    const tripId = ensureTripId_(trip);
    if (!tripId) {
      continue;
    }

    const mappedSheetName = String(mapByTripId[tripId] || "").trim();
    if (mappedSheetName && spreadsheet.getSheetByName(mappedSheetName)) {
      continue;
    }

    // Crea hoja para viajes nuevos o para viajes existentes que aun no tengan mapeo.
    const baseName = buildTripSheetBaseName_(trip, templateSheet.getName());
    const finalSheetName = makeUniqueSheetName_(spreadsheet, baseName);
    const newSheet = templateSheet.copyTo(spreadsheet);
    newSheet.setName(finalSheetName);
    replaceTemplateTokens_(newSheet, trip);
    writeTripHeaderInA1G1_(newSheet, trip);
    appendTripMapRow_(tripMapSheet, tripId, finalSheetName, nowIso);
    mapByTripId[tripId] = finalSheetName;
    createdSheets.push({
      tripId: tripId,
      sheetName: finalSheetName,
      reason: previousIds[tripId] ? "missing_map" : "new_trip",
    });
  }

  return {
    createdSheets: createdSheets,
    mapByTripId: mapByTripId,
  };
}

function syncTripExpensesToSheets_(
  spreadsheet,
  tripMapSheet,
  state,
  mapByTripId,
  nowIso,
  createdSheets,
) {
  const trips = Array.isArray(state.trips) ? state.trips : [];
  const report = [];

  for (let i = 0; i < trips.length; i += 1) {
    const trip = trips[i];
    const tripId = ensureTripId_(trip);
    if (!tripId) {
      report.push({
        tripId: "",
        status: "skip_no_trip_id",
      });
      continue;
    }

    const tripPhotoFolder = ensureTripPhotoFolder_(trip);

    const resolveResult = resolveTripSheetForSync_(
      spreadsheet,
      tripMapSheet,
      mapByTripId,
      trip,
      tripId,
      nowIso,
      createdSheets,
    );
    if (!resolveResult.sheet) {
      report.push({
        tripId: tripId,
        sheetName: resolveResult.sheetName,
        status: resolveResult.status,
      });
      continue;
    }

    const expenses = Array.isArray(trip.expenses) ? trip.expenses : [];
    const rows = [];
    let photoCount = 0;
    let photoLinkedCount = 0;
    let photoUploadErrorCount = 0;

    for (let j = 0; j < expenses.length; j += 1) {
      const expense = expenses[j];
      const hasPhotoPayload = String(expense && expense.photoDataUrl ? expense.photoDataUrl : "").trim();
      if (hasPhotoPayload) {
        photoCount += 1;
      }
      rows.push(buildExpenseRow_(trip, expense));
      if (String(expense && expense.photoUrl ? expense.photoUrl : "").trim()) {
        photoLinkedCount += 1;
      }
      if (String(expense && expense.photoUploadError ? expense.photoUploadError : "").trim()) {
        photoUploadErrorCount += 1;
      }
    }

    writeExpenseRows_(resolveResult.sheet, rows);
    report.push({
      tripId: tripId,
      sheetName: resolveResult.sheetName,
      tripFolderName: tripPhotoFolder ? tripPhotoFolder.getName() : String(trip.photoFolderName || ""),
      status: resolveResult.created ? "written_after_sheet_recovery" : "written",
      expenseCount: expenses.length,
      wroteRows: rows.length,
      photoCount: photoCount,
      photoLinkedCount: photoLinkedCount,
      photoUploadErrorCount: photoUploadErrorCount,
    });
  }

  return report;
}

function resolveTripSheetForSync_(
  spreadsheet,
  tripMapSheet,
  mapByTripId,
  trip,
  tripId,
  nowIso,
  createdSheets,
) {
  const mappedSheetName = String(mapByTripId[tripId] || "").trim();
  if (mappedSheetName) {
    const mappedSheet = spreadsheet.getSheetByName(mappedSheetName);
    if (mappedSheet) {
      return {
        sheetName: mappedSheetName,
        sheet: mappedSheet,
        created: false,
        status: "mapped",
      };
    }
  }

  if (!AUTO_CREATE_TRIP_SHEETS) {
    return {
      sheetName: mappedSheetName,
      sheet: null,
      created: false,
      status: mappedSheetName ? "skip_sheet_not_found" : "skip_no_sheet_mapping",
    };
  }

  const templateSheet = getTemplateSheet_(spreadsheet);
  const baseName = buildTripSheetBaseName_(trip, templateSheet.getName());
  const finalSheetName = makeUniqueSheetName_(spreadsheet, baseName);
  const newSheet = templateSheet.copyTo(spreadsheet);
  newSheet.setName(finalSheetName);
  replaceTemplateTokens_(newSheet, trip);
  writeTripHeaderInA1G1_(newSheet, trip);

  appendTripMapRow_(tripMapSheet, tripId, finalSheetName, nowIso);
  mapByTripId[tripId] = finalSheetName;

  if (Array.isArray(createdSheets)) {
    createdSheets.push({
      tripId: tripId,
      sheetName: finalSheetName,
      reason: mappedSheetName ? "recreated_missing_sheet" : "missing_map_on_save",
    });
  }

  return {
    sheetName: finalSheetName,
    sheet: newSheet,
    created: true,
    status: mappedSheetName ? "sheet_recreated" : "sheet_created_missing_map",
  };
}

function writeExpenseRows_(sheet, rows) {
  const maxRows = sheet.getMaxRows();
  const clearRowsCount = Math.max(1, maxRows - EXPENSES_START_ROW + 1);
  sheet
    .getRange(EXPENSES_START_ROW, 1, clearRowsCount, EXPENSES_COL_COUNT)
    .clearContent();

  if (!rows.length) {
    return;
  }

  const neededRows = EXPENSES_START_ROW - 1 + rows.length;
  if (sheet.getMaxRows() < neededRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  }

  sheet
    .getRange(EXPENSES_START_ROW, 1, rows.length, EXPENSES_COL_COUNT)
    .setValues(rows);
}

function buildExpenseRow_(trip, expense) {
  const photoUrl = ensureExpensePhotoUrl_(trip, expense);
  return [
    formatDateForSheet_(expense && expense.date ? expense.date : ""),
    sanitizeCellText_(expense && expense.category ? expense.category : ""),
    sanitizeCellText_(expense && expense.description ? expense.description : ""),
    toSheetAmount_(expense && expense.amount),
    sanitizeCellText_(expense && expense.paymentMethod ? expense.paymentMethod : ""),
    sanitizeCellText_(expense && expense.notes ? expense.notes : ""),
    sanitizeCellText_(photoUrl),
  ];
}

function ensureExpensePhotoUrl_(trip, expense) {
  if (!expense || typeof expense !== "object") {
    return "";
  }

  const currentUrl = String(expense.photoUrl || "").trim();
  if (currentUrl) {
    expense.photoUploadError = "";
    return currentUrl;
  }

  const currentFileId = String(expense.photoFileId || "").trim();
  if (currentFileId) {
    const existingUrl = buildDriveFileUrl_(currentFileId);
    expense.photoUrl = existingUrl;
    expense.photoUploadError = "";
    return existingUrl;
  }

  const dataUrl = String(expense.photoDataUrl || "").trim();
  if (!dataUrl) {
    expense.photoUploadError = "";
    return "";
  }

  try {
    const uploadResult = uploadExpensePhotoFromDataUrl_(trip, expense, dataUrl);
    expense.photoFileId = uploadResult.fileId;
    expense.photoUrl = uploadResult.url;
    expense.photoDataUrl = "";
    expense.photoUploadError = "";
    return uploadResult.url;
  } catch (error) {
    // Si falla subida de foto, no rompe guardado del gasto.
    const message = String(error && error.message ? error.message : error || "");
    expense.photoUploadError = message;
    Logger.log("Photo upload error: " + message);
    return "";
  }
}

function uploadExpensePhotoFromDataUrl_(trip, expense, dataUrl) {
  const parsed = parseDataUrl_(dataUrl);
  if (!parsed) {
    throw new Error("Formato de foto invalido.");
  }

  const folder = getOrCreateTripPhotosFolder_(trip);
  const extension = extensionFromMimeType_(parsed.mimeType);
  const fileName = buildPhotoFileName_(trip, expense, extension);
  const blob = Utilities.newBlob(parsed.bytes, parsed.mimeType, fileName);
  const file = folder.createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (_error) {
    // Si no puede cambiar permisos, conserva URL interna de Drive.
  }

  return {
    fileId: file.getId(),
    url: buildDriveFileUrl_(file.getId()),
  };
}

function parseDataUrl_(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    bytes: Utilities.base64Decode(match[2]),
  };
}

function getOrCreatePhotosRootFolder_() {
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function ensureTripPhotoFolder_(trip) {
  if (!trip || typeof trip !== "object") {
    return null;
  }

  try {
    const folder = getOrCreateTripPhotosFolder_(trip);
    trip.photoFolderError = "";
    return folder;
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");
    trip.photoFolderError = message;
    Logger.log("Trip photo folder error: " + message);
    return null;
  }
}

function getOrCreateTripPhotosFolder_(trip) {
  if (!trip || typeof trip !== "object") {
    throw new Error("Viaje invalido para carpeta de fotos.");
  }

  const tripId = ensureTripId_(trip);
  if (!tripId) {
    throw new Error("No se puede crear carpeta: viaje sin id.");
  }

  const currentFolderId = String(trip.photoFolderId || "").trim();
  if (currentFolderId) {
    try {
      const existingFolder = DriveApp.getFolderById(currentFolderId);
      trip.photoFolderName = existingFolder.getName();
      trip.photoFolderError = "";
      return existingFolder;
    } catch (_error) {
      // Si el id guardado ya no existe o no es accesible, se recrea carpeta.
    }
  }

  const rootFolder = getOrCreatePhotosRootFolder_();
  const baseName = buildTripPhotosFolderName_(trip);
  const existingByName = findExistingTripFolderByName_(rootFolder, trip, baseName);
  if (existingByName) {
    trip.photoFolderId = existingByName.getId();
    trip.photoFolderName = existingByName.getName();
    trip.photoFolderError = "";
    return existingByName;
  }
  const finalFolderName = makeUniqueChildFolderName_(rootFolder, baseName);
  const newFolder = rootFolder.createFolder(finalFolderName);

  trip.photoFolderId = newFolder.getId();
  trip.photoFolderName = newFolder.getName();
  trip.photoFolderError = "";
  return newFolder;
}

function buildTripPhotosFolderName_(trip) {
  const tripName = String(trip && trip.name ? trip.name : "").trim() || "Viaje";
  const destination = getTripDestination_(trip);
  return sanitizeDriveFolderName_(tripName + " - " + destination);
}

function makeUniqueChildFolderName_(parentFolder, baseName) {
  const normalizedBase = String(baseName || "").trim() || "Viaje - Sin destino";
  let candidate = normalizedBase;
  let counter = 2;

  while (parentFolder.getFoldersByName(candidate).hasNext()) {
    const suffix = " (" + counter + ")";
    const maxBaseLength = Math.max(1, 200 - suffix.length);
    const trimmedBase = normalizedBase.substring(0, maxBaseLength).trim();
    candidate = trimmedBase + suffix;
    counter += 1;
  }

  return candidate;
}

function sanitizeDriveFolderName_(value) {
  let text = String(value || "").trim();
  text = text.replace(/[\\\/]+/g, "-");
  text = text.replace(/\s+/g, " ").trim();

  if (text.length > 200) {
    text = text.substring(0, 200).trim();
  }
  if (!text) {
    return "Viaje - Sin destino";
  }
  return text;
}

function findExistingTripFolderByName_(rootFolder, trip, baseName) {
  const candidates = [];
  const storedName = sanitizeDriveFolderName_(String(trip && trip.photoFolderName ? trip.photoFolderName : ""));
  if (storedName) {
    candidates.push(storedName);
  }
  if (baseName && candidates.indexOf(baseName) === -1) {
    candidates.push(baseName);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const currentName = candidates[i];
    if (!currentName) {
      continue;
    }
    const folders = rootFolder.getFoldersByName(currentName);
    if (folders.hasNext()) {
      return folders.next();
    }
  }

  return null;
}

function preserveServerTripMetadata_(previousState, nextState) {
  const prevTrips = Array.isArray(previousState && previousState.trips)
    ? previousState.trips
    : [];
  const nextTrips = Array.isArray(nextState && nextState.trips) ? nextState.trips : [];
  if (!prevTrips.length || !nextTrips.length) {
    return;
  }

  const prevByTripId = {};
  for (let i = 0; i < prevTrips.length; i += 1) {
    const previousTrip = prevTrips[i];
    const tripId = getTripId_(previousTrip);
    if (!tripId) {
      continue;
    }
    prevByTripId[tripId] = previousTrip;
  }

  for (let j = 0; j < nextTrips.length; j += 1) {
    const nextTrip = nextTrips[j];
    const tripId = getTripId_(nextTrip);
    if (!tripId) {
      continue;
    }

    const previousTrip = prevByTripId[tripId];
    if (!previousTrip) {
      continue;
    }

    if (!String(nextTrip.photoFolderId || "").trim()) {
      nextTrip.photoFolderId = String(previousTrip.photoFolderId || "").trim();
    }
    if (!String(nextTrip.photoFolderName || "").trim()) {
      nextTrip.photoFolderName = String(previousTrip.photoFolderName || "").trim();
    }
  }
}

function extensionFromMimeType_(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "image/png") {
    return "png";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  return "jpg";
}

function buildPhotoFileName_(trip, expense, extension) {
  const categoryPart = sanitizeFileSegment_((expense && expense.category) || "SinCategoria");
  const rawDate = (expense && expense.date) || Utilities.formatDate(new Date(), "GMT+0", "yyyy-MM-dd");
  const datePart = sanitizeFileSegment_(formatDateForFileName_(rawDate));
  const cityPart = sanitizeFileSegment_(getTripDestination_(trip));
  return categoryPart + "_" + datePart + "_" + cityPart + "." + extension;
}

function formatDateForFileName_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return match[3] + "-" + match[2] + "-" + match[1];
  }
  return text.replace(/\//g, "-");
}

function sanitizeFileSegment_(value) {
  const text = String(value || "").trim();
  const cleaned = text.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "item";
}

function buildDriveFileUrl_(fileId) {
  return "https://drive.google.com/file/d/" + String(fileId || "") + "/view";
}

function authorizeDriveAccess() {
  const rootFolder = getOrCreatePhotosRootFolder_();
  const state = readStoredState_();
  const trips = Array.isArray(state.trips) ? state.trips : [];
  const tripFolders = [];

  for (let i = 0; i < trips.length; i += 1) {
    const trip = trips[i];
    const folder = ensureTripPhotoFolder_(trip);
    if (!folder) {
      continue;
    }
    tripFolders.push({
      tripId: String(getTripId_(trip) || ""),
      folderId: folder.getId(),
      folderName: folder.getName(),
    });
  }

  writeStoredStatePayload_(JSON.stringify(state), new Date().toISOString());

  return {
    ok: true,
    folderId: rootFolder.getId(),
    folderName: rootFolder.getName(),
    tripFolderCount: tripFolders.length,
    tripFolders: tripFolders,
  };
}

function formatDateForSheet_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return text;
  }
  return match[3] + "/" + match[2] + "/" + match[1];
}

function toSheetAmount_(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric;
}

function reconcileStateExpensesFromSheets_(spreadsheet, state) {
  const trips = Array.isArray(state && state.trips) ? state.trips : [];
  if (!trips.length) {
    return false;
  }

  const mapByTripId = readTripMap_(getTripMapSheet_(spreadsheet));
  let changed = false;

  for (let i = 0; i < trips.length; i += 1) {
    const trip = trips[i];
    const tripId = getTripId_(trip);
    if (!tripId) {
      continue;
    }

    const sheetName = String(mapByTripId[tripId] || "").trim();
    if (!sheetName) {
      continue;
    }

    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      continue;
    }

    const existingExpenses = Array.isArray(trip.expenses) ? trip.expenses : [];
    const expensesFromSheet = readExpensesFromTripSheet_(sheet, existingExpenses);
    if (areExpenseListsEquivalent_(existingExpenses, expensesFromSheet)) {
      continue;
    }

    trip.expenses = expensesFromSheet;
    changed = true;
  }

  return changed;
}

function readExpensesFromTripSheet_(sheet, previousExpenses) {
  const lastRow = sheet.getLastRow();
  if (lastRow < EXPENSES_START_ROW) {
    return [];
  }

  const rowCount = lastRow - EXPENSES_START_ROW + 1;
  const values = sheet
    .getRange(EXPENSES_START_ROW, 1, rowCount, EXPENSES_COL_COUNT)
    .getValues();
  const reusableIds = buildReusableExpenseIds_(previousExpenses);
  const result = [];

  for (let i = 0; i < values.length; i += 1) {
    const parsed = expenseFromSheetRow_(values[i]);
    if (!parsed) {
      continue;
    }

    parsed.id = takeReusableExpenseId_(reusableIds, parsed) || Utilities.getUuid();
    result.push(parsed);
  }

  return result;
}

function expenseFromSheetRow_(row) {
  const dateIso = normalizeSheetDateToIso_(row[0]);
  const category = String(row[1] || "").trim();
  const description = String(row[2] || "").trim();
  const amount = Number(row[3]);
  const paymentMethod = String(row[4] || "").trim();
  const notes = String(row[5] || "").trim();
  const photoUrl = String(row[6] || "").trim();

  const hasAnyData = Boolean(
    dateIso || category || description || paymentMethod || notes || photoUrl || Number.isFinite(amount),
  );
  if (!hasAnyData) {
    return null;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    id: "",
    date: dateIso || isoDateToday_(),
    category: category || "Otro",
    description: description || "Gasto",
    amount: amount,
    paymentMethod: paymentMethod || "Otro",
    billable: false,
    notes: notes,
    photoDataUrl: "",
    photoName: "",
    photoUrl: photoUrl,
    photoFileId: extractDriveFileIdFromUrl_(photoUrl),
    createdAt: Date.now(),
  };
}

function buildReusableExpenseIds_(expenses) {
  const buckets = {};
  if (!Array.isArray(expenses)) {
    return buckets;
  }

  for (let i = 0; i < expenses.length; i += 1) {
    const expense = expenses[i];
    const id = String(expense && expense.id ? expense.id : "").trim();
    if (!id) {
      continue;
    }

    const key = expenseFingerprint_(expense);
    if (!buckets[key]) {
      buckets[key] = [];
    }
    buckets[key].push(id);
  }

  return buckets;
}

function takeReusableExpenseId_(buckets, expense) {
  const key = expenseFingerprint_(expense);
  const ids = buckets[key];
  if (!ids || !ids.length) {
    return "";
  }
  return String(ids.shift() || "");
}

function expenseFingerprint_(expense) {
  return [
    String(expense && expense.date ? expense.date : "").trim(),
    String(expense && expense.category ? expense.category : "").trim(),
    String(expense && expense.description ? expense.description : "").trim(),
    normalizeAmountForFingerprint_(expense && expense.amount),
    String(expense && expense.paymentMethod ? expense.paymentMethod : "").trim(),
    String(expense && expense.notes ? expense.notes : "").trim(),
    String(expense && expense.photoUrl ? expense.photoUrl : "").trim(),
  ].join("|");
}

function normalizeAmountForFingerprint_(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  return amount.toFixed(2);
}

function areExpenseListsEquivalent_(left, right) {
  const leftItems = Array.isArray(left) ? left : [];
  const rightItems = Array.isArray(right) ? right : [];

  if (leftItems.length !== rightItems.length) {
    return false;
  }

  for (let i = 0; i < leftItems.length; i += 1) {
    if (expenseFingerprint_(leftItems[i]) !== expenseFingerprint_(rightItems[i])) {
      return false;
    }
  }

  return true;
}

function normalizeSheetDateToIso_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    const dateValue = new Date(value);
    if (!isNaN(dateValue.getTime())) {
      return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
  }

  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return match[1] + "-" + match[2] + "-" + match[3];
  }

  match = text.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (match) {
    return match[3] + "-" + match[2] + "-" + match[1];
  }

  return "";
}

function isoDateToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function extractDriveFileIdFromUrl_(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/\/d\/([^\/\?]+)/);
  if (!match) {
    return "";
  }
  return String(match[1] || "").trim();
}

function sanitizeCellText_(value) {
  let text = String(value || "");
  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }
  return text;
}

function getTemplateSheet_(spreadsheet) {
  const template = spreadsheet.getSheetByName(TEMPLATE_SHEET_NAME);
  if (!template) {
    throw new Error(
      'No existe la hoja plantilla "' +
        TEMPLATE_SHEET_NAME +
        '". Actualiza TEMPLATE_SHEET_NAME en Code.gs.',
    );
  }
  return template;
}

function getTripMapSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(TRIP_MAP_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(TRIP_MAP_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([["trip_id", "sheet_name", "created_at_iso"]]);
    sheet.hideSheet();
  } else if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 3).setValues([["trip_id", "sheet_name", "created_at_iso"]]);
  }
  return sheet;
}

function readTripMap_(sheet) {
  const mapByTripId = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return mapByTripId;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < values.length; i += 1) {
    const tripId = String(values[i][0] || "").trim();
    const sheetName = String(values[i][1] || "").trim();
    if (!tripId || !sheetName) {
      continue;
    }
    mapByTripId[tripId] = sheetName;
  }
  return mapByTripId;
}

function appendTripMapRow_(sheet, tripId, sheetName, nowIso) {
  sheet.appendRow([tripId, sheetName, nowIso]);
}

function replaceTemplateTokens_(sheet, trip) {
  const replacements = [
    { token: "{{TRIP_ID}}", value: String(getTripId_(trip) || "") },
    { token: "{{TRIP_NAME}}", value: String(trip && trip.name ? trip.name : "") },
    { token: "{{DESTINATION}}", value: String(trip && trip.destination ? trip.destination : "") },
    { token: "{{START_DATE}}", value: String(trip && trip.startDate ? trip.startDate : "") },
    { token: "{{END_DATE}}", value: String(trip && trip.endDate ? trip.endDate : "") },
    { token: "{{BUDGET}}", value: String(trip && trip.budget != null ? trip.budget : "") },
  ];

  for (let i = 0; i < replacements.length; i += 1) {
    const current = replacements[i];
    sheet
      .createTextFinder(current.token)
      .matchCase(true)
      .matchEntireCell(false)
      .replaceAllWith(current.value);
  }
}

function buildTripSheetBaseName_(trip, templateSheetName) {
  const templateName = String(templateSheetName || TEMPLATE_SHEET_NAME || "Gastos_Base");
  const destination = sanitizeSheetName_(getTripDestination_(trip));
  const tokenRegex = new RegExp(TEMPLATE_DESTINATION_TOKEN, "i");

  if (tokenRegex.test(templateName)) {
    return sanitizeSheetName_(templateName.replace(tokenRegex, destination));
  }

  return sanitizeSheetName_(templateName + "_" + destination);
}

function writeTripHeaderInA1G1_(sheet, trip) {
  const headerText = buildTripHeaderText_(trip);
  const headerRange = sheet.getRange("A1:G1");

  // Fuerza que A1:G1 sea una sola celda visual para el titulo del viaje.
  if (headerRange.isPartOfMerge()) {
    headerRange.breakApart();
  }
  headerRange.merge();
  sheet.getRange("A1").setValue(headerText);
}

function buildTripHeaderText_(trip) {
  const destination = getTripDestination_(trip);
  const startDate = formatHeaderDate_(trip && trip.startDate ? String(trip.startDate) : "");
  const endDate = formatHeaderDate_(trip && trip.endDate ? String(trip.endDate) : "");
  return (
    'Viaje a "' +
    destination +
    '" entre las fechas "' +
    startDate +
    '" y "' +
    endDate +
    '"'
  );
}

function getTripDestination_(trip) {
  const destination = trip && trip.destination ? String(trip.destination).trim() : "";
  if (destination) {
    return destination;
  }
  return "Sin destino";
}

function formatHeaderDate_(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "sin fecha";
  }

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return text;
  }

  return match[3] + "/" + match[2] + "/" + match[1];
}

function sanitizeSheetName_(raw) {
  let name = String(raw || "").trim();
  if (!name) {
    name = "Viaje";
  }

  // Caracteres no permitidos en nombres de pestana en Google Sheets.
  name = name.replace(/[\[\]\*\/\\\?\:]/g, "-");
  name = name.replace(/\s+/g, " ").trim();

  if (name.length > 100) {
    name = name.substring(0, 100).trim();
  }
  if (!name) {
    name = "Viaje";
  }
  return name;
}

function makeUniqueSheetName_(spreadsheet, baseName) {
  let candidate = baseName;
  let counter = 2;

  while (spreadsheet.getSheetByName(candidate)) {
    const suffix = " (" + counter + ")";
    const maxBaseLength = Math.max(1, 100 - suffix.length);
    const trimmedBase = baseName.substring(0, maxBaseLength).trim();
    candidate = trimmedBase + suffix;
    counter += 1;
  }

  return candidate;
}

function toTripIdMap_(trips) {
  const map = {};
  if (!Array.isArray(trips)) {
    return map;
  }
  for (let i = 0; i < trips.length; i += 1) {
    const id = getTripId_(trips[i]);
    if (id) {
      map[id] = true;
    }
  }
  return map;
}

function getTripId_(trip) {
  if (!trip || typeof trip !== "object") {
    return "";
  }
  const id = String(trip.id || "").trim();
  return id;
}

function ensureTripId_(trip) {
  const existingId = getTripId_(trip);
  if (existingId) {
    return existingId;
  }
  if (!trip || typeof trip !== "object") {
    return "";
  }
  const generatedId = Utilities.getUuid();
  trip.id = generatedId;
  return generatedId;
}

function readStoredState_() {
  const stored = getStoredStatePayload_();
  if (!stored.jsonText) {
    return { trips: [], activeTripId: null };
  }

  try {
    return sanitizeState_(JSON.parse(stored.jsonText));
  } catch (_error) {
    return { trips: [], activeTripId: null };
  }
}

function getStoredStatePayload_() {
  const props = PropertiesService.getScriptProperties();
  const jsonText = String(props.getProperty(STATE_JSON_PROPERTY_KEY) || "").trim();
  const updatedAt = String(props.getProperty(STATE_UPDATED_AT_PROPERTY_KEY) || "");

  if (jsonText) {
    return { jsonText: jsonText, updatedAt: updatedAt };
  }

  // Compatibilidad: si habia datos antiguos en la hoja FlugeData, los migra a propiedades.
  const legacy = readLegacyStoragePayload_();
  if (legacy.jsonText) {
    writeStoredStatePayload_(legacy.jsonText, legacy.updatedAt || "");
    removeLegacyStorageSheetIfPresent_();
  }
  return legacy;
}

function writeStoredStatePayload_(jsonText, updatedAt) {
  PropertiesService.getScriptProperties().setProperties({
    [STATE_JSON_PROPERTY_KEY]: String(jsonText || ""),
    [STATE_UPDATED_AT_PROPERTY_KEY]: String(updatedAt || ""),
  });
}

function readLegacyStoragePayload_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(LEGACY_STORAGE_SHEET_NAME);

  if (!sheet) {
    return { jsonText: "", updatedAt: "" };
  }

  const jsonText = String(sheet.getRange(LEGACY_STORAGE_ROW, 1).getValue() || "").trim();
  const updatedAt = String(sheet.getRange(LEGACY_STORAGE_ROW, 2).getValue() || "");
  return { jsonText: jsonText, updatedAt: updatedAt };
}

function removeLegacyStorageSheetIfPresent_() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    let legacySheet = spreadsheet.getSheetByName(LEGACY_STORAGE_SHEET_NAME);
    if (!legacySheet) {
      return;
    }

    const allSheets = spreadsheet.getSheets();
    if (allSheets.length <= 1) {
      if (!legacySheet.isSheetHidden()) {
        legacySheet.hideSheet();
      }
      return;
    }

    spreadsheet.deleteSheet(legacySheet);
  } catch (_error) {
    // Nunca bloquear la app por limpieza legacy.
    try {
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      const legacySheet = spreadsheet.getSheetByName(LEGACY_STORAGE_SHEET_NAME);
      if (legacySheet && !legacySheet.isSheetHidden()) {
        legacySheet.hideSheet();
      }
    } catch (_ignore) {
      // no-op
    }
  }
}

function sanitizeState_(value) {
  if (!value || typeof value !== "object") {
    return { trips: [], activeTripId: null };
  }

  const trips = Array.isArray(value.trips) ? value.trips : [];
  const activeTripId = typeof value.activeTripId === "string" ? value.activeTripId : null;

  return {
    trips: trips,
    activeTripId: activeTripId,
  };
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  try {
    const raw = String(e.postData.contents || "").trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function getAction_(e, payload) {
  const fromPayload = String(payload.action || "");
  if (fromPayload) {
    return fromPayload;
  }
  return String(getParam_(e, "action", "load"));
}

function getParam_(e, key, fallback) {
  if (e && e.parameter && Object.prototype.hasOwnProperty.call(e.parameter, key)) {
    return String(e.parameter[key] || "");
  }
  return fallback;
}

function isAuthorized_(token) {
  if (!SHARED_TOKEN) {
    return true;
  }
  return token === SHARED_TOKEN;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
