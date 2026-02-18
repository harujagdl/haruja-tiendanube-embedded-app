/*************************************************
 * ================ CONFIGURACIÓN ================
 *************************************************/
const ID_BASE_APARTADOS      = '17168QLgL2RQpAOoJmckQCnKRTjGcQxZ-_wKQeCptQkE';
const NOMBRE_HOJA_RESPUESTAS = 'Apartados Haruja V2 (Respuestas)';
const HEADER_ROW             = 4; // Encabezados en fila 4 (datos desde 5)

const ID_MASTER              = '1S9mZbcQehmyiwaebh0GKlQQF7HDWLTdvJZFkV-vY_ZA';
const NOMBRE_HOJA_MASTER     = 'Master'; // B..I (B=Codigo, F=Descripcion, I=Precio con IVA)

const ID_CARPETA_PDFS        = '12yvsXrxUYnfr2o0eMx1uBUllkr7to8RK'; // carpeta destino PDF
const LOGO_DRIVE_ID          = '1W41S0HLLQcWBhFuoOTyRCKBQXWBHMenv'; // logo en Drive
const PREFIJO_APARTADO       = 'HARUJA24'; // p.ej. HARUJA24041

/*************************************************
 * ================= UTILIDADES =================
 *************************************************/
function ui(){ return SpreadsheetApp.getUi(); }

function onOpen(){
  ui().createMenu('Apartados Haruja')
     .addItem('Generar Ticket (manual)', 'generarTicketDesdeHoja')
     .addToUi();
}

function norm(s){
  return String(s || '').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}
function cleanCode(s){
  return String(s || '')
    .replace(/\u00A0/g,' ')
    .replace(/\//g,'-')   // unifica slash en guion
    .trim();
}

function toNum(x){
  const n = Number(String(x ?? 0).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function $mx(n){
  return '$' + toNum(n).toLocaleString('es-MX',{minimumFractionDigits:2, maximumFractionDigits:2});
}

function parseListaCodigos(texto){
  if (!texto) return [];
  return String(texto)
           .split(',')
           .map(s => s.trim())
           .filter(Boolean);
}

function parseFechaFlexible_(s){
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // ISO
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/*************************************************
 * ========= DESCUENTO (PCT o AMT) ===============
 * - descuentoTipo: "PCT" | "AMT"
 * - descuentoValor: número (10 => 10%, 150 => $150)
 *************************************************/
function normalizeDescTipo_(t){
  t = String(t || '').trim().toUpperCase();
  if (t === 'AMT' || t === '$' || t === 'MONTO' || t === 'IMPORTE') return 'AMT';
  return 'PCT';
}

function calcularDescuento_(subtotal, descuentoTipo, descuentoValor){
  subtotal = toNum(subtotal);
  descuentoTipo  = normalizeDescTipo_(descuentoTipo);
  descuentoValor = toNum(descuentoValor);

  if (subtotal <= 0 || descuentoValor <= 0){
    return { tipo: descuentoTipo, valor: descuentoValor, monto: 0, label: '0' };
  }

  let monto = 0;
  if (descuentoTipo === 'AMT'){
    monto = descuentoValor;
  } else {
    monto = subtotal * (descuentoValor / 100);
  }

  // límites para evitar negativos
  if (monto < 0) monto = 0;
  if (monto > subtotal) monto = subtotal;

  const label = (descuentoTipo === 'AMT')
    ? ('$' + descuentoValor.toFixed(2))
    : (String(Math.round(descuentoValor * 100) / 100).replace(/\.00$/,'') + '%');

  return { tipo: descuentoTipo, valor: descuentoValor, monto: monto, label: label };
}

/*************************************************
 * =========== ACCESO A LAS HOJAS ===============
 *************************************************/
function getHojaRespuestas(){
  const ss = SpreadsheetApp.openById(ID_BASE_APARTADOS);
  const sh = ss.getSheetByName(NOMBRE_HOJA_RESPUESTAS);
  if (!sh) throw new Error('No existe la hoja "'+NOMBRE_HOJA_RESPUESTAS+'".');
  return sh;
}

function leerEncabezados(sh){
  return sh.getRange(HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v).trim());
}

function idx(headers, nombre, alternativos){
  const targets = [nombre].concat(alternativos || []).map(norm);
  for (let i=0;i<headers.length;i++){
    if (targets.indexOf(norm(headers[i])) !== -1) return i;
  }
  throw new Error('No se encontró la columna "'+nombre+'". Encabezados: ' + headers.join(' | '));
}

// idx opcional (NO truena si no existe)
function idxOpt(headers, nombre, alternativos){
  try{
    return idx(headers, nombre, alternativos);
  }catch(e){
    return -1;
  }
}

/*************************************************
 * ================ MASTER MAP ==================
 * Lee precio por encabezado; fallback a columna I
 * y calcula desde Precio + IVA si “Precio con IVA” está vacío.
 *************************************************/
function getMapaMaster(){
  const ss = SpreadsheetApp.openById(ID_MASTER);
  const sh = ss.getSheetByName(NOMBRE_HOJA_MASTER);
  if (!sh) throw new Error('No existe la hoja Master.');

  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return new Map();

  // Detectar fila de encabezados
  let headerRow = 1;
  for (let r = 1; r <= Math.min(8, lastRow); r++){
    const row = sh.getRange(r, 1, 1, lastCol).getDisplayValues()[0].map(v => String(v).trim().toLowerCase());
    if (row.some(v => v === 'código' || v === 'codigo' || v === 'sku')) { headerRow = r; break; }
  }

  const headers = sh.getRange(headerRow, 1, 1, lastCol).getDisplayValues()[0];
  const _norm = s => String(s||'').trim().toLowerCase();
  const findCol = (alts) => {
    const targets = alts.map(_norm);
    for (let c = 0; c < headers.length; c++){
      if (targets.includes(_norm(headers[c]))) return c+1; // 1-based
    }
    return -1;
  };

  // Columnas
  const colCodigo   = findCol(['código','codigo','sku','code']);
  const colDesc     = findCol(['descripción','descripcion','detalle','nombre']);
  let   colPrecioCI = findCol(['precio con iva','precio (iva)','precio c/iva','p. con iva','pvp','precio final','precio sugerido con iva','sugerido con iva','precio con iva ']);
  const colPrecio   = findCol(['precio','precio base','precio sin iva','price']);
  const colIVA      = findCol(['iva (16%)','iva','impuesto']);
  if (colPrecioCI === -1) colPrecioCI = 9; // fallback I

  if (colCodigo === -1) throw new Error('No se encontró columna "Código" en Master.');
  if (colDesc   === -1) throw new Error('No se encontró columna "Descripción" en Master.');

  const data = sh.getRange(headerRow+1, 1, lastRow-headerRow, lastCol).getDisplayValues();
  const map = new Map();

  const toNumDisplay = x => {
    const s = String(x ?? '').trim();
    if (!s) return 0;
    const t = s.replace(/[^\d,.-]/g,'').replace(/(\d)[,](\d{1,2})$/, '$1.$2').replace(/[,]/g,'');
    const n = Number(t);
    return isNaN(n) ? 0 : n;
  };
  const clean = s => String(s || '').replace(/\u00A0/g,' ').replace(/\//g,'-').trim();

  for (let i = 0; i < data.length; i++){
    const row = data[i];
    const codigo = clean(row[colCodigo-1]);
    if (!codigo) continue;

    // 1) Intentar Precio con IVA
    let precioFinal = toNumDisplay(row[colPrecioCI-1]);

    // 2) Si viene vacío/0: intentar G + H o G*1.16
    if (!precioFinal || precioFinal <= 0){
      const pBase = (colPrecio > 0) ? toNumDisplay(row[colPrecio-1]) : 0;
      const pIVA  = (colIVA   > 0) ? toNumDisplay(row[colIVA-1])   : 0;
      if (pBase && pIVA) precioFinal = pBase + pIVA;
      else if (pBase)    precioFinal = Math.round(pBase * 1.16 * 100) / 100;
      else precioFinal = 0;
    }

    // Manejo de duplicados: conservar el mejor precio (>0)
    const prev = map.get(codigo);
    if (!prev) {
      map.set(codigo, { codigo, descripcion: row[colDesc-1] || '', precio: precioFinal });
    } else {
      const prevNum = Number(prev.precio) || 0;
      const newNum  = Number(precioFinal) || 0;
      if ((newNum > 0 && prevNum <= 0) || (newNum > prevNum)) {
        map.set(codigo, { codigo, descripcion: row[colDesc-1] || prev.descripcion, precio: newNum });
      }
    }
  }
  return map;
}

/*************************************************
 * =============== FOLIO CONSECUTIVO =============
 *************************************************/
function siguienteFolio_(){
  const sh = getHojaRespuestas();
  const headers = leerEncabezados(sh);
  const cFolio = idx(headers, 'N° de apartado', ['No. de apartado','Número de apartado','Numero de apartado','Folio']);

  const startRow = HEADER_ROW + 1;
  const numRows  = Math.max(0, sh.getLastRow() - HEADER_ROW);
  if (numRows === 0) return PREFIJO_APARTADO + '001';

  const vals = sh.getRange(startRow, cFolio+1, numRows, 1).getValues();
  let maxN = 0;
  vals.forEach(a => {
    const v = String(a[0] || '');
    const m = v.match(/^HARUJA24\s*-?\s*(\d+)$/i);
    if (m) {
      const n = parseInt(m[1],10);
      if (n > maxN) maxN = n;
    }
  });
  return PREFIJO_APARTADO + String(maxN+1).padStart(3,'0');
}

// Exponer para el frontend:
function getNextFolioWeb(){ return siguienteFolio_(); }

/*************************************************
 * ====== LECTURA/EDICIÓN POR FOLIO EN HOJA ======
 *************************************************/
function _buscarFilaPorFolio_(folio){
  const sh = getHojaRespuestas();
  const headers = leerEncabezados(sh);
  const startRow = HEADER_ROW + 1;
  const numRows  = Math.max(0, sh.getLastRow() - HEADER_ROW);
  if (!numRows) return { rowIndex: -1 };

  const cFolio       = idx(headers, 'N° de apartado', ['No. de apartado','Número de apartado','Numero de apartado','Folio']);
  const data         = sh.getRange(startRow, 1, numRows, sh.getLastColumn()).getValues();

  for (let i=0;i<data.length;i++){
    if (String(data[i][cFolio]).trim().toUpperCase() === String(folio).trim().toUpperCase()){
      return { rowIndex: startRow + i, headers, rowValues: data[i] };
    }
  }
  return { rowIndex: -1 };
}

/*************************************************
 * ============ GENERAR TICKET (HTML) ============
 *************************************************/
function getLogoDataUrl(){
  const blob = DriveApp.getFileById(LOGO_DRIVE_ID).getBlob();
  const b64  = Utilities.base64Encode(blob.getBytes());
  const mt   = blob.getContentType() || 'image/png';
  return 'data:'+mt+';base64,'+b64;
}

function renderTicketHtml(ctx){
  const {
    folio, fecha, cliente, contacto, filas,
    subtotal, anticipo,
    descTipo, descValor, descLabel, descVal,
    total
  } = ctx;

  const fechaTxt = (fecha instanceof Date)
    ? Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'd/M/yyyy')
    : (fecha || '');

  const verde  = '#A7B59E';
  const marron = '#383234';
  const beige  = '#FAF6F1';

  const filasHtml = filas.map((f)=>(
    '<tr>' +
      '<td>' + (f.codigo||'') + '</td>' +
      '<td>' + String(f.descripcion||'').replace(/</g,'&lt;') + '</td>' +
      '<td class="right">'+ $mx(f.precio) + '</td>' +
      '<td class="right">'+ f.cantidad + '</td>' +
      '<td class="right">'+ $mx(f.subtotal) + '</td>' +
    '</tr>'
  )).join('');

  const etiquetaDesc = descLabel || ((normalizeDescTipo_(descTipo)==='AMT') ? ('$' + toNum(descValor).toFixed(2)) : (toNum(descValor) + '%'));

  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Ticket '+folio+'</title>' +
    '<style>*{box-sizing:border-box} body{font-family:Arial,sans-serif;color:'+marron+';margin:24px}' +
    '.head{position:relative;border-bottom:2px solid '+verde+';padding:0 0 8px 0;margin:0 0 14px 0}' +
    '.title{font-size:18px;font-weight:bold}.badge{background:'+verde+';color:#fff;padding:4px 8px;border-radius:6px;font-weight:bold}' +
    '.logo{position:absolute;top:0;right:0;max-height:60px}' +
    'table{width:100%;border-collapse:collapse;margin-top:10px} th,td{border-bottom:1px solid #e7e7e7;padding:8px;font-size:12.5px;text-align:left;vertical-align:top}' +
    'th{background:'+beige+';font-weight:bold}.right{text-align:right}.totals{width:100%;margin-top:14px}.totals td{padding:6px 8px}.totals .lbl{text-align:right}.totals .val{text-align:right;width:120px}' +
    '.notes{margin-top:18px;font-size:11.5px;line-height:1.45}' +
    '</style></head><body>' +
    '<div class="head">' +
      '<img src="'+ getLogoDataUrl() +'" class="logo">' +
      '<div style="padding-right:120px">' +
        '<div class="title">Pedido <span class="badge">'+folio+'</span></div>' +
        '<div style="color:#555">Fecha '+fechaTxt+'</div>' +
        '<div style="color:#555;margin-top:6px">' +
          '<div><b>Nombre del cliente</b>: '+(cliente||'')+'</div>' +
          '<div><b>N° de contacto</b>: '+(contacto||'')+'</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="title" style="font-size:16px">Detalles del pedido</div>' +
    '<table><thead><tr>' +
      '<th style="width:18%">Código</th>' +
      '<th style="width:52%">Descripción</th>' +
      '<th class="right" style="width:10%">Precio</th>' +
      '<th class="right" style="width:7%">Cant.</th>' +
      '<th class="right" style="width:13%">Subtotal</th>' +
    '</tr></thead><tbody>'+ filasHtml +'</tbody></table>' +

    '<table class="totals">' +
      '<tr><td class="lbl" colspan="4"><b>Subtotal</b></td><td class="val">'+$mx(subtotal)+'</td></tr>' +
      '<tr><td class="lbl" colspan="4"><b>Anticipo</b></td><td class="val">'+$mx(anticipo)+'</td></tr>' +
      '<tr><td class="lbl" colspan="4"><b>Descuento ('+String(etiquetaDesc).replace(/</g,'&lt;')+')</b></td><td class="val">-'+$mx(descVal)+'</td></tr>' +
      '<tr><td class="lbl" colspan="4"><b>Total de Cuenta</b></td><td class="val"><b>'+$mx(total)+'</b></td></tr>' +
    '</table>' +

    '<div class="notes">Gracias por tu compra en HarujaGdl<br>Todos nuestros productos pasan por inspección para garantizar calidad, talla solicitada y que estén libres de defectos.<br><br><b>Cambios</b><br>Solicítalo dentro de 7 días naturales de recibir tu compra.<br><br>La prenda debe estar nueva, sin uso, sin lavar y con etiquetas originales.<br><br>No aplican cambios en: prendas tejidas, bordadas, con aplicaciones, accesorios, prendas de ropa íntima, trajes de baño, rebajas o compras con cupón.<br><br>Los gastos de envío corren por cuenta del cliente.<br><br>Solicita tu cambio por WhatsApp al 33 3033 6506 indicando motivo, prenda y talla deseada.<br><br><b>Apartados</b><br>Puedes apartar con 25% de anticipo.<br><br>Plazo máximo para recoger: 30 días.<br><br>Pasado ese tiempo, la prenda vuelve a venta y el anticipo queda como saldo a favor por 3 meses a partir de la fecha inicial del apartado.<br><br>No aplican cambios ni devoluciones en apartados.<br><br>No realizamos devoluciones de dinero. Todos los cambios son por producto de igual o mayor valor.<br><br>Gracias por elegirnos</div>' +
    '</body></html>'
  );
}

function guardarPdfDesdeHtml(html, nombreArchivo){
  const blobPdf = Utilities.newBlob(html, 'text/html', nombreArchivo + '.html')
                          .getAs('application/pdf')
                          .setName(nombreArchivo + '.pdf');
  const folder = DriveApp.getFolderById(ID_CARPETA_PDFS);
  const file = folder.createFile(blobPdf);
  return {fileId:file.getId(), fileUrl:file.getUrl()};
}

/*************************************************
 * ====== LECTURA DE UNA FILA POR FOLIO ==========
 * Soporta:
 * - "Descuento %" (legacy)
 * - Opcionales (si existen):
 *    - "Descuento tipo" ("PCT"/"AMT")
 *    - "Descuento valor" (10 o 150)
 *************************************************/
function getFilaApartado(folio){
  const sh = getHojaRespuestas();
  const headers = leerEncabezados(sh);
  const startRow = HEADER_ROW + 1;
  const numRows  = Math.max(0, sh.getLastRow() - HEADER_ROW);
  const data = numRows ? sh.getRange(startRow, 1, numRows, sh.getLastColumn()).getValues() : [];

  const cFolio     = idx(headers, 'N° de apartado', ['No. de apartado','Número de apartado','Numero de apartado','Folio']);
  const cFecha     = idx(headers, 'Fecha');
  const cCliente   = idx(headers, 'Nombre del cliente', ['Cliente','Nombre']);
  const cContacto  = idx(headers, 'N° de contacto', ['No. de contacto','Numero de contacto','Contacto','Teléfono','Telefono']);
  const cCodigos   = idx(headers, 'Código(s) de prenda(s)', ['Códigos','Codigos','Código','Codigo']);
  const cAnticipo  = idx(headers, 'Monto depositado', ['Anticipo','Monto Anticipado']);

  // Legacy / actual
  const cDescPct   = idxOpt(headers, 'Descuento %', ['Descuento','Descuento%']);

  // Opcionales nuevos (si existen en hoja)
  const cDescTipo  = idxOpt(headers, 'Descuento tipo', ['Tipo descuento','Descuento (tipo)','DescuentoTipo']);
  const cDescValor = idxOpt(headers, 'Descuento valor', ['Valor descuento','Descuento (valor)','DescuentoValor']);

  const cLinkPdf   = idx(headers, 'Incluir screen del ticket digital o impreso', ['Link Ticket','Ticket']);

  let row = null, foundIndex = -1;
  for (let i=0;i<data.length;i++){
    if (String(data[i][cFolio]).trim().toUpperCase() === String(folio).trim().toUpperCase()){
      row = data[i]; foundIndex = i; break;
    }
  }
  if (!row) throw new Error('No se encontró el apartado "'+folio+'".');

  const rowIndex = startRow + foundIndex;
  const linkCell = sh.getRange(rowIndex, cLinkPdf + 1);

  // Resolver descuento guardado
  let descTipo = 'PCT';
  let descValor = 0;

  if (cDescTipo >= 0 && cDescValor >= 0){
    descTipo  = normalizeDescTipo_(row[cDescTipo]);
    descValor = toNum(row[cDescValor]);
  } else {
    // Legacy: solo %
    descTipo  = 'PCT';
    descValor = (cDescPct >= 0) ? toNum(row[cDescPct]) : 0;
  }

  return {
    fecha: row[cFecha],
    cliente: row[cCliente],
    contacto: row[cContacto],
    listaCodigos: parseListaCodigos(row[cCodigos]),
    anticipo: toNum(row[cAnticipo]),
    descTipo,
    descValor,
    linkCell
  };
}

/*************************************************
 * ========== REGISTRO (desde la WEB) ============
 * - Si usarFolioExistente=true y folio existe: suma anticipo y recalcula total en la MISMA fila.
 * - Si no: crea un apartado nuevo, autogenerando folio.
 *
 * Soporta descuento:
 * - payload.descuentoTipo ("PCT"|"AMT")
 * - payload.descuentoValor (10 o 150)
 * - legacy payload.descuentoPct
 *************************************************/
function registrarApartadoDesdeWeb(payload){
  try {
    payload = payload || {};
    const sh = getHojaRespuestas();
    const headers = leerEncabezados(sh);

    // columnas
    let cMarcaTemporal = -1; // opcional
    try { cMarcaTemporal = idx(headers, 'Marca temporal', ['Timestamp']); } catch(_){}

    const cFecha       = idx(headers, 'Fecha');
    const cCliente     = idx(headers, 'Nombre del cliente', ['Cliente','Nombre']);
    const cContacto    = idx(headers, 'N° de contacto', ['No. de contacto','Numero de contacto','Contacto','Teléfono','Telefono']);
    const cCodigos     = idx(headers, 'Código(s) de prenda(s)', ['Códigos','Codigos','Código','Codigo']);

    // Legacy
    const cDescPct     = idxOpt(headers, 'Descuento %', ['Descuento','Descuento%']);

    // Nuevas opcionales (si existen)
    const cDescTipo    = idxOpt(headers, 'Descuento tipo', ['Tipo descuento','Descuento (tipo)','DescuentoTipo']);
    const cDescValor   = idxOpt(headers, 'Descuento valor', ['Valor descuento','Descuento (valor)','DescuentoValor']);

    const cAnticipo    = idx(headers, 'Monto depositado', ['Anticipo','Monto Anticipado']);
    const cTotalTicket = idx(headers, 'Total ticket', ['Total del ticket','Total']);
    const cTotalCuenta = idx(headers, 'Total de Cuenta', ['Total de cuenta']);
    const cLinkPdf     = idx(headers, 'Incluir screen del ticket digital o impreso', ['Link Ticket','Ticket']);
    const cFolio       = idx(headers, 'N° de apartado', ['No. de apartado','Número de apartado','Numero de apartado','Folio']);

    const now       = new Date();
    const fecha     = parseFechaFlexible_(payload.fecha) || now;
    const fechaTxt  = Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'd/M/yyyy');
    const cliente   = String(payload.cliente || '');
    const contacto  = String(payload.contacto || '');
    const codList   = parseListaCodigos(payload.codigos);
    const codigos   = codList.join(', ');
    const anticipoN = toNum(payload.anticipo);

    // descuento desde payload (nuevo o legacy)
    let descTipoPayload  = normalizeDescTipo_(payload.descuentoTipo);
    let descValorPayload = (payload.descuentoValor !== undefined && payload.descuentoValor !== null)
      ? toNum(payload.descuentoValor)
      : toNum(payload.descuentoPct);

    const generar   = (payload.generarTicket === false) ? false : true;
    const usarExist = !!payload.usarFolioExistente;
    const folioIn   = String(payload.folio || '').trim();

    // ====== ABONO A FOLIO EXISTENTE ======
    if (usarExist) {
      if (!folioIn) return { ok:false, error:'Ingresa el folio para aplicar el abono.' };
      if (anticipoN <= 0) return { ok:false, error:'Para un abono debes capturar un monto de anticipo > 0.' };

      const { rowIndex } = _buscarFilaPorFolio_(folioIn);
      if (rowIndex === -1) return { ok:false, error:'No encontré el folio "'+folioIn+'". Verifica y vuelve a intentar.' };

      // leer valores actuales
      const rowVals = sh.getRange(rowIndex, 1, 1, sh.getLastColumn()).getValues()[0];

      const subtotal    = toNum(rowVals[cTotalTicket]);
      const anticipoOld = toNum(rowVals[cAnticipo]);
      const anticipoNew = anticipoOld + anticipoN;

      // descuento guardado (respeta original)
      let descTipoSaved = 'PCT';
      let descValorSaved = 0;

      if (cDescTipo >= 0 && cDescValor >= 0){
        descTipoSaved  = normalizeDescTipo_(rowVals[cDescTipo]);
        descValorSaved = toNum(rowVals[cDescValor]);
      } else {
        // legacy %
        descTipoSaved  = 'PCT';
        descValorSaved = (cDescPct >= 0) ? toNum(rowVals[cDescPct]) : 0;
      }

      const d = calcularDescuento_(subtotal, descTipoSaved, descValorSaved);
      const totalCuenta = Math.max(0, subtotal - d.monto - anticipoNew);

      // actualizar fila existente (anticipo y total de cuenta)
      sh.getRange(rowIndex, cAnticipo+1).setValue(anticipoNew);
      sh.getRange(rowIndex, cTotalCuenta+1).setValue(totalCuenta);

      // intentar regenerar PDF
      let pdfUrl = '';
      try {
        if (generar){
          const r = generarTicketPorFolioSilencioso_(folioIn);
          if (r && r.fileUrl) pdfUrl = r.fileUrl;
        }
      } catch(e){ Logger.log('PDF abono error %s: %s', folioIn, e); }

      const resumen = {
        folio: folioIn,
        fecha: String(fechaTxt),
        cliente: rowVals[cCliente] || '',
        contacto: rowVals[cContacto] || '',
        subtotal: Number(subtotal) || 0,
        anticipo: Number(anticipoNew) || 0,
        descPct: (d.tipo === 'PCT') ? Number(d.valor) : 0,
        descVal: Number(d.monto) || 0,
        total: Number(totalCuenta) || 0,
        items: String(rowVals[cCodigos] || '').split(',').map(s=>s.trim()).filter(Boolean)
      };
      return { ok:true, folio: folioIn, pdfUrl: String(pdfUrl||''), resumen };
    }

    // ====== APARTADO NUEVO ======
    if (!codList.length){
      return { ok:false, error:'Debes ingresar al menos un código de prenda.' };
    }

    // Subtotal desde Master
    const master  = getMapaMaster();
    let subtotal  = 0;
    for (var i=0;i<codList.length;i++){
      const code = cleanCode(codList[i]);
      const info = master.get(code);
      if (info) subtotal += toNum(info.precio);
    }

    const d = calcularDescuento_(subtotal, descTipoPayload, descValorPayload);
    const totalCuenta  = Math.max(0, subtotal - d.monto - anticipoN);

    const folio = siguienteFolio_();

    // armar fila para la hoja
    const row = new Array(headers.length).fill('');
    if (cMarcaTemporal >= 0) row[cMarcaTemporal] = now;
    row[cFecha]       = fecha;
    row[cCliente]     = cliente;
    row[cContacto]    = contacto;
    row[cCodigos]     = codigos;

    // Guardado descuento:
    // - Si existen columnas nuevas: guardamos tipo/valor
    // - Si no existen: guardamos legacy % en "Descuento %" (si es AMT guardamos 0)
    if (cDescTipo >= 0 && cDescValor >= 0){
      row[cDescTipo]  = d.tipo;
      row[cDescValor] = d.valor;
    }
    if (cDescPct >= 0){
      row[cDescPct] = (d.tipo === 'PCT') ? d.valor : 0;
    }

    row[cAnticipo]    = anticipoN;
    row[cTotalTicket] = subtotal;
    row[cTotalCuenta] = totalCuenta;
    row[cFolio]       = folio;

    let nextRow = sh.getLastRow() + 1;
    if (nextRow < HEADER_ROW + 1) nextRow = HEADER_ROW + 1;
    sh.getRange(nextRow, 1, 1, row.length).setValues([row]);

    // Intento de PDF (no rompe si falla)
    let pdfUrl = '';
    try {
      if (generar){
        const r = generarTicketPorFolioSilencioso_(folio);
        if (r && r.fileUrl) {
          pdfUrl = String(r.fileUrl);
          sh.getRange(nextRow, cLinkPdf + 1).setValue(pdfUrl);
        }
      }
    } catch(e){
      Logger.log('Error generando PDF para %s: %s', folio, e);
    }

    const resumen = {
      folio: String(folio),
      fecha: String(fechaTxt),
      cliente: cliente,
      contacto: contacto,
      subtotal: Number(subtotal) || 0,
      anticipo: Number(anticipoN) || 0,
      descPct: (d.tipo === 'PCT') ? Number(d.valor) : 0,
      descVal: Number(d.monto) || 0,
      total: Number(totalCuenta) || 0,
      items: codList.slice(0)
    };

    return { ok: true, folio: String(folio), pdfUrl: String(pdfUrl || ''), resumen: resumen };

  } catch(err){
    const msg = (err && err.message) ? err.message : String(err);
    return { ok:false, error: msg };
  }
}

/*************************************************
 * ========== TICKET SILENCIOSO POR FOLIO ========
 *************************************************/
function generarTicketPorFolioSilencioso_(folio){
  const info = getFilaApartado(folio);
  const master = getMapaMaster();
  const filas = [];
  let subtotal = 0;

  info.listaCodigos.forEach(code => {
    const key = cleanCode(code);
    const inf = master.get(key);
    if (!inf){
      filas.push({codigo:code, descripcion:'NO ENCONTRADO EN MASTER', precio:0, cantidad:1, subtotal:0});
    } else {
      const precio = toNum(inf.precio);
      subtotal += precio;
      filas.push({codigo: inf.codigo, descripcion: inf.descripcion || '', precio, cantidad:1, subtotal:precio});
    }
  });

  const d = calcularDescuento_(subtotal, info.descTipo, info.descValor);
  const total   = Math.max(0, subtotal - d.monto - toNum(info.anticipo));

  const html = renderTicketHtml({
    folio,
    fecha: info.fecha,
    cliente: info.cliente,
    contacto: info.contacto,
    filas,
    subtotal,
    anticipo: toNum(info.anticipo),
    descTipo: d.tipo,
    descValor: d.valor,
    descLabel: d.label,
    descVal: d.monto,
    total
  });

  const res = guardarPdfDesdeHtml(html, 'Ticket_'+folio);
  if (info.linkCell) info.linkCell.setValue(res.fileUrl);

  return { fileUrl: res.fileUrl };
}

/*************************************************
 * ============ BOTÓN: MANUAL EN HOJA ============
 *************************************************/
function generarTicketDesdeHoja(){
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Generar por N° de apartado', 'Ingresa el N° de apartado (p.ej. HARUJA24041):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const folio = String(resp.getResponseText() || '').trim();
  if (!folio) return;

  try{
    const { fileUrl } = generarTicketPorFolioSilencioso_(folio);
    ui.alert('✅ Ticket generado.\n' + (fileUrl || ''));
  }catch(e){
    ui.alert('❌ '+ (e && e.message ? e.message : e));
  }
}

/*************************************************
 * ============== APP WEB (Front) ===============
 *************************************************/
function doGet(){
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Registrar Apartado - HarujaGDL')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/*************************************************
 * ============= DIAGNÓSTICO RÁPIDO =============
 *************************************************/
function debugPrecioMaster(codigo){
  const m = getMapaMaster();
  const info = m.get(cleanCode(codigo));
  if (!info) {
    Logger.log('Código no encontrado en Master: %s', codigo);
    return;
  }
  Logger.log('Código: %s | Desc: %s | Precio detectado: %s', info.codigo, info.descripcion, info.precio);
}

function debugMapaMasterResumen(){
  const ss = SpreadsheetApp.openById(ID_MASTER);
  const sh = ss.getSheetByName(NOMBRE_HOJA_MASTER);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();

  // Intentar detectar encabezados igual que getMapaMaster
  let headerRow = 1;
  for (let r = 1; r <= Math.min(8, lastRow); r++){
    const row = sh.getRange(r, 1, 1, lastCol).getDisplayValues()[0].map(v => String(v).trim().toLowerCase());
    if (row.some(v => v === 'código' || v === 'codigo' || v === 'sku')) { headerRow = r; break; }
  }
  const headers = sh.getRange(headerRow, 1, 1, lastCol).getDisplayValues()[0];

  Logger.log('--- RESUMEN MASTER ---');
  Logger.log('Fila de encabezados detectada: %s', headerRow);
  Logger.log('Encabezados: %s', JSON.stringify(headers));

  const mapa = getMapaMaster();
  Logger.log('Total de códigos cargados: %s', mapa.size);

  // Muestra los primeros 10 elementos
  let i = 0;
  for (const [k,v] of mapa.entries()){
    Logger.log('%s) Código: %s | Precio: %s | Desc: %s', ++i, k, v.precio, (v.descripcion||'').slice(0,50));
    if (i >= 10) break;
  }
}

function debugBuscarCodigoAproximado(fragmento){
  const frag = String(fragmento||'').toLowerCase().trim();
  if (!frag){ Logger.log('Fragmento vacío.'); return; }
  const mapa = getMapaMaster();
  let hits = 0;
  for (const [k,v] of mapa.entries()){
    if (k.toLowerCase().indexOf(frag) !== -1){
      Logger.log('MATCH -> Código: %s | Precio: %s | Desc: %s', k, v.precio, (v.descripcion||'').slice(0,60));
      if (++hits >= 20) break; // máximo 20 coincidencias
    }
  }
  if (hits === 0) Logger.log('Sin coincidencias para: %s', frag);
}
function testDebug(){
  debugPrecioMaster('HA4H002/NG-L');   // aquí pones el código exacto
}

// Muestra exactamente qué hay en las columnas G,H,I de la fila del código
function debugCeldasMaster(codigo){
  const ss = SpreadsheetApp.openById(ID_MASTER);
  const sh = ss.getSheetByName(NOMBRE_HOJA_MASTER);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();

  // detectar encabezados (misma lógica que el mapa)
  let headerRow = 1;
  for (let r = 1; r <= Math.min(8,lastRow); r++){
    const row = sh.getRange(r,1,1,lastCol).getDisplayValues()[0].map(v=>String(v).trim().toLowerCase());
    if (row.some(v=>v==='código'||v==='codigo'||v==='sku')) { headerRow=r; break; }
  }
  const headers = sh.getRange(headerRow,1,1,lastCol).getDisplayValues()[0];
  const norm = s=>String(s||'').trim().toLowerCase();
  const findCol = names=>{
    const t = names.map(norm);
    for (let c=0;c<headers.length;c++){ if (t.includes(norm(headers[c]))) return c+1; }
    return -1;
  };

  const colCodigo   = findCol(['código','codigo','sku','code']);
  const colPrecio   = findCol(['precio','precio base','precio sin iva','price']); // G
  const colIVA      = findCol(['iva (16%)','iva','impuesto']);                    // H
  let   colPrecioCI = findCol(['precio con iva','precio (iva)','precio c/iva','p. con iva','pvp','precio final','precio sugerido con iva','sugerido con iva','precio con iva ']); // I
  if (colPrecioCI === -1) colPrecioCI = 9;

  if (colCodigo === -1) { Logger.log('No se encontró columna Código.'); return; }

  // buscar fila
  const data = sh.getRange(headerRow+1,1,lastRow-headerRow,lastCol).getDisplayValues();
  const clean = s => String(s||'').replace(/\u00A0/g,' ').trim();
  const target = clean(codigo).replace(/\//g,'-'); // igual que cleanCode()
  let found = -1, rowValues = null;
  for (let i=0;i<data.length;i++){
    const row = data[i];
    if (clean(row[colCodigo-1]).replace(/\//g,'-') === target){ found = i + headerRow + 1; rowValues = row; break; }
  }
  if (found === -1){ Logger.log('Código no encontrado en hoja Master: %s', codigo); return; }

  Logger.log('Fila %s | G(Precio)="%s" | H(IVA)="%s" | I(Precio con IVA)="%s"',
    found,
    colPrecio>0?rowValues[colPrecio-1]:'(no existe G)',
    colIVA>0?rowValues[colIVA-1]:'(no existe H)',
    rowValues[colPrecioCI-1]
  );
}