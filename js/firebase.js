// Единая инициализация Firebase для всех страниц приложения.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

export {
  collection, getDocs, doc, setDoc, deleteDoc, getDoc
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD1uWPrp12lvpyBzXCOq9IrMuTU4uOTRao",
  authDomain: "natas-kitchen.firebaseapp.com",
  projectId: "natas-kitchen",
  storageBucket: "natas-kitchen.firebasestorage.app",
  messagingSenderId: "756908196325",
  appId: "1:756908196325:web:0ca8d4e6f853c1cb436f0c"
};

export const db = getFirestore(initializeApp(firebaseConfig));
