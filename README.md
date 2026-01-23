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
