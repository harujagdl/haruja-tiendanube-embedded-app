const admin = require("firebase-admin");
const crypto = require("crypto");

const LOYALTY_CLIENTS_COLLECTION = "loyalty_clients";
const LOYALTY_MOVES_COLLECTION = "loyalty_moves";
const LOYALTY_COUNTER_DOC = "loyaltyClientSeq";
const DEFAULT_PUBLIC_BASE_URL = "https://tiendanube.web.app";

const REWARDS = [
  {points: 150, label: "10% descuento"},
  {points: 300, label: "$120 descuento"},
  {points: 500, label: "$250 descuento"},
  {points: 800, label: "$450 descuento / prenda hasta $499"}
];

const getLevel = (points) => {
  const safePoints = Number(points) || 0;
  if (safePoints >= 800) return "VIP";
  if (safePoints >= 500) return "Oro";
  if (safePoints >= 300) return "Plata";
  if (safePoints >= 150) return "Bronce";
  return "Nuevo";
};

const calcPointsEarned = (amount) => Math.max(0, Math.floor((Number(amount) || 0) * 0.1));

const normalizeClient = (docSnap) => {
  const data = docSnap.data() || {};
  const toMillis = (value) => (value instanceof admin.firestore.Timestamp ? value.toMillis() : null);
  return {
    id: docSnap.id,
    clientId: String(data.clientId || docSnap.id),
    name: String(data.name || ""),
    phone: String(data.phone || ""),
    instagram: String(data.instagram || ""),
    email: String(data.email || ""),
    points: Number(data.points) || 0,
    totalPurchases: Number(data.totalPurchases) || 0,
    level: String(data.level || "Nuevo"),
    visits: Number(data.visits) || 0,
    token: String(data.token || ""),
    qrLink: String(data.qrLink || ""),
    lastMovementAt: toMillis(data.lastMovementAt),
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
    lastPurchaseAt: toMillis(data.lastPurchaseAt)
  };
};

const buildBadRequestError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const buildPublicBaseUrl = () => {
  const configured = String(process.env.BASE_PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  return DEFAULT_PUBLIC_BASE_URL;
};

const buildQrLink = (token) => `${buildPublicBaseUrl()}/tarjeta-lealtad.html?token=${token}`;

const randomToken = (size = 12) => crypto.randomBytes(size).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);

const generateUniqueToken = async (db) => {
  for (let i = 0; i < 10; i += 1) {
    const token = randomToken(12);
    if (!token) continue;
    const snap = await db.collection(LOYALTY_CLIENTS_COLLECTION).where("token", "==", token).limit(1).get();
    if (snap.empty) return token;
  }
  throw new Error("No pude generar un token único. Intenta de nuevo.");
};

const mapRewardOptions = (points) => {
  const safePoints = Number(points) || 0;
  return REWARDS.map((reward) => ({
    ...reward,
    available: safePoints >= reward.points,
    missingPoints: Math.max(0, reward.points - safePoints)
  }));
};

const registerClient = async (req, db) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const instagram = String(body.instagram || "").trim();
  const email = String(body.email || "").trim();

  if (!name) throw buildBadRequestError("El nombre es obligatorio.");

  const counterRef = db.collection("counters").doc(LOYALTY_COUNTER_DOC);
  const token = await generateUniqueToken(db);
  const qrLink = buildQrLink(token);

  const client = await db.runTransaction(async (trx) => {
    const counterSnap = await trx.get(counterRef);
    const next = Math.max(1, Number(counterSnap.data()?.next) || 1);
    const clientId = `HCL-${String(next).padStart(4, "0")}`;
    const clientDocRef = db.collection(LOYALTY_CLIENTS_COLLECTION).doc(clientId);
    const existing = await trx.get(clientDocRef);
    if (existing.exists) {
      throw buildBadRequestError(`El clientId ${clientId} ya existe.`, 409);
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const payload = {
      clientId,
      name,
      nameLower: name.toLowerCase(),
      phone,
      instagram,
      email,
      points: 0,
      totalPurchases: 0,
      level: "Nuevo",
      visits: 0,
      token,
      qrLink,
      lastMovementAt: now,
      createdAt: now,
      updatedAt: now,
      lastPurchaseAt: null
    };

    trx.set(counterRef, {next: next + 1, updatedAt: now}, {merge: true});
    trx.set(clientDocRef, payload, {merge: false});
    return payload;
  });

  return {ok: true, client};
};

const searchClients = async (req, db) => {
  const q = String(req.query?.q || "").trim();
  if (!q) return {ok: true, items: []};

  let snap;
  if (q.toUpperCase().startsWith("HCL-")) {
    const exact = await db.collection(LOYALTY_CLIENTS_COLLECTION).doc(q.toUpperCase()).get();
    return {ok: true, items: exact.exists ? [normalizeClient(exact)] : []};
  }

  if (/^\d+$/.test(q)) {
    snap = await db.collection(LOYALTY_CLIENTS_COLLECTION).where("phone", "==", q).limit(20).get();
    return {ok: true, items: snap.docs.map(normalizeClient)};
  }

  const qLower = q.toLowerCase();
  snap = await db.collection(LOYALTY_CLIENTS_COLLECTION)
    .where("nameLower", ">=", qLower)
    .where("nameLower", "<=", `${qLower}\uf8ff`)
    .limit(20)
    .get();

  return {ok: true, items: snap.docs.map(normalizeClient)};
};

const addPurchase = async (req, db) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const clientId = String(body.clientId || "").trim().toUpperCase();
  const amount = Number(body.amount);
  const notes = String(body.notes || "").trim();

  if (!clientId) throw buildBadRequestError("clientId es obligatorio.");
  if (!Number.isFinite(amount) || amount <= 0) throw buildBadRequestError("amount debe ser mayor a 0.");

  const clientRef = db.collection(LOYALTY_CLIENTS_COLLECTION).doc(clientId);
  const moveRef = db.collection(LOYALTY_MOVES_COLLECTION).doc();

  const clientData = await db.runTransaction(async (trx) => {
    const clientSnap = await trx.get(clientRef);
    if (!clientSnap.exists) throw buildBadRequestError(`No existe cliente ${clientId}.`, 404);
    const data = clientSnap.data() || {};
    const points = Number(data.points) || 0;
    const totalPurchases = Number(data.totalPurchases) || 0;
    const pointsEarned = calcPointsEarned(amount);
    const pointsFinal = points + pointsEarned;
    const updated = {
      points: pointsFinal,
      totalPurchases: totalPurchases + amount,
      level: getLevel(pointsFinal),
      lastMovementAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    trx.set(clientRef, updated, {merge: true});
    trx.set(moveRef, {
      clientId,
      clientName: String(data.name || ""),
      type: "purchase",
      amount,
      pointsEarned,
      pointsRedeemed: 0,
      pointsFinal,
      notes,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return {...data, ...updated, clientId};
  });

  const level = getLevel(clientData.points);
  return {ok: true, client: {...clientData, level}};
};

const redeem = async (req, db) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const clientId = String(body.clientId || "").trim().toUpperCase();
  const rewardPts = Number(body.rewardPts);
  const notes = String(body.notes || "").trim();

  const reward = REWARDS.find((item) => item.points === rewardPts);
  if (!clientId) throw buildBadRequestError("clientId es obligatorio.");
  if (!reward) throw buildBadRequestError("rewardPts inválido. Usa 150, 300, 500 u 800.");

  const clientRef = db.collection(LOYALTY_CLIENTS_COLLECTION).doc(clientId);
  const moveRef = db.collection(LOYALTY_MOVES_COLLECTION).doc();

  const clientData = await db.runTransaction(async (trx) => {
    const clientSnap = await trx.get(clientRef);
    if (!clientSnap.exists) throw buildBadRequestError(`No existe cliente ${clientId}.`, 404);
    const data = clientSnap.data() || {};
    const points = Number(data.points) || 0;
    if (points < rewardPts) throw buildBadRequestError("Puntos insuficientes para canjear.", 400);
    const pointsFinal = points - rewardPts;
    const updated = {
      points: pointsFinal,
      level: getLevel(pointsFinal),
      lastMovementAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    trx.set(clientRef, updated, {merge: true});
    trx.set(moveRef, {
      clientId,
      clientName: String(data.name || ""),
      type: "redeem",
      amount: 0,
      pointsEarned: 0,
      pointsRedeemed: rewardPts,
      pointsFinal,
      notes,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return {...data, ...updated, clientId};
  });

  return {ok: true, client: clientData, reward};
};

const getByToken = async (req, db) => {
  const token = String(req.query?.token || "").trim();
  if (!token) throw buildBadRequestError("Falta token.");

  const snap = await db.collection(LOYALTY_CLIENTS_COLLECTION).where("token", "==", token).limit(1).get();
  if (snap.empty) throw buildBadRequestError("Tarjeta no encontrada.", 404);

  const client = normalizeClient(snap.docs[0]);
  return {
    ok: true,
    clientPublic: {
      name: client.name,
      points: client.points,
      level: client.level,
      totalPurchases: client.totalPurchases,
      lastMovementAt: client.lastMovementAt,
      visits: client.visits,
      rewardOptions: mapRewardOptions(client.points)
    }
  };
};

const addVisit = async (req, db) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const token = String(body.token || "").trim();
  if (!token) throw buildBadRequestError("Falta token.");

  const tokenSnap = await db.collection(LOYALTY_CLIENTS_COLLECTION).where("token", "==", token).limit(1).get();
  if (tokenSnap.empty) throw buildBadRequestError("Tarjeta no encontrada.", 404);
  const clientRef = tokenSnap.docs[0].ref;

  await db.runTransaction(async (trx) => {
    const snap = await trx.get(clientRef);
    const data = snap.data() || {};
    const visits = Number(data.visits) || 0;
    trx.set(clientRef, {
      visits: visits + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
  });

  return {ok: true};
};

const listClients = async (req, db) => {
  const limitRaw = Number(req.query?.limit);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 80));

  const snap = await db.collection(LOYALTY_CLIENTS_COLLECTION)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  const items = snap.docs.map(normalizeClient);
  return {ok: true, items, nextCursor: null};
};

const backfillQrLinks = async (_req, db) => {
  const snap = await db.collection(LOYALTY_CLIENTS_COLLECTION).get();
  const batch = db.batch();
  let updatedCount = 0;

  snap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const token = String(data.token || "").trim();
    const qrLink = String(data.qrLink || "").trim();
    const needsBackfill = !qrLink || qrLink.includes("run.app");
    if (!token || !needsBackfill) return;

    batch.set(docSnap.ref, {
      qrLink: buildQrLink(token),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
    updatedCount += 1;
  });

  if (updatedCount > 0) {
    await batch.commit();
  }

  return {
    ok: true,
    scanned: snap.size,
    updated: updatedCount
  };
};

module.exports = {
  registerClient,
  searchClients,
  addPurchase,
  redeem,
  getByToken,
  addVisit,
  listClients,
  backfillQrLinks,
  buildBadRequestError
};
