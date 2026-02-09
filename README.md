# Seed oficial: Counters desde JSON

Este flujo oficial procesa `Data/codigos_historicos.json` y actualiza `counters/{provX_tipoY}` con los campos `value` y `lastNumber`.

## Requisitos

- Node.js 18+
- Credenciales de servicio de Firebase (no subir al repo)
- Archivo JSON histórico en `Data/codigos_historicos.json`

## Variables de entorno

- `FIREBASE_PROJECT_ID` = ID del proyecto Firebase.
- `GCP_SA_KEY` = string JSON con las credenciales (secreto recomendado).

Opcional:

- `JSON_PATH` = ruta personalizada al JSON histórico.

## Ejecutar localmente

Dry run (solo resumen, no escribe en Firestore):

```bash
npm run seed:json:dry
```

Escritura real en Firestore:

```bash
npm run seed:json
```

> Nota: este es el único seed oficial. Evita ejecutar scripts antiguos (ver `scripts/_deprecated`) o en conflicto. Ejecuta este seed solo una vez para inicializar counters.

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Counters from JSON**.
2. Presiona **Run workflow**.
3. Ajusta `dryRun` o `jsonPath` si hace falta.
4. Verifica en Firestore la colección `counters`.

---

# Seed oficial: Prendas 2025 desde Excel

Este flujo oficial lee `Data/HarujaPrendas_2025.xlsx` y crea/actualiza documentos en la colección `HarujaPrendas_2025`. Cada fila genera un documento con `Código` como `docId`. El script soporta modo **dry-run** (solo resumen) y escritura real con batch writes.

## Requisitos

- Node.js 20+
- Credenciales de servicio de Firebase (no subir al repo)
- Archivo Excel en `Data/HarujaPrendas_2025.xlsx`

## Variables de entorno

- `FIREBASE_PROJECT_ID` = ID del proyecto Firebase.
- `GCP_SA_KEY` = string JSON con las credenciales.

Opcional:

- `EXCEL_PATH` = ruta personalizada al Excel.
- `DRY_RUN` = `true` o `false` para forzar dry-run.

## Ejecutar localmente

Dry run (recomendado primero):

```bash
npm run seed:prendas:dry
```

Escritura real en Firestore:

```bash
npm run seed:prendas
```

> Importante: ejecuta primero el dry-run para validar filas inválidas antes de escribir.
>
> Campos de fecha oficiales por prenda:
> - `fechaAlta` (timestamp real de alta desde Excel, columna M)
> - `fechaAltaTexto` (`dd/mm/yyyy`, recomendado para mostrar en UI)
> - `createdAt` (timestamp técnico de creación de documento, no se sobrescribe en updates)

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Prendas from Excel**.
2. Presiona **Run workflow**.
3. Mantén `dryRun=true` para validar el resumen primero.
4. Cuando el dry-run esté correcto, vuelve a ejecutar con `dryRun=false`.
5. Verifica en Firestore la colección `HarujaPrendas_2025`.

---

# Admin y Backfill del buscador (Cloud Functions)

La app incluye un modo admin que valida contraseña vía Cloud Functions y permite ejecutar un backfill de `searchTokens` para habilitar la búsqueda por descripción sin cargar toda la colección.

## Configurar contraseña admin (Functions config)

Configura la contraseña de admin desde tu máquina local:

```bash
firebase functions:config:set admin.password="TU_PASSWORD_ADMIN"
```

## Deploy de Functions

Desde la raíz del repo:

```bash
cd functions
npm install
npm run deploy
```

## Ejecutar el backfill desde la UI

1. Abre la sección **Base de datos códigos**.
2. Ingresa la contraseña admin y presiona **Ingresar**.
3. Presiona **Preparar buscador (1 vez)** y espera el progreso.

> El backfill es idempotente: si un documento ya tiene `searchTokens` con `searchVersion` actualizado, se omite.

---

# Conteos aproximados en la base de datos de códigos

Para evitar errores de índices compuestos infinitos en Firestore, la sección **Base de datos códigos HarujaGdl** usa conteos aproximados calculados por escaneo local (hasta un límite de documentos). Esto evita `failed-precondition` en `runAggregationQuery` y mantiene la UI estable incluso con muchos filtros. Cuando se alcanza el límite de escaneo, el total se muestra con prefijo `≈`. 

---

# Índices recomendados (Base de datos códigos HarujaGdl)

Para evitar errores de índices faltantes en la colección `HarujaPrendas_2025`, crea los siguientes índices compuestos:

1. **Index A (filtro por fechaAlta + facetas)**
   - proveedor (asc)
   - tipo (asc)
   - color (asc)
   - talla (asc)
   - status (asc)
   - fechaAlta (desc)

2. **Index B (búsqueda por descripción)**
   - searchTokens (array-contains)
   - fechaAlta (desc)


## Migración de fechaAlta (legacy -> oficial)

Si ya existen prendas sin `fechaAlta`, corre la migración para mapear datos legacy sin tocar `createdAt`.

Dry run:

```bash
npm run migrate:fechaAlta:dry
```

Escritura real:

```bash
npm run migrate:fechaAlta
```

Regla de migración:
- Si falta `fechaAltaTexto` y existe `fechaTexto`, se copia a `fechaAltaTexto`.
- Si falta `fechaAlta` y existe `fecha` parseable, se setea `fechaAlta` y `fechaAltaTexto` normalizada.
- No se eliminan campos legacy (`fecha`/`fechaTexto`).
