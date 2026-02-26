import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

export const ADMINS = [
  "yair.tenorio.silva@gmail.com",
  "harujagdl@gmail.com",
  "harujagdl.ventas@gmail.com"
].map((email) => String(email || "").toLowerCase());

export function isAdminUser(user) {
  const email = String(user?.email || "").toLowerCase();
  return ADMINS.includes(email);
}

export async function adminSignIn(auth) {
  const provider = new GoogleAuthProvider();
  if (window.self !== window.top) {
    await signInWithRedirect(auth, provider);
    return null;
  }
  const response = await signInWithPopup(auth, provider);
  return response?.user || null;
}

export async function adminSignOut(auth) {
  await signOut(auth);
}
