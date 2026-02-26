import {
  collection,
  getDocs,
  query,
  where
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

  const sources = [
    { col: "sales_totals", field: "year" },
    { col: "ventas_totales_mensuales", field: "year" }
  ];

  for (const source of sources) {
    const salesQuery = query(collection(db, source.col), where(source.field, "==", normalizedYear));
    console.log("[goals] leyendo path:", source.col, "query", `${source.field}==${normalizedYear}`);
    console.log("[goals] user:", auth?.currentUser?.email || null);
    const snap = await getDocs(salesQuery);
    if (snap.empty) continue;
    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const month = String(data.month || docSnap.id).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return;
      const total = Number(data.totalSales ?? data.total ?? data.ventas ?? 0);
      monthlyTotals[month] = Number.isFinite(total) ? total : 0;
    });
    return { monthlyTotals };
  }

  return { monthlyTotals };
}
