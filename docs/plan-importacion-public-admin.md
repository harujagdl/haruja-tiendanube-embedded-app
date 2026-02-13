# ✅ /plan de Codex — Migrar colección master a PUBLIC + ADMIN

## OBJETIVO
- Crear físicamente las colecciones:
  - `HarujaPrendas_2025_public`
  - `HarujaPrendas_2025_admin`
- Tomar los documentos ya existentes en `HarujaPrendas_2025`.
- Copiarlos correctamente separando campos públicos y admin.
- Dejar el sistema sincronizado automáticamente en adelante.

## PASO 1 — Verificar que la Function esté desplegada
1. Ir a **Firebase Console → Functions**.
2. Confirmar que existe al menos una de estas funciones HTTP:
   - `migrateSplitCollections` (preferida)
   - `splitPrendasToPublicAdmin` (alternativa legacy)

Si no aparece ninguna, el deploy está fallando y primero hay que resolver eso.

> Importante: **deploy solo sube código**. La migración no corre sola; hay que ejecutar la función HTTP al menos una vez.

## PASO 2 — Ejecutar la función de migración
Ejecutar una petición `POST` a la función desplegada.

URL recomendada:

```txt
https://us-central1-<PROJECT_ID>.cloudfunctions.net/migrateSplitCollections
```

Método: `POST`

Headers:

```txt
Authorization: Bearer <FIREBASE_ID_TOKEN>
Content-Type: application/json
```

Body:

```json
{}
```

Ejemplo con `curl`:

```bash
curl -X POST "https://us-central1-<PROJECT_ID>.cloudfunctions.net/migrateSplitCollections" \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## PASO 3 — Obtener el ID Token correctamente
En la app web donde ya haces login con Google, abrir consola del navegador y ejecutar:

```js
firebase.auth().currentUser.getIdToken(true).then(t => console.log(t))
```

Copiar el token e insertarlo en el header `Authorization`.

## PASO 4 — Confirmar respuesta esperada
La respuesta debe ser similar a:

```json
{
  "ok": true,
  "read": 1398,
  "writtenPublic": 1398,
  "writtenAdmin": 1398,
  "hasMore": false
}
```

Si responde `ok: true`, ir a Firestore y verificar que ya existen:

- `HarujaPrendas_2025_public`
- `HarujaPrendas_2025_admin`

> Nota: Firestore no “crea” una colección hasta que exista al menos 1 documento escrito.

## PASO 5 — Verificar que el panel consulte la colección correcta
En frontend, confirmar que la lectura principal de prendas usa:

- `HarujaPrendas_2025_public`

Y no la colección master:

- `HarujaPrendas_2025`

## PASO 6 — Confirmar sincronización automática futura
El backend incluye el trigger:

- `syncPrendasDerivedCollections`

Eso asegura que cualquier alta/edición futura en `HarujaPrendas_2025` actualice automáticamente `HarujaPrendas_2025_public` y `HarujaPrendas_2025_admin`.

## ACLARACIÓN IMPORTANTE
Las colecciones derivadas **no** se crean por:

- hacer deploy,
- declarar constantes en código,
- tener la función definida.

Se crean únicamente cuando se ejecuta una escritura real de documentos (migración o trigger).
