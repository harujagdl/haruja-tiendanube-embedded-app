# Seed de diccionario en Firestore

Este script carga el diccionario de códigos desde el Excel y actualiza Firestore en la colección `diccionario`.

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

El script actualiza los documentos `tipos`, `proveedores`, `colores` y `tallas` con los campos `items` (ordenados por nombre) y `byCode` (mapa por código).
