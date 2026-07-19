// Единая инициализация Firebase для всех страниц приложения.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";

export {
  collection, getDocs, doc, setDoc, deleteDoc, getDoc, query, where
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

export {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD1uWPrp12lvpyBzXCOq9IrMuTU4uOTRao",
  authDomain: "natas-kitchen.firebaseapp.com",
  projectId: "natas-kitchen",
  storageBucket: "natas-kitchen.firebasestorage.app",
  messagingSenderId: "756908196325",
  appId: "1:756908196325:web:0ca8d4e6f853c1cb436f0c"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Разрешается после восстановления сессии из браузера — страницы, пишущие в
// Firestore, должны дождаться, чтобы запросы ушли с токеном (важно для rules).
export const authReady = new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
});
