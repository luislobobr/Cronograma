/**
 * Firebase Configuration and Initialization
 * Cronograma App - Vinci Highways
 */

// Firebase SDK Imports (ESM)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore,
    setDoc,
    doc,
    collection,
    onSnapshot,
    addDoc,
    deleteDoc,
    query,
    collectionGroup,
    getDoc,
    getDocs,
    updateDoc,
    arrayUnion,
    arrayRemove
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
    getStorage,
    ref,
    uploadBytes,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";

// --- CONSTANTS ---
export const ALLOWED_DOMAIN = "@vinci-highways.com.br";
export const appId = "cronograma-85bf4";

// Firebase Configuration
export const firebaseConfig = {
    apiKey: "AIzaSyDB_q9kdQGNiLf34PPZFL2YuBDOj7XdwkA",
    authDomain: "cronograma-85bf4.firebaseapp.com",
    projectId: "cronograma-85bf4",
    storageBucket: "cronograma-85bf4.firebasestorage.app",
    messagingSenderId: "802190123207",
    appId: "1:802190123207:web:adaf51b25010f677bbdee2"
};

// Firebase instances (initialized lazily)
let firebaseApp = null;
let db = null;
let auth = null;
let storage = null;

/**
 * Initialize Firebase with the configuration
 * @returns {Object} Firebase instances { firebaseApp, db, auth, storage }
 */
export function initFirebase() {
    if (!firebaseApp) {
        firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);
        storage = getStorage(firebaseApp);
    }
    return { firebaseApp, db, auth, storage };
}

/**
 * Get Firestore database instance
 * @returns {Firestore} Firestore instance
 */
export function getDb() {
    if (!db) {
        initFirebase();
    }
    return db;
}

/**
 * Get Auth instance
 * @returns {Auth} Firebase Auth instance
 */
export function getAuthInstance() {
    if (!auth) {
        initFirebase();
    }
    return auth;
}

/**
 * Get Storage instance
 * @returns {Storage} Firebase Storage instance
 */
export function getStorageInstance() {
    if (!storage) {
        initFirebase();
    }
    return storage;
}

// Re-export Firebase functions for convenience
export {
    // Auth
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail,
    // Firestore
    setDoc,
    doc,
    collection,
    onSnapshot,
    addDoc,
    deleteDoc,
    query,
    collectionGroup,
    getDoc,
    getDocs,
    updateDoc,
    arrayUnion,
    arrayRemove,
    // Storage
    ref,
    uploadBytes,
    getDownloadURL,
    deleteObject
};
