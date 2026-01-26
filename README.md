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
npm run seed:dry
```

Escritura real en Firestore:

```bash
npm run seed
```

> Nota: este es el único seed oficial. Evita ejecutar scripts antiguos o en conflicto.

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Counters from JSON**.
2. Presiona **Run workflow**.
3. Ajusta `dryRun` o `jsonPath` si hace falta.
4. Verifica en Firestore la colección `counters`.
