import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

const logGoalsPath = (action, pathOrQuery, auth) => {
  console.log("[goals] acción:", action);
  console.log("[goals] leyendo path:", pathOrQuery);
  console.log("[goals] user:", auth?.currentUser?.email || null);
};

export async function getGoalsSalesState(db, { year, auth } = {}) {
  const normalizedYear = Number(year) || new Date().getFullYear();
  const monthlyGoals = {};

  const configRef = doc(db, "goals_sales", "config");
  const annualRef = doc(db, "goals_sales", "config", "annual", String(normalizedYear));
  const monthlyRef = collection(db, "goals_sales", "config", "monthly");

  logGoalsPath("getDoc", configRef.path, auth);
  logGoalsPath("getDoc", annualRef.path, auth);
  logGoalsPath("getDocs", monthlyRef.path, auth);

  const [configSnap, annualSnap, monthlySnap] = await Promise.all([
    getDoc(configRef),
    getDoc(annualRef),
    getDocs(monthlyRef)
  ]);

  monthlySnap.forEach((item) => {
    const data = item.data() || {};
    const key = item.id;
    if (!key.startsWith(`${normalizedYear}-`)) return;
    monthlyGoals[key] = Number(data.goal ?? data.meta ?? 0);
  });

  return {
    defaultMonthlyGoal: Number(configSnap.data()?.defaultMonthlyGoal ?? 10000),
    annualGoal: Number(annualSnap.data()?.goal ?? annualSnap.data()?.meta ?? 0),
    monthlyGoals
  };
}

export async function saveMonthlyGoal(db, { year, month, amount, auth } = {}) {
  const key = monthKey(year, month);
  const monthlyRef = doc(db, "goals_sales", "config", "monthly", key);
  logGoalsPath("setDoc", monthlyRef.path, auth);
  await setDoc(monthlyRef, {
    year: Number(year),
    month: Number(month),
    goal: Number(amount) || 0,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function saveRangeMonthlyGoal(db, { year, startMonth, endMonth, amount, writeBatch, auth } = {}) {
  const batch = writeBatch(db);
  for (let month = Number(startMonth); month <= Number(endMonth); month += 1) {
    const key = monthKey(year, month);
    const monthlyRef = doc(db, "goals_sales", "config", "monthly", key);
    logGoalsPath("batch.set", monthlyRef.path, auth);
    batch.set(monthlyRef, {
      year: Number(year),
      month,
      goal: Number(amount) || 0,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();
}

export async function saveAnnualGoal(db, { year, amount, auth } = {}) {
  const annualRef = doc(db, "goals_sales", "config", "annual", String(year));
  logGoalsPath("setDoc", annualRef.path, auth);
  await setDoc(annualRef, {
    year: Number(year),
    goal: Number(amount) || 0,
    updatedAt: serverTimestamp()
  }, { merge: true });
}
