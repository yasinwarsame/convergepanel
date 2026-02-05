/**
 * Verify admin custom claims for a user
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'convergepanel';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error('❌ Missing Firebase Admin credentials');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    projectId,
  });
}

const ADMIN_UID = "vdgv3a3otBYh0UkXpbhzBOrUcN33";

async function main() {
  try {
    const u = await admin.auth().getUser(ADMIN_UID);
    console.log("customClaims:", u.customClaims); // should show { admin: true }
    console.log(`\n✅ Admin claim present: ${u.customClaims?.admin === true ? 'YES' : 'NO'}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

