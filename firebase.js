const {initializeApp, cert} = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

let serviceAccount = require('./credentials.json')

initializeApp({
    credential: cert(serviceAccount)
})

const db = getFirestore()

module.exports = { db }