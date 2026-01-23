# Seed de diccionario en Firestore

Este script carga el diccionario de códigos desde el Excel y actualiza Firestore en la colección `diccionario_codigos`.

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

El script crea documentos por cada ítem del diccionario dentro de `diccionario_codigos` con campos como `tipo`, `proveedor`, `color` o `talla` (y `*Nombre`) según corresponda.

## Ejecutar desde GitHub Actions

1. Entra a **Actions** → **Seed Diccionario to Firestore**.
2. Presiona **Run workflow**.
3. Verifica en Firestore la colección `diccionario_codigos`.

## Verificar en Firestore

- En Firebase Console, abre Firestore y confirma que la colección `diccionario_codigos` tenga documentos.

## Probar en Hosting

- Despliega el sitio con el flujo normal de Hosting y abre la URL pública. Los menús desplegables deberían cargar desde Firestore.
