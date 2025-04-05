const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

const firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
    credential: admin.credential.cert(firebaseCredentials),
    databaseURL: `https://${firebaseCredentials.project_id}.firebaseio.com`,
});

const db = admin.firestore();

module.exports = { db };