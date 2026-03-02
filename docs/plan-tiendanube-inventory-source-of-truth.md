# Plan CODEx — Tiendanube como Source of Truth de Inventario (PDV) + Sync a Haruja DB

> Objetivo operativo: que **Tiendanube sea la única fuente de verdad de stock** (por PDV/admin) y Firestore actúe como réplica consultable para panel/admin/public.

## 0) Contexto y definición de éxito

- Colecciones Firestore actuales:
  - `HarujaPrendas_2025_admin` (editable, manda todo)
  - `HarujaPrendas_2025_public` (vista replicada desde admin)
- Regla confirmada:
  - `SKU` de Tiendanube == `codigo` en Firestore.
- Restricción de negocio:
  - Todo se vende por PDV Tiendanube, por lo que el stock real siempre debe venir de Tiendanube.

### Criterio de éxito
1. Carga inicial completa desde Tiendanube hacia `qtyAvailable` en admin.
2. Eventos de venta/reversa y cambios de producto actualizan stock en forma **idempotente**.
3. Reconciliación periódica corrige desvíos por eventos perdidos/duplicados/fuera de orden.

---

## 1) Modelo de datos canónico en `HarujaPrendas_2025_admin`

Estandarizar (o crear) estos campos por documento:

- `qtyAvailable: number | null`
  - `number`: stock sincronizado desde Tiendanube.
  - `null`: no definido / no sincronizado.
- `inventorySource: "tiendanube" | "undefined"`
  - `"tiendanube"` cuando el SKU existe en catálogo Tiendanube.
  - `"undefined"` cuando no existe SKU en Tiendanube.
- `status: "Disponible" | "Vendido" | "No definido"`
  - `qtyAvailable === null` => `No definido`
  - `qtyAvailable > 0` => `Disponible`
  - `qtyAvailable <= 0` => `Vendido`
- `disponibilidad: "Disponible" | "No disponible" | "No definido"`
  - `qtyAvailable === null` => `No definido`
  - `qtyAvailable > 0` => `Disponible`
  - `qtyAvailable <= 0` => `No disponible`

### Regla de cálculo (función única)
Crear helper central, reutilizable por script y webhooks:

```js
function deriveInventoryFields(qtyAvailable) {
  if (qtyAvailable === null || qtyAvailable === undefined) {
    return {
      qtyAvailable: null,
      inventorySource: 'undefined',
      status: 'No definido',
      disponibilidad: 'No definido',
    };
  }

  const qty = Number(qtyAvailable);
  return {
    qtyAvailable: qty,
    inventorySource: 'tiendanube',
    status: qty > 0 ? 'Disponible' : 'Vendido',
    disponibilidad: qty > 0 ? 'Disponible' : 'No disponible',
  };
}
```

> Nota: `public` debe seguir recibiendo estos campos desde la réplica admin→public sin cambiar la fuente.

---

## 2) Carga inicial — script masivo desde Tiendanube

Crear script:

- `scripts/sync-tiendanube-inventory.mjs`

### 2.1 Entradas y credenciales
- Resolver `store_id` y `access_token` desde:
  - documento de integración (ej. `tn_stores`), o
  - secreto/config de Functions si ya existe.
- Soportar flags CLI opcionales:
  - `--store=<id>`
  - `--dry-run`
  - `--limit=<n>` para pruebas.

### 2.2 Descarga de catálogo Tiendanube (SKU + stock)
1. Listar productos en paginación.
2. Para cada producto, obtener variantes (SKU + stock) con endpoint disponible.
3. Construir mapa en memoria:
   - `Map<string, number>` donde clave = `sku` normalizado (`trim`, mayúsculas).

### 2.3 Recorrido de Firestore admin
- Leer docs de `HarujaPrendas_2025_admin` por lotes.
- Para cada doc:
  1. Tomar `codigo` como SKU candidato.
  2. Si SKU existe en mapa Tiendanube:
     - `qtyAvailable = stock`
     - `inventorySource = "tiendanube"`
     - recalcular `status` + `disponibilidad`
  3. Si SKU no existe:
     - `qtyAvailable = null`
     - `inventorySource = "undefined"`
     - `status = "No definido"`
     - `disponibilidad = "No definido"`
- Escribir con `BulkWriter`/batch para performance e idempotencia.

### 2.4 Salida de auditoría
Imprimir y opcionalmente guardar JSON de resumen:

- total documentos admin procesados
- total SKUs encontrados en Tiendanube
- total no definidos
- top 50 no definidos (`docId`, `codigo`, `nombre`) para revisión

Resultado esperado: se elimina el default artificial de stock en `1` y queda stock real o no definido explícito.

---

## 3) Sincronización continua por webhooks

## 3.1 Mantener `order/paid` + `order/cancelled|voided`

Mantener los webhooks actuales con ajuste de estrategia:

- Mantener deduplicación por `eventId`/`orderId+event+timestamp`.
- Evitar depender únicamente de deltas ciegos cuando sea posible.
- Flujo recomendado:
  1. procesar evento de orden;
  2. al finalizar, refrescar stock real de SKUs afectados desde Tiendanube (SET final, no solo delta).

Esto protege contra duplicados, reintentos y orden no garantizado de notificaciones.

### 3.2 Agregar webhook `product/updated` (nuevo)

Registrar en Tiendanube el evento `product/updated`.

Handler propuesto:
1. Validar firma HMAC igual que en webhooks existentes.
2. Resolver `store_id` y `product_id` desde payload.
3. Hacer fetch del producto y sus variantes actuales.
4. Por cada variante con SKU:
   - buscar documento en admin por `codigo == sku`
   - hacer `set` directo de stock real (no delta):
     - `qtyAvailable = stock`
     - `inventorySource = "tiendanube"`
     - recalcular `status` + `disponibilidad`
5. Registrar métricas (`matched`, `updated`, `missingSkuInFirestore`).

Beneficio: cualquier ajuste manual en Tiendanube (PDV o admin) se replica casi en tiempo real.

---

## 4) Reconciliación programada (recomendada)

Agregar job programado (Cloud Scheduler + HTTP Function o Pub/Sub):

- frecuencia sugerida: cada 6h (o 1 vez/día mínimo)
- lógica: reusar `sync-tiendanube-inventory` en modo diff-only
  - solo actualiza docs cuyo stock/estado cambió

Cubre:
- eventos perdidos
- fallas transitorias de webhook
- cambios manuales no reflejados
- drift histórico por dedupe incompleto

---

## 5) Orden de implementación recomendado

1. **Helper canónico** `deriveInventoryFields` y tests unitarios.
2. **Script masivo inicial** `scripts/sync-tiendanube-inventory.mjs` con `--dry-run`.
3. **Ejecución en producción** de carga inicial + reporte de no definidos.
4. **Webhook `product/updated`** con HMAC + upsert por SKU.
5. **Refactor de `order/paid` y `cancelled/voided`** para cierre por SET real.
6. **Scheduler de reconciliación** y dashboard básico de métricas.

---

## 6) Checklist técnico de validación

- [ ] SKU normalizado igual entre Tiendanube y Firestore (`codigo`).
- [ ] `qtyAvailable` acepta `null` y nunca string en escrituras nuevas.
- [ ] `status` y `disponibilidad` siempre coherentes con `qtyAvailable`.
- [ ] Script masivo corre en `dry-run` y reporta conteos consistentes.
- [ ] Webhooks con HMAC inválido responden 401/403.
- [ ] Dedupe evita doble procesamiento de eventos repetidos.
- [ ] Reconciliación actualiza solo diffs y deja traza en logs.

---

## 7) Riesgos y mitigaciones

- **SKU inconsistentes (espacios/case):** normalizar ambos lados y loggear conflictos.
- **Rate limits Tiendanube:** paginación + backoff exponencial + retries acotados.
- **Eventos fuera de orden:** priorizar `SET` del stock real tras evento.
- **Documentos sin `codigo`:** clasificar como no definido y reportar para data cleanup.

---

## 8) Definición final de operación

- Fuente única de stock: **Tiendanube**.
- Firestore admin/public: **réplica materializada** para consulta y operación interna.
- Estado canónico por prenda:
  - definido por `qtyAvailable` sincronizado,
  - trazable por `inventorySource`,
  - corregible automáticamente por reconciliación.

---

## 9) Runbook operativo (solo SYNC, sin cambios de UI)

Este runbook aterriza la ejecución puntual para pasar de `No definido` a inventario real en `HarujaPrendas_2025_admin`.

### 9.1 Confirmar fuente de verdad

- SKU Tiendanube: `variants[].sku`
- SKU Firestore: `codigo`
- Stock Tiendanube: `variants[].stock`
- Colección destino: `HarujaPrendas_2025_admin`

### 9.2 Ejecutar DRY RUN (sin escritura)

```bash
cd scripts
npm i

FIREBASE_PROJECT_ID="haruja-tiendanube" \
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
node sync-tiendanube-inventory.mjs --storeId=TU_STORE_ID --dry
```

Validar en logs:

- `SKUs encontrados en Tiendanube`
- `Total sincronizados con Tiendanube`
- `Total NO definidos`

### 9.3 Ejecutar sincronización real

```bash
FIREBASE_PROJECT_ID="haruja-tiendanube" \
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
node sync-tiendanube-inventory.mjs --storeId=TU_STORE_ID
```

### 9.4 Validar en Firestore

En un documento de `HarujaPrendas_2025_admin`, confirmar:

- `qtyAvailable: <number|null>`
- `inventorySource: "tiendanube" | "undefined"`
- `statusCanon: "Disponible" | "Vendido" | "No definido"`
- `disponibilidadCanon: "Disponible" | "No disponible" | "No definido"`
- `lastInventorySyncAt: <timestamp>`

### 9.5 Validar en UI (solo lectura)

- Hacer recarga dura (`Ctrl+Shift+R`) en el panel.
- Verificar que “Existencias” muestra números en SKUs existentes en Tiendanube.
- Los que sigan en “No definido” corresponden a SKU ausente/no informado en Tiendanube.

### 9.6 Si el DRY RUN encuentra muy pocos SKUs

El script `sync-tiendanube-inventory.mjs` ya contempla modo robusto:

1. lista `/products` por páginas,
2. detecta productos sin `variants` en el listado,
3. hace `GET /products/{id}` por cada caso,
4. consolida `sku -> stock` desde el detalle.

Con eso se cubre el escenario donde el listado de productos no incluye variantes completas.
