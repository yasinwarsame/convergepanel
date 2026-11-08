/**
 * CLASSIFICATION: MINTS-AUTHORITY (legacy service-account tool).
 *
 * DO NOT USE. This script is NOT part of the interim admin-claim path in
 * docs/operations/admin-authority-tiers.md ("Interim path for an `admin` claim
 * change"). It GRANTS SYSTEM_ADMIN. `setCustomUserClaims` writes the account's
 * whole custom-claim object, and this script writes `{ admin: true }` alone, so
 * running it silently drops every other claim the account holds. It is not a
 * liveness probe of any kind.
 *
 * Until the hardened operator CLI (PR #295) merges, an emergency `admin` claim
 * change is an OWNER action in the Firebase Console, never an agent action, and
 * is verified with the read-only `scripts/check-admin-claims.js` or
 * `scripts/verify-admin-claims.js`. This file is retained only until its
 * deletion in security slice S5.
 *
 * Simple script to set admin custom claims
 * Based on user's preferred structure
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'convergepanel';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error('❌ Missing Firebase Admin credentials. Required:');
    console.error('   FIREBASE_CLIENT_EMAIL');
    console.error('   FIREBASE_PRIVATE_KEY');
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
    await admin.auth().setCustomUserClaims(ADMIN_UID, { admin: true });
    console.log(`✅ Set admin claim for ${ADMIN_UID}`);
    
    // Verify it was set
    const user = await admin.auth().getUser(ADMIN_UID);
    console.log(`✅ Verification: Current claims:`, user.customClaims);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

