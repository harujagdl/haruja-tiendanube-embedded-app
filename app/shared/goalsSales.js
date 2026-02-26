import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

export async function getGoalsSalesState(db, { year }) {
  const normalizedYear = Number(year) || new Date().getFullYear();
  const monthlyGoals = {};

  const [configSnap, annualSnap, monthlySnap] = await Promise.all([
    getDoc(doc(db, "goals_sales", "config")),
    getDoc(doc(db, "goals_sales", "annual", String(normalizedYear))),
    getDocs(collection(db, "goals_sales", "monthly"))
  ]);

  monthlySnap.forEach((item) => {
    const data = item.data() || {};
    const key = item.id;
    if (!key.startsWith(`${normalizedYear}-`)) return;
    monthlyGoals[key] = Number(data.goal ?? data.meta ?? 0);
  });

  return {
    defaultMonthlyGoal: Number(configSnap.data()?.defaultMonthlyGoal ?? 0),
    annualGoal: Number(annualSnap.data()?.goal ?? annualSnap.data()?.meta ?? 0),
    monthlyGoals
  };
}

export async function saveMonthlyGoal(db, { year, month, amount }) {
  const key = monthKey(year, month);
  await setDoc(doc(db, "goals_sales", "monthly", key), {
    year: Number(year),
    month: Number(month),
    goal: Number(amount) || 0,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function saveRangeMonthlyGoal(db, { year, startMonth, endMonth, amount, writeBatch }) {
  const batch = writeBatch(db);
  for (let month = Number(startMonth); month <= Number(endMonth); month += 1) {
    const key = monthKey(year, month);
    batch.set(doc(db, "goals_sales", "monthly", key), {
      year: Number(year),
      month,
      goal: Number(amount) || 0,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();
}

export async function saveAnnualGoal(db, { year, amount }) {
  await setDoc(doc(db, "goals_sales", "annual", String(year)), {
    year: Number(year),
    goal: Number(amount) || 0,
    updatedAt: serverTimestamp()
  }, { merge: true });
}
