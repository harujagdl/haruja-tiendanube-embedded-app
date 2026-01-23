import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import admin from 'firebase-admin';
import xlsx from 'xlsx';

const DEFAULT_XLSX_FILENAME = 'Creación Códigos HARUJA - PRUEBA.xlsx';
const DEFAULT_XLSX_LOCATIONS = [
  path.resolve(process.cwd(), 'Data', DEFAULT_XLSX_FILENAME),
  path.resolve(process.cwd(), '..', 'Data', DEFAULT_XLSX_FILENAME),
];

const CODE_PATTERN = /^HA(\d{5})\/([A-Z0-9]+)-([A-Z0-9]+)$/i;

const COLUMN_ALIASES = {
  code: ['codigo', 'código', 'code', 'sku'],
  tipo: ['tipo', 'producto', 'prenda'],
  proveedor: ['proveedor'],
  color: ['color'],
  talla: ['talla', 'tamano', 'tamaño', 'size'],
  descripcion: ['descripcion', 'descripción', 'desc'],
  createdAt: ['fecha', 'created', 'creado', 'created_at', 'fecha_creacion'],
};

const normalizeString = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const findDefaultXlsxPath = () => {
  const explicitPath = process.env.PRENDAS_XLSX;
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return DEFAULT_XLSX_LOCATIONS.find((candidate) => fs.existsSync(candidate));
};

const findHeaderRow = (rows) => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const normalized = row.map((cell) => normalizeString(cell)).filter(Boolean);
    if (!normalized.length) continue;
    if (COLUMN_ALIASES.code.some((alias) => normalized.includes(alias))) {
      return { index, headers: row };
    }
  }
  return null;
};

const resolveIndexMap = (headers) => {
  const normalizedHeaders = headers.map((header) => normalizeString(header));
  const indexMap = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = normalizedHeaders.findIndex((header) =>
      aliases.some((alias) => header === alias || header.includes(alias)),
    );
    if (index !== -1) {
      indexMap[field] = index;
    }
  }

  return indexMap;
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

  const localPath = path.resolve(process.cwd(), 'serviceAccount.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }

  const fallbackPath = path.resolve(process.cwd(), '..', 'scripts', 'serviceAccount.json');
  if (fs.existsSync(fallbackPath)) {
    return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }

  throw new Error(
    'Credenciales no encontradas. Usa serviceAccount.json en /scripts o define GCP_SA_KEY/GOOGLE_APPLICATION_CREDENTIALS.',
  );
};

const normalizeDocId = (code) =>
  normalizeString(code)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const parseDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  return null;
};

const parseWorkbook = (workbook) => {
  const items = [];
  let invalidCodes = 0;
  let maxConsecutivo = 0;

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

    const headers = headerInfo.headers.map((cell) => String(cell).trim());
    const indexMap = resolveIndexMap(headers);
    if (indexMap.code === undefined) return;

    for (let rowIndex = headerInfo.index + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
        continue;
      }

      const rawCode = String(row[indexMap.code] ?? '').trim();
      if (!rawCode) {
        continue;
      }

      const match = rawCode.match(CODE_PATTERN);
      if (!match) {
        invalidCodes += 1;
        continue;
      }

      const consecutivo = Number(match[1]);
      if (Number.isFinite(consecutivo)) {
        maxConsecutivo = Math.max(maxConsecutivo, consecutivo);
      }

      const colorFromCode = match[2]?.toUpperCase() ?? '';
      const tallaFromCode = match[3]?.toUpperCase() ?? '';

      const item = {
        code: rawCode.toUpperCase(),
        tipo: indexMap.tipo !== undefined ? String(row[indexMap.tipo] ?? '').trim() : '',
        proveedor:
          indexMap.proveedor !== undefined
            ? String(row[indexMap.proveedor] ?? '').trim()
            : '',
        color:
          indexMap.color !== undefined
            ? String(row[indexMap.color] ?? '').trim().toUpperCase()
            : colorFromCode,
        talla:
          indexMap.talla !== undefined
            ? String(row[indexMap.talla] ?? '').trim().toUpperCase()
            : tallaFromCode,
        descripcion:
          indexMap.descripcion !== undefined
            ? String(row[indexMap.descripcion] ?? '').trim()
            : '',
        createdAt:
          indexMap.createdAt !== undefined
            ? parseDateValue(row[indexMap.createdAt])
            : null,
      };

      if (!item.color) {
        item.color = colorFromCode;
      }
      if (!item.talla) {
        item.talla = tallaFromCode;
      }

      items.push(item);
    }
  });

  return { items, invalidCodes, maxConsecutivo };
};

const main = async () => {
  const xlsxPath = findDefaultXlsxPath();

  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    throw new Error(
      `No existe el archivo Excel. Define PRENDAS_XLSX o guarda ${DEFAULT_XLSX_FILENAME} en /Data.`,
    );
  }

  const workbook = xlsx.readFile(xlsxPath, { cellDates: true });
  const { items, invalidCodes, maxConsecutivo } = parseWorkbook(workbook);

  if (!items.length) {
    throw new Error('No se encontraron registros válidos en el Excel.');
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();
  const prendasRef = db.collection('prendas');
  let inserted = 0;
  let existing = 0;

  for (const item of items) {
    const docId = normalizeDocId(item.code);
    const docRef = prendasRef.doc(docId);
    const snapshot = await docRef.get();
    if (snapshot.exists) {
      existing += 1;
      continue;
    }

    const payload = {
      code: item.code,
      codigo: item.code,
      tipo: item.tipo || null,
      proveedor: item.proveedor || null,
      color: item.color || null,
      talla: item.talla || null,
      descripcion: item.descripcion || null,
    };

    if (item.createdAt) {
      payload.createdAt = admin.firestore.Timestamp.fromDate(item.createdAt);
    }

    await docRef.set(payload, { merge: false });
    inserted += 1;
  }

  if (maxConsecutivo > 0) {
    const counterRef = db.collection('counters').doc('codigos');
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counterRef);
      const currentValue = snapshot.exists ? Number(snapshot.data().lastNumber) || 0 : 0;
      const nextValue = Math.max(currentValue, maxConsecutivo);
      transaction.set(counterRef, { lastNumber: nextValue }, { merge: true });
    });
  }

  console.log('Seed de prendas finalizado.');
  console.log(`Insertados: ${inserted}`);
  console.log(`Ya existían: ${existing}`);
  console.log(`Códigos inválidos: ${invalidCodes}`);
  console.log(`Máximo consecutivo detectado: ${maxConsecutivo || 0}`);
};

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
