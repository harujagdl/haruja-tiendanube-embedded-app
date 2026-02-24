# Plan de implementación — Sync Tiendanube + mejoras de tabla en panel

> Repo objetivo: `haruja-tiendanube-embedded-app-main`  
> Alcance: Backend (Cloud Functions + Firestore) y Frontend (`app/index.html`, `app/ventas.html`)

## 0) Base y supuestos

### 0.1 Hosting y autenticación
- Confirmar que el panel principal (`app/`) está desplegado en Firebase Hosting.
- Mantener login actual del panel.
- La sincronización Tiendanube debe ejecutarse **server-to-server** con token persistido en Firestore (sin depender de sesión del operador).

### 0.2 Archivos clave
- Front principal: `app/index.html`
- Front ventas: `app/ventas.html`
- Firebase init compartido: `app/shared/firebase-init.js`
- API backend: `functions/index.js`

---

## 1) Modelo de datos Firestore (variantes + órdenes)

### 1.1 Colecciones / documentos

#### `tiendanubeStores/{storeId}`
Campos mínimos:
- `accessToken`
- `userId`
- `installedAt`
- `updatedAt`
- `isActive` (recomendado para cron multi-tienda)

#### `tnProducts/{storeId}/products/{productId}`
Campos mínimos:
- `name`
- `handle`
- `published`
- `updatedAt`

#### `tnVariants/{storeId}/variants/{variantId}`
Campos mínimos:
- `productId`
- `sku`
- `attributes` (objeto crudo de atributos)
- `color` (top-level para filtros)
- `talla` (top-level para filtros)
- `stock` (number)
- `price` (string/number)
- `available` (`stock > 0`)
- `updatedAt`

#### `tnOrders/{storeId}/orders/{orderId}`
Campos mínimos:
- `status`
- `payment_status`
- `shipping_status`
- `created_at`
- `paid_at`
- `total`
- `customer`
- `items[]`
- `updatedAt`

### 1.2 Reglas de normalización
- `available = stock > 0`
- Atributos de variante relevantes también a top-level (ej. `color`, `talla`).
- Upsert por ID nativo de Tiendanube para evitar duplicados.

---

## 2) Sync automático de stock por variante

### 2.1 Backend: cliente Tiendanube
Agregar helpers en `functions/index.js`:
- `getTiendanubeClient(storeId)` → resuelve token, base URL y headers.
- `fetchProductsPaged(storeId, page)`
- `fetchVariantsPaged(storeId, page)` o fallback por producto si no hay endpoint global.
- utilidades de paginación + backoff exponencial ante 429/5xx.

### 2.2 Endpoint manual
Crear `POST /api/tiendanube/syncStock` con:
- body/query opcional: `storeId`, `limitPages`, `dryRun`
- comportamiento:
  - obtiene variantes
  - normaliza
  - upsert en `tnVariants/{storeId}/variants/{variantId}`
- respuesta:
  - `processed`, `created`, `updated`, `skipped`, `durationMs`

### 2.3 Programación automática (cron)
- Cloud Scheduler cada 30 min hacia endpoint HTTP.
- Si hay multi-tienda, iterar `tiendanubeStores` activos.
- Agregar protección contra ejecuciones concurrentes por tienda (lock temporal opcional).

### 2.4 Estrategia de consistencia
- Webhooks ayudan a inmediatez, pero el cron corrige desvíos por cambios manuales.
- SLA esperado de convergencia: ≤ 30 min.

---

## 3) Ventas y estados automáticos

### 3.1 Import inicial histórico
Crear `POST /api/tiendanube/importOrders?from=YYYY-MM-DD`:
- lectura paginada desde fecha
- upsert por `orderId`
- respuesta con métricas por lote

### 3.2 Webhook de órdenes
Crear `POST /api/tiendanube/webhook`:
- validación básica de autenticidad (secret/header si aplica)
- resolver `storeId` + `orderId`
- obtener detalle de orden vía API
- upsert en `tnOrders`
- opcional: mini-sync de variantes afectadas por items de la orden

### 3.3 Panel de ventas
En `app/ventas.html` o sección nueva:
- tabla órdenes con filtros (`status`, `payment_status`, fechas, canal)
- KPIs: día / semana / mes, pagadas, canceladas

---

## 4) Tabla tipo Excel en `app/index.html`

### 4.1 Resize de columnas (mouse + touch)
- Añadir `div.resizer` al borde derecho de cada `th`.
- Interacciones con Pointer Events:
  - `pointerdown`: guardar columna, `startX`, `startWidth`
  - `pointermove`: actualizar ancho en px
  - `pointerup`: persistir

### 4.2 Persistencia de anchos
- `loadColumnWidths()` al iniciar tabla.
- `saveColumnWidths()` en `pointerup`.
- clave sugerida: `tableColumnWidths_v1`.

### 4.3 Descripción completa sin romper layout
- estado base: clamp de 2 líneas
- desktop: tooltip en hover
- móvil/tablet: fila expandible con detalle completo

### 4.4 Responsividad
- desktop/tablet: header sticky + scroll horizontal
- móvil: modo card o tabla compacta + detalle expandible
- ocultar columnas secundarias en móvil y moverlas al detalle

### 4.5 UX/accesibilidad
- cursor `col-resize`
- handle táctil (10–14px min)
- desactivar selección de texto al arrastrar (`user-select: none`)

---

## 5) Vista de inventario Tiendanube

### 5.1 Nueva vista “Inventario Tiendanube”
Fuente: `tnVariants/{storeId}/variants` con:
- filtros por producto, color, talla, stock, `updatedAt`
- acción: “Sincronizar ahora” (llama `/syncStock`)

### 5.2 Indicadores
- Agotadas: `stock = 0`
- Bajas: `stock <= 2`
- OK: `stock >= 3`

---

## 6) Checklist de QA

- Sync manual persiste variantes con stock correcto.
- Cron actualiza por upsert sin duplicados.
- Resize de columnas funciona y persiste tras recarga.
- En móvil se puede ver descripción completa (expandible).
- Import histórico de órdenes funciona.
- Webhook actualiza estatus (pagada/cancelada) y se refleja en panel.

---

## 7) Despliegue

1. `firebase deploy --only functions,hosting`
2. Configurar Cloud Scheduler apuntando a la URL del endpoint HTTP.
3. Verificar logs de Functions en primera corrida (stock y órdenes).

---

## 8) Orden sugerido de implementación (iterativo)

1. Modelo Firestore + helpers Tiendanube.
2. `syncStock` manual estable.
3. Scheduler cada 30 min.
4. `importOrders` histórico.
5. Webhook órdenes en tiempo real.
6. Mejoras UX de tabla (`app/index.html`).
7. Vista de inventario y filtros.
8. Hardening final (errores, métricas, reintentos, observabilidad).
