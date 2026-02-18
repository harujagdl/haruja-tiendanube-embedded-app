/***** Menú FINAL – Apartados Haruja V2 (Respuestas)
 * Unifica todo en un solo menú "Integraciones Haruja".
 * No modifica tus funciones: solo las invoca con wrappers seguros.
 *****/

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Integraciones Haruja')
    .addItem('Generar eventos (+30d)', 'Haruja_generarEventosMas30d')           // wrapper
    .addItem('Borrar eventos (fila seleccionada)', 'Haruja_borrarEventosFila')  // wrapper
    .addSeparator()
    .addItem('Generar ticket desde hoja', 'Haruja_generarTicketDesdeHoja')      // wrapper
    .addItem('Generar eventos desde hoja', 'Haruja_generarEventosDesdeHoja')    // wrapper
    .addItem('Ticket + Eventos (todo en uno)', 'Haruja_ticketYEventos')         // wrapper
    .addSeparator()
    .addItem('Versión menú: 2025-10-27', 'Haruja_versionMenu')                   // diagnóstico
    .addToUi();
}

function onInstall() { onOpen(); }

/* ================= Wrappers ================ */

// Usa la función que exista en tu proyecto.
// Intentará en orden y si no encuentra ninguna, lanza error.
function Haruja_generarEventosMas30d() {
  runSafely_(
    () => callFirstAvailable_(['generarEventosMas30d', 'generarEventosDesdeHojaMas30d', 'generarEventosDesdeHoja']),
    '✅ Eventos (+30d) generados/actualizados',
    '❌ No fue posible generar eventos (+30d)'
  );
}

function Haruja_borrarEventosFila() {
  runSafely_(
    () => callFirstAvailable_(['borrarEventosFilaSeleccionada', 'eliminarEventosFilaSeleccionada']),
    '✅ Eventos borrados para la fila seleccionada',
    '❌ No fue posible borrar eventos para la fila seleccionada'
  );
}

function Haruja_generarTicketDesdeHoja() {
  runSafely_(
    () => callFirstAvailable_(['generarTicketDesdeHoja']),
    '✅ Ticket generado desde la hoja',
    '❌ Error al generar el ticket'
  );
}

function Haruja_generarEventosDesdeHoja() {
  runSafely_(
    () => callFirstAvailable_(['generarEventosDesdeHoja']),
    '✅ Eventos generados desde la hoja',
    '❌ Error al generar eventos desde la hoja'
  );
}

function Haruja_ticketYEventos() {
  runSafely_(
    () => {
      callFirstAvailable_(['generarTicketDesdeHoja']);
      callFirstAvailable_(['generarEventosDesdeHoja']);
    },
    '✅ Ticket y eventos generados',
    '❌ Error en Ticket + Eventos'
  );
}

/* ============== Utilidades comunes ============== */

function callFirstAvailable_(fnNames) {
  for (var i = 0; i < fnNames.length; i++) {
    var name = fnNames[i];
    var fn = this[name];
    if (typeof fn === 'function') {
      return fn(); // ejecuta y regresa
    }
  }
  throw new Error('No se encontró ninguna de estas funciones: ' + fnNames.join(', '));
}

function runSafely_(fn, okMsg, errMsg) {
  const ss = SpreadsheetApp.getActive();
  try {
    fn();
    ss.toast(okMsg, 'Haruja', 5);
  } catch (e) {
    ss.toast(errMsg + ': ' + e, 'Haruja', 8);
  }
}

// Ítem de diagnóstico para confirmar que este onOpen() es el que corre.
function Haruja_versionMenu() {
  SpreadsheetApp.getActive().toast('Menú activo: 2025-10-27', 'Haruja', 5);
}
