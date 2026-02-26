import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

export const emptyMonths = (year = new Date().getFullYear()) => {
  const out = {};
  for (let m = 1; m <= 12; m += 1) {
    out[`${year}-${String(m).padStart(2, "0")}`] = 0;
  }
  return out;
};

export async function getMonthlySalesTotals(db, { year, auth } = {}) {
  const normalizedYear = Number(year) || new Date().getFullYear();
  const monthlyTotals = emptyMonths(normalizedYear);

  console.log("[goals] leyendo path:", "ventas_totales_mensuales");
  console.log("[goals] user:", auth?.currentUser?.email || null);

  const monthKeys = Array.from({ length: 12 }, (_, idx) => `${normalizedYear}-${String(idx + 1).padStart(2, "0")}`);
  const monthlySnaps = await Promise.all(
    monthKeys.map((key) => getDoc(doc(db, "ventas_totales_mensuales", key)))
  );

  monthlySnaps.forEach((docSnap, idx) => {
    if (!docSnap.exists()) return;
    const data = docSnap.data() || {};
    const total = Number(data.totalSales ?? data.total ?? data.ventas ?? 0);
    monthlyTotals[monthKeys[idx]] = Number.isFinite(total) ? total : 0;
  });

  return { monthlyTotals };
}
