# Plan de implementación — Admin seguro (Haruja)

## Objetivo
Implementar un modo **Admin seguro** con acceso por correo allowlist (Google Sign-In), separación de datos públicos/sensibles en Firestore, y UI de edición con métricas financieras en vivo.

## Alcance funcional acordado
- Admin solo para:
  - `yair.tenorio.silva@gmail.com`
  - `harujagdl@gmail.com`
  - `harujagdl.ventas@gmail.com`
- Usuario no admin:
  - Puede usar la app normal.
  - No ve Admin.
  - No ve costo/campos sensibles.
  - No debe consultar colección admin.
- Admin:
  - Puede editar SKU: `descripcion`, `color`, `disponibilidad`, `status`, `precioConIva/pVenta`, `costo`.
  - Ve `Costo`, `Margen %`, `Utilidad`.
  - Recalcula en vivo con IVA 16% y objetivo 65%.

---

## Fase 1 — Auth (Google Sign-In)

### Tareas
1. En Firebase Console, habilitar `Authentication > Sign-in method > Google`.
2. En frontend, inicializar Auth (`getAuth`) e importar:
   - `GoogleAuthProvider`
   - `signInWithPopup`
   - `onAuthStateChanged`
   - `signOut`
3. Implementar `ALLOWLIST_EMAILS` en frontend con los 3 correos.
4. Botón **Ingresar Admin**:
   - Ejecuta `signInWithPopup(new GoogleAuthProvider())`.
5. `onAuthStateChanged`:
   - Obtiene `user.email`.
   - Calcula `isAdmin = allowlist.has(email)`.
   - Ajusta UI/permiso de modo admin.

### Criterios de aceptación
- Si no hay sesión o correo no allowlist => `isAdmin=false`.
- Si correo allowlist => `isAdmin=true`.

---

## Fase 2 — Split de colecciones (público vs sensible)

### Diseño de datos
1. `HarujaPrendas_2025_public`
   - `codigo` (también docId)
   - `descripcion`
   - `tipo`
   - `color`
   - `talla`
   - `proveedor`
   - `status`
   - `disponibilidad`
   - `fecha` / `fechaTexto`
   - `precioConIva` (`pVenta`)
2. `HarujaPrendas_2025_admin`
   - `codigo` (mismo docId)
   - `costo`
   - `updatedAt`
   - `updatedBy`

### Criterios de aceptación
- Mismo `docId` en ambas colecciones para merge 1:1.
- Campos sensibles solo en colección admin.

---

## Fase 3 — Migración (one-off)

### Tareas
1. Crear script de migración (Node Admin SDK) que:
   - Lea toda `HarujaPrendas_2025`.
   - Escriba colección `public` sin costo/campos sensibles.
   - Escriba colección `admin` solo con `costo`, `updatedAt`, `updatedBy`.
2. Ejecutar en ambiente controlado.
3. Validar conteos de documentos:
   - Original vs public vs admin.
4. Marcar `HarujaPrendas_2025` como backup temporal read-only (o plan de retiro).

### Criterios de aceptación
- App deja de depender de `HarujaPrendas_2025` original.
- Migración idempotente (puede re-ejecutarse sin dañar datos).

---

## Fase 4 — Firestore Rules (allowlist por email)

### Reglas esperadas
- `HarujaPrendas_2025_public`
  - `read`: permitido según necesidad de negocio.
  - `write`: solo admins allowlist.
- `HarujaPrendas_2025_admin`
  - `read/write`: solo admins allowlist.

### Criterios de aceptación
- Usuario no admin leyendo `..._admin` => `PERMISSION_DENIED`.
- Usuario admin allowlist => lectura/escritura permitida.

---

## Fase 5 — Carga de datos en frontend (merge)

### Tareas
1. Cargar base:
   - `baseRows = query(HarujaPrendas_2025_public)`
2. Si `isAdmin`:
   - Cargar `adminRows = query(HarujaPrendas_2025_admin)` por lotes/paginado.
   - Merge por `docId/codigo`.
3. Si `!isAdmin`:
   - Nunca ejecutar query a colección admin.

### Criterios de aceptación
- No admin: sin requests a `..._admin` en network.
- Admin: merge correcto de costo por SKU.

---

## Fase 6 — UI Admin (columnas + edición)

### Tareas
1. Tabla solo admin muestra:
   - `Costo`
   - `Utilidad`
   - `Margen %`
   - Botón `Editar` por fila.
2. Modal editar (solo admin) con campos:
   - `descripcion`, `color`, `disponibilidad`, `status`, `precioConIva/pVenta`, `costo`.
3. Cálculo en vivo:
   - `precioConIva = pVenta`
   - `precioSinIva = pVenta / 1.16`
   - `utilidad = precioSinIva - costo`
   - `margen% = (utilidad / precioSinIva) * 100`
   - `precioSugerido_65_conIva = (costo / (1 - 0.65)) * 1.16`
4. Guardar:
   - Update colección `public` con campos públicos editables.
   - Update colección `admin` con `costo`, `updatedAt`, `updatedBy`.

### Criterios de aceptación
- Recalculo responde al cambiar precio/costo en modal.
- Persistencia separada por colección.

---

## Fase 7 — Password extra (candado visual opcional)

### Tareas
1. Mantener password `Ahsoka.2803` solo como confirmación visual secundaria.
2. Mostrar campo password solo cuando `isAdmin=true`.
3. Solo si password correcto, habilitar botón `Editar`.

### Nota
Este candado **no reemplaza seguridad**: la seguridad real es Auth + Rules.

---

## Fase 8 — QA final

### Casos de prueba
1. Sin login:
   - Ve tabla normal, filtros, sin costos/admin.
2. Login con correo fuera allowlist:
   - No ve admin.
   - No puede leer colección admin.
3. Login con correo allowlist:
   - Ve admin.
   - Ve costo/margen/utilidad.
   - Edita y persiste.
4. Verificación técnica:
   - En DevTools/Network, usuario no admin no dispara requests a `HarujaPrendas_2025_admin`.

---

## Orden recomendado de ejecución (operativo)
1. Implementar y desplegar Auth/UI básica + split de lectura/escritura en frontend (feature flag temporal).
2. Crear y probar migración en staging/proyecto de prueba.
3. Ejecutar migración en producción.
4. Publicar Firestore Rules estrictas.
5. Activar UI admin completa (editar + métricas).
6. Ejecutar QA final con evidencias.

---

## Riesgos y mitigaciones
- **Riesgo:** romper lectura durante transición de colección.
  - **Mitigación:** fallback temporal de lectura (solo durante migración), desactivar tras validación.
- **Riesgo:** reglas bloquean admins por typo en email.
  - **Mitigación:** pruebas con 1 cuenta admin antes de publicar reglas definitivas.
- **Riesgo:** costos expuestos por queries legacy.
  - **Mitigación:** auditar código para remover todas las consultas a colección antigua.

---

## Definición de terminado (DoD)
- Reglas publicadas y verificadas contra usuario admin/no admin.
- Colección sensible inaccesible para no-admin.
- Frontend no-admin sin columnas ni requests sensibles.
- Modal admin funcionando con recalculo y persistencia separada.
- Evidencia de QA (capturas y resultados de pruebas).
