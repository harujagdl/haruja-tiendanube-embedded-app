# Plan técnico: Sincronización Tiendanube ↔ Firestore con inventario por código + ledger de ventas

## Objetivo
Implementar una integración robusta entre Tiendanube y Firestore para:
- instalar tiendas vía OAuth,
- procesar eventos de órdenes pagadas/canceladas desde webhooks,
- actualizar inventario por `SKU` (código Haruja),
- registrar un `sales_ledger` para comisiones,
- y garantizar consistencia con reconciliación periódica.

---

## Supuestos y convenciones
- `SKU` de Tiendanube corresponde al `codigo` Haruja en `inventory_codes/{codigo}`.
- El backend corre en Firebase Functions (Node.js) y Firestore.
- El token OAuth se guarda **solo** en backend (`tn_stores/{storeId}`), nunca en frontend.
- Se usará `APP_SECRET` para validar HMAC de webhooks con body raw.
- Se mantiene una sola fuente de verdad para descuentos de inventario en ventas TN: evento `order/paid`.

---

## Modelo de datos propuesto (Firestore)

### `tn_stores/{storeId}`
- `access_token` (string, sensible)
- `scopes` (array<string>)
- `installedAt` (timestamp)
- `lastSyncAt` (timestamp)
- `updatedAt` (timestamp)
- `status` (`active|revoked|error`)

### `webhook_events/{eventKey}`
- `eventKey` = `${storeId}_${topic}_${resourceId}`
- `storeId` (string)
- `topic` (string)
- `resourceId` (string)
- `receivedAt` (timestamp)
- `payloadHash` (string opcional)
- `status` (`received|processed|ignored|error`)
- `error` (string opcional)

### `tn_orders/{storeId}_{orderId}`
- `storeId`, `orderId`
- `snapshot` (objeto JSON de la orden TN)
- `fetchedAt` (timestamp)

### `sales_ledger/{storeId}_{orderId}`
- `storeId`, `orderId`
- `status` (`paid|cancelled|refunded|voided`)
- `seller` (`Haru|Atziri|SinAsignar|...`)
- `paidAt` (timestamp nullable)
- `totals` (subtotal, total, shipping, discount, currency)
- `lineItems` (array): `{ codigo, qty, price, title, variantId }`
- `source` (`tn_webhook|reconciliation|pos`)
- `createdAt`, `updatedAt`

### `inventory_codes/{codigo}`
- `stock` (number)
- `status` (`disponible|vendido|agotado`)
- `updatedAt`

### `inventory_movements/{movementId}`
- `storeId`, `orderId`, `codigo`
- `type` (`SALE|RETURN|ADJUSTMENT`)
- `qty` (number signed o absoluto + type)
- `beforeStock`, `afterStock` (opcional para auditoría)
- `reason` (`order/paid`, `order/cancelled`, etc.)
- `createdAt`

### `inventory_issues/{orderId}_{codigo}`
- `storeId`, `orderId`, `codigo`
- `issueType` (`MISSING_SKU|NEGATIVE_STOCK|...`)
- `qty`
- `detectedAt`
- `resolved` (bool)

---

## EPIC 0 — OAuth + credenciales (bloqueante)

### 0.1 Instalación OAuth
Implementar endpoints HTTPS:
1. `GET /auth/start?store_id=XXXX`
   - Validar `store_id`.
   - Construir URL authorize oficial de Tiendanube con `client_id`, `scope`, `response_type=code` y `redirect_uri`.
   - Redirigir (302).
2. `GET /auth/callback`
   - Recibir `code` + `store_id`.
   - Intercambiar `code` por `access_token` contra endpoint OAuth de Tiendanube.
   - Persistir en `tn_stores/{storeId}`: `access_token`, `scopes`, `installedAt`, `lastSyncAt=now`, `status=active`.
   - Responder página simple de instalación exitosa/error.

**Criterios de aceptación**
- `code` se usa una sola vez y se procesa dentro de su ventana de expiración.
- `access_token` no se filtra al frontend ni logs.

### 0.2 Secretos
- Configurar `APP_SECRET` en Secret Manager/env Functions.
- Guardar también `TN_CLIENT_ID` y `TN_CLIENT_SECRET` en secretos.
- Añadir validación de arranque: fallar explícitamente si falta secreto requerido.

---

## EPIC 1 — Webhook receiver

### 1.1 Endpoint
- `POST /webhooks/tiendanube`.
- Requiere acceso a `req.rawBody` para HMAC.

### 1.2 Validación HMAC
- Tomar header `x-linkedstore-hmac-sha256`.
- Calcular HMAC SHA256 con `APP_SECRET` y body raw.
- Comparación en tiempo constante.
- Si inválido: `401` y no procesar.

### 1.3 Idempotencia
- Construir `eventKey = ${storeId}_${topic}_${resourceId}`.
- Si `webhook_events/{eventKey}` existe: responder `200` (idempotente).
- Si no existe: crear con estado `received` y procesar.
- Al terminar: marcar `processed`/`ignored`/`error`.

---

## EPIC 2 — Pedidos pagados (`order/paid`)

### 2.1 Obtener orden completa
- Con `storeId` + `orderId`, consultar `GET /v1/{storeId}/orders/{orderId}`.
- Header: `Authentication: bearer ACCESS_TOKEN`.

### 2.2 Snapshot de orden
- Upsert `tn_orders/{storeId}_{orderId}` con payload completo + `fetchedAt`.

### 2.3 Resolver seller para comisiones
- Parsear `order.note` buscando patrón `SELLER=<valor>`.
- Normalizar valores conocidos (`Haru`, `Atziri`).
- Fallback: `SinAsignar`.

### 2.4 Crear/actualizar ledger
- Upsert `sales_ledger/{storeId}_{orderId}` con:
  - `status=paid`
  - `paidAt`
  - `totals`
  - `seller`
  - `lineItems[{codigo: sku, qty, price, ...}]`

### 2.5 Descuento de inventario por código
- En transacción Firestore por cada ítem:
  - leer `inventory_codes/{codigo}`
  - si no existe: crear `inventory_issues/{orderId}_{codigo}` y continuar
  - si existe: `stock = stock - qty`
  - si pieza única: marcar `status=vendido`; si stock 0: `agotado`.

### 2.6 Movimientos de inventario
- Insertar `inventory_movements` tipo `SALE` por cada línea aplicada.

**Criterios de aceptación**
- Reprocesar el mismo webhook no vuelve a descontar stock (idempotencia global).
- Toda venta pagada deja rastro auditable (snapshot + ledger + movement).

---

## EPIC 3 — Cancelaciones / refunds / voids

### Flujo
1. Cargar `sales_ledger/{storeId}_{orderId}`.
2. Si ya está en estado terminal coincidente, salir idempotente.
3. Revertir inventario en transacción (`stock += qty`, `status=disponible` cuando aplique).
4. Registrar `inventory_movements` tipo `RETURN`.
5. Actualizar ledger a `cancelled|refunded|voided` con `updatedAt`.

**Criterios de aceptación**
- No se duplica devolución si llega el mismo evento múltiples veces.
- Inventario y ledger quedan consistentes tras cancelación/reembolso.

---

## EPIC 4 — Reconciliación (cron cada 6h)

### Diseño
- Cloud Scheduler -> function `reconcileTiendanubeOrders`.
- Por cada `tn_stores` activo:
  1. leer `lastSyncAt`
  2. listar órdenes pagadas desde ese timestamp
  3. por cada orden sin ledger: ejecutar pipeline equivalente a EPIC 2
  4. actualizar `lastSyncAt` al corte exitoso

### Recomendaciones
- Paginar resultados de API TN.
- Guardar checkpoint intermedio por tienda para reintentos seguros.
- Métricas: órdenes escaneadas, creadas, omitidas, errores.

---

## EPIC 5 — Venta física sincronizada (POS -> Tiendanube)

### 5.1 UI administrativa
Formulario con:
- `seller`
- `items` por `codigo` (sku)
- método de pago
- descuento

### 5.2 Backend creación de order TN
- Endpoint autenticado interno `POST /pos/create-order`.
- Construir orden con line items (`sku=codigo`).
- En `note`: `SELLER=<seller>`.

### 5.3 Fuente única de verdad
- Tras crear order, **no** descontar inventario localmente.
- Esperar webhook `order/paid` para aplicar EPIC 2.

---

## Scopes recomendados
- Orders: lectura/escritura (obligatorio para leer y crear pedidos).
- Products/Variants (opcional) si se añade sincronización de catálogo.

---

## Orden de implementación sugerido (sprints)
1. **Sprint A**: EPIC 0 + EPIC 1 (OAuth + webhooks seguros + idempotencia).
2. **Sprint B**: EPIC 2 (paid pipeline completo + ledger + inventory movements).
3. **Sprint C**: EPIC 3 (returns/cancel/refund/void).
4. **Sprint D**: EPIC 4 (reconciliación + observabilidad).
5. **Sprint E**: EPIC 5 (venta física vía TN + UX admin).

---

## Checklist operativo
- [ ] Secretos cargados y versionados en entorno (no en repo).
- [ ] Endpoints OAuth desplegados y callback registrado en Tiendanube.
- [ ] Verificación HMAC probada con payload real.
- [ ] Idempotencia validada con replay de eventos.
- [ ] Pruebas de integración para `order/paid` y `order/cancelled`.
- [ ] Cron de reconciliación habilitado con dashboard de métricas.
- [ ] Runbook de incidencias (`inventory_issues`) definido para operación.
