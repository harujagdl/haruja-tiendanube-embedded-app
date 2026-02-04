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

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Prendas from Excel**.
2. Presiona **Run workflow**.
3. Mantén `dryRun=true` para validar el resumen primero.
4. Cuando el dry-run esté correcto, vuelve a ejecutar con `dryRun=false`.
5. Verifica en Firestore la colección `HarujaPrendas_2025`.

---

# Índices recomendados (Base de datos códigos HarujaGdl)

Para evitar errores de índices faltantes en la colección `HarujaPrendas_2025`, crea los siguientes índices compuestos:

1. **Index A (sin rango de precio)**
   - proveedor (asc)
   - tipo (asc)
   - color (asc)
   - talla (asc)
   - status (asc)
   - createdAt (desc)

2. **Index B (con rango de precio)**
   - proveedor (asc)
   - tipo (asc)
   - color (asc)
   - talla (asc)
   - status (asc)
   - precio (asc)
   - createdAt (desc)
