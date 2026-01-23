import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import admin from 'firebase-admin';
import xlsx from 'xlsx';

const DEFAULT_XLSX_PATH = path.resolve(
  process.cwd(),
  'Data',
  'Diccionario creación códigos HARUJA.xlsx',
);

const CATEGORY_KEYS = ['tipos', 'proveedores', 'colores', 'tallas'];

const CATEGORY_ALIASES = {
  tipos: ['tipo', 'tipos', 'producto', 'productos', 'prenda', 'prendas'],
  proveedores: ['proveedor', 'proveedores'],
  colores: ['color', 'colores'],
  tallas: ['talla', 'tallas', 'tamano', 'tamaño'],
};

const REQUIRED_HEADERS = {
  multi: ['tipo', 'clave', 'valor'],
  single: ['codigo', 'clave', 'nombre', 'valor', 'descripcion'],
};

const isDryRun = process.argv.includes('--dry');

const normalizeString = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeKey = (value = '') =>
  normalizeString(value)
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');

const resolveCategory = (value = '') => {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return category;
    }
  }
  return null;
};

const findHeaderRow = (rows) => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const normalized = row.map((cell) => normalizeString(cell)).filter(Boolean);
    if (REQUIRED_HEADERS.multi.every((header) => normalized.includes(header))) {
      return { index, mode: 'multi' };
    }
    const hasCode = normalized.includes('codigo') || normalized.includes('clave');
    const hasName =
      normalized.includes('nombre') ||
      normalized.includes('valor') ||
      normalized.includes('descripcion');
    if (hasCode && hasName) {
      return { index, mode: 'single' };
    }
  }
  return null;
};

const buildItem = ({ headers, row, codeIndex, nameIndex, skipKeys }) => {
  const codigo = String(row[codeIndex] ?? '').trim();
  const nombre = String(row[nameIndex] ?? '').trim();

  if (!codigo || !nombre) return null;

  const item = { id: codigo, nombre };

  headers.forEach((header, idx) => {
    const key = normalizeKey(header);
    if (!key || skipKeys.has(key) || idx === codeIndex || idx === nameIndex) {
      return;
    }
    const value = row[idx];
    if (value === null || value === undefined || String(value).trim() === '') {
      return;
    }
    item[key] = value;
  });

  return item;
};

const loadServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GCP_SA_KEY) {
    return JSON.parse(process.env.GCP_SA_KEY);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  }
  throw new Error(
    'Credenciales no encontradas. Define GCP_SA_KEY, GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_SERVICE_ACCOUNT_JSON.',
  );
};

const parseWorkbook = (workbook) => {
  const itemsByCategory = Object.fromEntries(
    CATEGORY_KEYS.map((category) => [category, []]),
  );

  let parsedAny = false;

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;

    const rows = xlsx.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    });

    if (!rows.length) return;

    const headerInfo = findHeaderRow(rows);
    if (!headerInfo) return;

    parsedAny = true;
    const headers = rows[headerInfo.index].map((cell) => String(cell).trim());
    const normalizedHeaders = headers.map((header) => normalizeString(header));

    const typeIndex = normalizedHeaders.indexOf('tipo');
    const codeIndex =
      normalizedHeaders.indexOf('codigo') !== -1
        ? normalizedHeaders.indexOf('codigo')
        : normalizedHeaders.indexOf('clave');
    const nameIndex =
      normalizedHeaders.indexOf('nombre') !== -1
        ? normalizedHeaders.indexOf('nombre')
        : normalizedHeaders.indexOf('valor') !== -1
          ? normalizedHeaders.indexOf('valor')
          : normalizedHeaders.indexOf('descripcion');

    const skipKeys = new Set([
      'tipo',
      'clave',
      'codigo',
      'nombre',
      'valor',
      'descripcion',
    ]);

    for (let rowIndex = headerInfo.index + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
        continue;
      }

      let category = resolveCategory(sheetName);
      if (typeIndex !== -1) {
        category = resolveCategory(row[typeIndex]);
      }

      if (!category) {
        continue;
      }

      if (codeIndex === -1 || nameIndex === -1) {
        continue;
      }

      const item = buildItem({
        headers,
        row,
        codeIndex,
        nameIndex,
        skipKeys,
      });
      if (!item) continue;

      itemsByCategory[category].push(item);
    }
  });

  if (!parsedAny) {
    throw new Error(
      'No se detectaron hojas con encabezados válidos (Tipo/Clave/Valor o Codigo/Nombre).',
    );
  }

  return itemsByCategory;
};

const finalizeDictionary = (itemsByCategory) => {
  const result = {};
  const missing = [];

  CATEGORY_KEYS.forEach((category) => {
    const items = itemsByCategory[category]
      .filter((item) => item && item.id && item.nombre)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    if (!items.length) {
      missing.push(category);
    }

    result[category] = items;
  });

  if (missing.length) {
    throw new Error(
      `No se encontraron items para: ${missing.join(
        ', ',
      )}. Verifica las hojas o encabezados del Excel.`,
    );
  }

  return result;
};

const main = async () => {
  const xlsxPath = process.env.DICCIONARIO_XLSX || DEFAULT_XLSX_PATH;

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`No existe el archivo Excel en: ${xlsxPath}`);
  }

  const workbook = xlsx.readFile(xlsxPath, { cellDates: false });
  const itemsByCategory = parseWorkbook(workbook);
  const dictionary = finalizeDictionary(itemsByCategory);

  if (isDryRun) {
    console.log('[dry] Diccionario procesado.');
    CATEGORY_KEYS.forEach((category) => {
      console.log(`[dry] ${category}: ${dictionary[category].length} items`);
    });
    return;
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();
  const batch = db.batch();

  for (const category of CATEGORY_KEYS) {
    const categoryDoc = db.collection('diccionario').doc(category);
    batch.set(
      categoryDoc,
      {
        items: dictionary[category],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  await batch.commit();

  const proveedores = dictionary.proveedores.map((item) => item.id);
  const tipos = dictionary.tipos.map((item) => item.id);

  for (const proveedorId of proveedores) {
    for (const tipoId of tipos) {
      const counterId = `prov${proveedorId}_tipo${tipoId}`;
      const counterRef = db.collection('counters').doc(counterId);
      const snapshot = await counterRef.get();
      if (!snapshot.exists) {
        await counterRef.set({ value: 0 });
      }
    }
  }

  console.log('Diccionario cargado en diccionario/{tipos,proveedores,colores,tallas}.');
};

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
