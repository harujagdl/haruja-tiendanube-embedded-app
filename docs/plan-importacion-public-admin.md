# ✅ /plan de Codex — Importación y creación de colecciones PUBLIC + ADMIN

## OBJETIVO
- Ejecutar la Cloud Function `importPrendasFromXlsx` para crear:
  - `HarujaPrendas_2025_public`
  - `HarujaPrendas_2025_admin`
- Confirmar que todo quedó en Firestore.
- Verificar que el panel cargue datos correctamente.
- No habilitar facturación sin necesidad.

## PRECONDICIONES
- ✔ La Cloud Function `importPrendasFromXlsx` está desplegada.
- ✔ El archivo `HarujaPrendas_2025.xlsx` está en `functions/data/`.
- ✔ El deploy ya se ejecutó sin errores de billing.

## FASE 1 — Obtener la URL de la Function
1. Entra a **Firebase Console → Build → Functions**.
2. Busca la function:
   - `importPrendasFromXlsx`
3. Copia su **Trigger URL**.

Ejemplo:

```txt
https://us-central1-haruja-tiendanube.cloudfunctions.net/importPrendasFromXlsx
```

## FASE 2 — Ejecutar la Function (POST)
4. Abre una herramienta HTTP (ejemplo: https://hoppscotch.io) o usa `curl`.
5. Configura:
   - Método: `POST`
   - URL: (la URL copiada)
   - Body: vacío
6. Ejecuta la petición.

Alternativa por terminal:

```bash
curl -X POST "https://us-central1-haruja-tiendanube.cloudfunctions.net/importPrendasFromXlsx"
```

## FASE 3 — Validar la respuesta
7. Debes recibir una respuesta similar a:

```json
{
  "ok": true,
  "sheet": "Sheet1",
  "rowsImported": 1200,
  "publicCollection": "HarujaPrendas_2025_public",
  "adminCollection": "HarujaPrendas_2025_admin"
}
```

Casos posibles:
- Si recibes `{ "ok": true, "rowsImported": 0 }`:
  - La función corrió, pero no encontró filas válidas.
- Si recibes error:
  - Ir a **FASE 4 (Logs)**.

## FASE 4 — Revisar Logs si hay error
8. Ve a **Firebase Console → Functions → importPrendasFromXlsx → Logs**.
9. Busca errores tipo:
   - `ENOENT` (archivo no encontrado)
   - `MODULE_NOT_FOUND` (`xlsx`)
   - `PERMISSION_DENIED` (escritura en Firestore)
10. Corrige según el error y vuelve a ejecutar el `POST`.

## FASE 5 — Confirmar colecciones en Firestore
11. En **Firestore Console → Data**, deben aparecer:
    - `HarujaPrendas_2025_public`
    - `HarujaPrendas_2025_admin`

Además, ambas deben tener documentos.

## FASE 6 — Validar en el panel Haruja
12. Abre el panel Haruja (si hace falta, en incógnito).
13. En la consola del navegador deberían aparecer logs como:

```txt
[Prendas] Usando colección: HarujaPrendas_2025_public
[Prendas] snapshot size: > 0
```

14. La tabla debe mostrar correctamente:
- Orden
- Código
- Descripción
- Tipo
- Color
- Talla
- Proveedor
- Status
- Disponibilidad
- Fecha
- P.Venta

## VALIDACIÓN FINAL
- Las colecciones existen y tienen documentos.
- El panel lista más de 0 productos.
- No se requiere Cloud Billing para este flujo (solo ejecución de la function).
