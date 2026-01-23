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

const SHEET_NAME = 'Hoja1';

const CATEGORY_MAP = {
  producto: 'diccionario_tipos',
  productos: 'diccionario_tipos',
  proveedor: 'diccionario_proveedores',
  proveedores: 'diccionario_proveedores',
  color: 'diccionario_colores',
  colores: 'diccionario_colores',
  talla: 'diccionario_tallas',
  tallas: 'diccionario_tallas',
};

const REQUIRED_HEADERS = ['tipo', 'clave', 'valor'];

const isDryRun = process.argv.includes('--dry');

const normalizeString = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

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

const getSheetRows = (workbook) => {
  const sheet = workbook.Sheets[SHEET_NAME] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error('No se encontró la hoja del Excel.');
  }

  return xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });
};

const findHeaderIndexes = (rows) => {
  const headerRow = rows.findIndex((row) =>
    REQUIRED_HEADERS.every((header) =>
      row.map((cell) => normalizeString(cell)).includes(header),
    ),
  );

  if (headerRow === -1) {
    throw new Error('No se encontraron encabezados Tipo/Clave/Valor en el Excel.');
  }

  const headers = rows[headerRow].map((cell) => normalizeString(cell));

  return {
    headerRow,
    tipoIndex: headers.indexOf('tipo'),
    claveIndex: headers.indexOf('clave'),
    valorIndex: headers.indexOf('valor'),
  };
};

const groupRowsByCollection = (rows) => {
  const { headerRow, tipoIndex, claveIndex, valorIndex } = findHeaderIndexes(rows);
  const grouped = new Map();

  for (let rowIndex = headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
      continue;
    }

    const tipoRaw = String(row[tipoIndex] ?? '').trim();
    const clave = String(row[claveIndex] ?? '').trim();
    const valor = String(row[valorIndex] ?? '').trim();
    const tipoKey = normalizeString(tipoRaw);
    const collectionName = CATEGORY_MAP[tipoKey];

    if (!collectionName || !clave || !valor) {
      continue;
    }

    if (!grouped.has(collectionName)) {
      grouped.set(collectionName, []);
    }

    grouped.get(collectionName).push({
      clave,
      valor,
      tipo: tipoRaw,
    });
  }

  return grouped;
};

const main = async () => {
  const xlsxPath = process.env.DICCIONARIO_XLSX || DEFAULT_XLSX_PATH;

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`No existe el archivo Excel en: ${xlsxPath}`);
  }

  const workbook = xlsx.readFile(xlsxPath, { cellDates: false });
  const rows = getSheetRows(workbook);
  const grouped = groupRowsByCollection(rows);

  const expectedCollections = [
    'diccionario_tipos',
    'diccionario_proveedores',
    'diccionario_colores',
    'diccionario_tallas',
  ];

  const missingCollections = expectedCollections.filter(
    (name) => !grouped.has(name) || grouped.get(name).length === 0,
  );

  if (missingCollections.length) {
    throw new Error(
      `No se encontraron registros para: ${missingCollections.join(', ')}.`,
    );
  }

  if (isDryRun) {
    console.log('[dry] Diccionario procesado.');
    expectedCollections.forEach((name) => {
      console.log(`[dry] ${name}: ${grouped.get(name)?.length ?? 0} items`);
    });
    return;
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();

  for (const [collectionName, items] of grouped.entries()) {
    let batch = db.batch();
    let writes = 0;

    for (const item of items) {
      const docRef = db.collection(collectionName).doc(item.clave);
      batch.set(
        docRef,
        {
          ...item,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      writes += 1;

      if (writes === 450) {
        await batch.commit();
        batch = db.batch();
        writes = 0;
      }
    }

    if (writes > 0) {
      await batch.commit();
    }
  }

  console.log('Diccionario cargado en colecciones diccionario_*.');
};

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
