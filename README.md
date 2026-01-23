# Seed de diccionario en Firestore

Este script carga el diccionario de códigos desde el Excel y actualiza Firestore en las colecciones:

- `diccionario/tipos/items`
- `diccionario/proveedores/items`
- `diccionario/colores/items`
- `diccionario/tallas/items`

## Requisitos

- Node.js 18+
- Credenciales de servicio de Firebase (no subir al repo)
- Archivo Excel en `Data/Diccionario creación códigos HARUJA.xlsx`

## Instalación

```bash
npm install
```

## Variables de entorno

Configura una de las siguientes opciones:

- `FIREBASE_PROJECT_ID` = ID del proyecto Firebase.
- `GCP_SA_KEY` = string JSON con las credenciales (secreto recomendado).
- `GOOGLE_APPLICATION_CREDENTIALS` = ruta al JSON de la cuenta de servicio.
- `FIREBASE_SERVICE_ACCOUNT_JSON` = string JSON con las credenciales.

Opcional:

- `DICCIONARIO_XLSX` = ruta personalizada al Excel.

## Ejecutar

Dry run (solo lectura):

```bash
npm run seed:dry
```

Carga real en Firestore:

```bash
npm run seed
```

El script crea documentos por cada ítem del diccionario dentro de `diccionario/<categoria>/items` usando `codigo` como ID estable (por ejemplo: `NG`, `M`).

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Diccionario Firestore**.
2. Presiona **Run workflow**.
3. Verifica en Firestore las colecciones `diccionario/<categoria>/items`.

## Verificar en Firestore

- En Firebase Console, abre Firestore y confirma que cada colección `diccionario/<categoria>/items` tenga documentos.

## Validar el frontend

- Abre el panel y confirma que los dropdowns de Tipo, Proveedor, Color y Talla carguen opciones.
- Si una colección está vacía, el formulario mostrará un mensaje indicando qué categorías faltan y el select aparecerá como "Sin opciones disponibles".

## Probar en Hosting

- Despliega el sitio con el flujo normal de Hosting y abre la URL pública. Los menús desplegables deberían cargar desde Firestore.

## ¿Qué hacer si los dropdowns no cargan?

1. Verifica que el workflow o el script local hayan terminado sin errores.
2. Revisa en Firestore que existan documentos dentro de `diccionario/<categoria>/items`.
3. Asegúrate de que el frontend apunte al proyecto correcto (configuración Firebase en `app/index.html`).

# Migración inicial de prendas (FASE B)

Este script carga el histórico real desde `Data/Creación Códigos HARUJA - PRUEBA.xlsx` y crea:

- Colección `prendas` con los registros históricos (incluye `code`, `codigo`, `tipo`, `proveedor`, `color`, `talla`, `descripcion`, `createdAt` si existe).
- Documento `counters/codigos` con `{ lastNumber: <maxConsecutivoHistorico> }`.

El script es idempotente: si el código ya existe, lo salta y registra el conteo.

## Requisitos

- Node.js 18+
- Cuenta de servicio de Firebase (no subir al repo)
- Excel histórico en `Data/Creación Códigos HARUJA - PRUEBA.xlsx`

## Instalación (local, sin Cloud Shell)

```bash
cd scripts
npm install
```

## Credenciales

Opciones para pasar credenciales:

- Guardar el JSON como `scripts/serviceAccount.json`.
- O usar variables: `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GCP_SA_KEY`.

Opcional:

- `PRENDAS_XLSX` = ruta personalizada al Excel histórico.

## Ejecutar migración

```bash
cd scripts
node seed-from-excel.js
```

## Verificar en Firebase Console

1. Abre Firestore y revisa la colección `prendas` (deberías ver los registros históricos).
2. En `counters/codigos`, valida el campo `lastNumber` con el máximo consecutivo detectado.
