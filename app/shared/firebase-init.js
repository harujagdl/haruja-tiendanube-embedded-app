/* global firebase */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyAK5_MuMseQm58AeRZlrPtGyEZ216-Xkno",
    authDomain: "haruja-tiendanube.firebaseapp.com",
    projectId: "haruja-tiendanube",
    storageBucket: "haruja-tiendanube.firebasestorage.app",
    messagingSenderId: "396461447684",
    appId: "1:396461447684:web:770dc3bc9bbb40a2873351"
  };

  window.HARUJA_FIREBASE_CONFIG = firebaseConfig;

  if (!window.firebase || !firebase.initializeApp) {
    console.error("Firebase SDK no está cargado. Revisa scripts /__/firebase/*");
    return;
  }

  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  window.getFirebaseIdToken = async function () {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("No hay sesión. Inicia sesión en el panel.");
    return await user.getIdToken();
  };
})();
