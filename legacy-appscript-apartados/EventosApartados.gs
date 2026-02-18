/***** EVENTOS APARTADOS – HARUJA V2 (Respuestas) *****/

const CALENDAR_ID = '1f848590779335bc8e8c9753076554b1ca8225842e939ef167c58dc34e279e4e@group.calendar.google.com';
const TIMEZONE = 'America/Mexico_City';
const HEADER_ROW_APARTADOS = 1; // 🔹 nombre cambiado para evitar conflicto

// Columnas de salida
const COL_INICIO = 13;
const COL_FIN    = 14;
const COL_STATUS = 15;

// Encabezados buscados
const HEADER_ALIASES = {
  fecha:   ['fecha', 'fecha de apartado'],
  cliente: ['nombre del cliente', 'cliente'],
  pedido:  ['n° de apartado', 'no. de apartado', 'numero de apartado', 'número de apartado', 'folio', 'pedido'],
  codigos: ['código(s) de prenda(s)', 'codigos', 'códigos', 'productos', 'artículos', 'articulos']
};

// === MENÚ ===
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Integraciones Haruja')
    .addItem('Generar/Actualizar eventos desde hoja', 'generarEventosDesdeHoja')
    .addSeparator()
    .addItem('Recrear eventos (fila seleccionada)', 'recrearEventosFilaSeleccionada')
    .addItem('Borrar eventos (fila seleccionada)', 'borrarEventosFilaSeleccionada')
    .addToUi();
}
function onInstall(){ onOpen(); }

// === PRINCIPAL ===
function generarEventosDesdeHoja() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('No se encontró el calendario configurado.');

  ensureOutputHeaders_(sh);

  const { headers, idx } = readHeaders_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_APARTADOS) return;

  let creados = 0, actualizados = 0, saltados = 0;

  const values = sh.getRange(HEADER_ROW_APARTADOS + 1, 1, lastRow - HEADER_ROW_APARTADOS, sh.getLastColumn()).getValues();
  for (let r = 0; r < values.length; r++) {
    const rowNum = HEADER_ROW_APARTADOS + 1 + r;
    try {
      const fechaRaw = idx.fecha >= 0 ? values[r][idx.fecha] : '';
      const fecha = coerceDate_(fechaRaw);
      if (!fecha) { writeStatus_(sh, rowNum, '', '', 'Sin fecha'); saltados++; continue; }

      const cliente = safeStr_(idx.cliente >= 0 ? values[r][idx.cliente] : '');
      const pedido  = safeStr_(idx.pedido  >= 0 ? values[r][idx.pedido]  : '');
      const codigos = safeStr_(idx.codigos >= 0 ? values[r][idx.codigos] : '');

      const start = startOfDay_(fecha);
      const end   = addDays_(start, 30);

      const titleApartado = buildTitle_('Apartado', pedido, cliente);
      const titleVenc     = buildTitle_('Vencimiento apartado', pedido, cliente);
      const description   = buildDescription_(pedido, cliente, codigos);

      const evAResult = upsertAllDayEvent_(cal, start, titleApartado, description);
      const evVResult = upsertAllDayEvent_(cal, end,   titleVenc,     description);

      sh.getRange(rowNum, COL_INICIO).setValue(start);
      sh.getRange(rowNum, COL_FIN).setValue(end);
      const statusText = (evAResult.updated || evVResult.updated) ? 'OK (actualizado)' : 'OK (creado)';
      sh.getRange(rowNum, COL_STATUS).setValue(statusText);

      if (evAResult.updated || evVResult.updated) actualizados++; else creados++;
    } catch(e) {
      writeStatus_(sh, rowNum, '', '', 'Error: ' + e.message);
      saltados++;
    }
  }

  SpreadsheetApp.getActive().toast(`Eventos → ${creados} creados, ${actualizados} actualizados, ${saltados} saltados`, 'Haruja', 8);
}

// === DEMÁS FUNCIONES ===
// (todas igual que antes, solo reemplaza HEADER_ROW por HEADER_ROW_APARTADOS dentro del resto)

// === FUNCIONES AUXILIARES FALTANTES ===

// Escribe fechas y estado en columnas M, N, O y actualiza L (Status) si existe.
function writeStatus_(sh, rowNum, fechaInicio, fechaFin, estado) {
  if (fechaInicio) sh.getRange(rowNum, COL_INICIO).setValue(fechaInicio);
  if (fechaFin) sh.getRange(rowNum, COL_FIN).setValue(fechaFin);
  if (estado) sh.getRange(rowNum, COL_STATUS).setValue(estado);

  // 🔹 Si existe la columna L ("Status"), marca como "Agendado"
  const headers = sh.getRange(HEADER_ROW_APARTADOS, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).toLowerCase());
  const colStatusL = headers.findIndex(h => h === 'status' || h === 'estatus');
  if (colStatusL >= 0 && estado && estado.startsWith('OK')) {
    sh.getRange(rowNum, colStatusL + 1).setValue('Agendado');
  }
}

// === POR FILA ===
function recrearEventosFilaSeleccionada() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('No se encontró el calendario configurado.');
  ensureOutputHeaders_(sh);

  const rowNum = sh.getActiveRange().getRow();
  if (rowNum <= HEADER_ROW) throw new Error('Selecciona una fila de datos.');

  const { headers, idx } = readHeaders_(sh);
  const rowVals = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];

  const fecha = coerceDate_(idx.fecha >= 0 ? rowVals[idx.fecha] : '');
  if (!fecha) throw new Error('La fila seleccionada no tiene fecha válida.');

  const cliente = safeStr_(idx.cliente >= 0 ? rowVals[idx.cliente] : '');
  const pedido  = safeStr_(idx.pedido  >= 0 ? rowVals[idx.pedido]  : '');
  const codigos = safeStr_(idx.codigos >= 0 ? rowVals[idx.codigos] : '');

  const start = startOfDay_(fecha);
  const end   = addDays_(start, 30);

  const titleApartado = buildTitle_('Apartado', pedido, cliente);
  const titleVenc     = buildTitle_('Vencimiento apartado', pedido, cliente);
  const description   = buildDescription_(pedido, cliente, codigos);

  // Borra si hay existentes y recrea
  deleteAllDayEventsByTitleOnDate_(cal, start, titleApartado);
  deleteAllDayEventsByTitleOnDate_(cal, end,   titleVenc);

  cal.createAllDayEvent(titleApartado, start, { description });
  cal.createAllDayEvent(titleVenc,     end,   { description });

  // Escribe M/N/O
  sh.getRange(rowNum, COL_INICIO).setValue(start);
  sh.getRange(rowNum, COL_FIN).setValue(end);
  sh.getRange(rowNum, COL_STATUS).setValue('OK (recreado)');

  SpreadsheetApp.getActive().toast('✅ Eventos recreados para la fila ' + rowNum, 'Haruja', 6);
}

function borrarEventosFilaSeleccionada() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('No se encontró el calendario configurado.');

  const rowNum = sh.getActiveRange().getRow();
  if (rowNum <= HEADER_ROW) throw new Error('Selecciona una fila de datos.');

  const { headers, idx } = readHeaders_(sh);
  const rowVals = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];

  const fecha = coerceDate_(idx.fecha >= 0 ? rowVals[idx.fecha] : '');
  if (!fecha) throw new Error('La fila seleccionada no tiene fecha válida.');

  const cliente = safeStr_(idx.cliente >= 0 ? rowVals[idx.cliente] : '');
  const pedido  = safeStr_(idx.pedido  >= 0 ? rowVals[idx.pedido]  : '');

  const start = startOfDay_(fecha);
  const end   = addDays_(start, 30);

  const titleApartado = buildTitle_('Apartado', pedido, cliente);
  const titleVenc     = buildTitle_('Vencimiento apartado', pedido, cliente);

  const delA = deleteAllDayEventsByTitleOnDate_(cal, start, titleApartado);
  const delV = deleteAllDayEventsByTitleOnDate_(cal, end,   titleVenc);

  // Limpia M/N/O
  sh.getRange(rowNum, COL_STATUS).setValue(delA + delV > 0 ? 'Eliminado(s)' : 'Sin eventos');
  SpreadsheetApp.getActive().toast('🗑️ Eventos borrados para la fila ' + rowNum, 'Haruja', 6);
}

// === HELPERS ===
function ensureOutputHeaders_(sh) {
  const needed = [
    { col: COL_INICIO, name: 'Inicio apartado' },
    { col: COL_FIN,    name: 'Fin apartado (+30d)' },
    { col: COL_STATUS, name: 'Estado eventos' }
  ];
  needed.forEach(n => {
    if (sh.getLastColumn() < n.col) {
      // Expandir columnas si hiciera falta
      sh.insertColumnsAfter(sh.getLastColumn(), n.col - sh.getLastColumn());
    }
    const cell = sh.getRange(HEADER_ROW, n.col);
    if (!String(cell.getValue()).trim()) cell.setValue(n.name);
  });
}

function readHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const lc = headers.map(h => h.toLowerCase());

  function findIdx(aliases) {
    return lc.findIndex(h => aliases.some(a => h === a.toLowerCase()));
  }

  return {
    headers,
    idx: {
      fecha:   findIdx(HEADER_ALIASES.fecha),
      cliente: findIdx(HEADER_ALIASES.cliente),
      pedido:  findIdx(HEADER_ALIASES.pedido),
      codigos: findIdx(HEADER_ALIASES.codigos)
    }
  };
}

function upsertAllDayEvent_(cal, date, title, description) {
  const found = findAllDayEventsByTitleOnDate_(cal, date, title);
  if (found.length > 0) {
    found.forEach(ev => {
      ev.setTitle(title);
      ev.setDescription(description || '');
      // asegurar que sea all-day en la fecha correcta
      ev.setAllDayDate(date);
    });
    return { updated: true };
  } else {
    cal.createAllDayEvent(title, date, { description: description || '' });
    return { updated: false };
  }
}

function deleteAllDayEventsByTitleOnDate_(cal, date, title) {
  const found = findAllDayEventsByTitleOnDate_(cal, date, title);
  found.forEach(ev => ev.deleteEvent());
  return found.length;
}

function findAllDayEventsByTitleOnDate_(cal, date, title) {
  const events = cal.getEventsForDay(date);
  return events.filter(ev =>
    ev.isAllDayEvent() &&
    ev.getTitle() === title
  );
}

function buildTitle_(prefix, pedido, cliente) {
  const p = pedido ? ` ${pedido}` : '';
  const c = cliente ? ` – ${cliente}` : '';
  return `${prefix}${p}${c}`.trim();
}

function buildDescription_(pedido, cliente, codigos) {
  const parts = [];
  if (pedido)  parts.push(`Pedido: ${pedido}`);
  if (cliente) parts.push(`Cliente: ${cliente}`);
  if (codigos) parts.push(`Códigos: ${codigos}`);
  return parts.join('\n');
}

function coerceDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays_(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function safeStr_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}
