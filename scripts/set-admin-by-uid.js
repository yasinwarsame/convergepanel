/**
 * CLASSIFICATION: MINTS-AUTHORITY (legacy service-account tool).
 *
 * DO NOT USE. This script is NOT part of the interim admin-claim path in
 * docs/operations/admin-authority-tiers.md ("Interim path for an `admin` claim
 * change"). It GRANTS SYSTEM_ADMIN. `setCustomUserClaims` writes the account's
 * whole custom-claim object, and this script spreads the existing claims AFTER
 * the keys it sets, so an existing `admin` value silently wins over the grant
 * while the script reports success. It is not a liveness probe of any kind.
 *
 * Until the hardened operator CLI (PR #295) merges, an emergency `admin` claim
 * change is an OWNER action, never an agent action: the owner runs the reviewed
 * SYSTEM_ADMIN claim operator tool scripts/admin/set-system-admin-claim.ts
 * (PR #295 at its exact reviewed commit f6039ea) locally, dry run first and then
 * a typed confirmation, with no Production run without separate authorization.
 * The result is verified with the read-only `scripts/check-admin-claims.js` or
 * `scripts/verify-admin-claims.js`. This file is retained only until its
 * deletion in security slice S5.
 *
 * Quick script to set admin custom claims for a user by UID
 * 
 * Usage:
 *   node scripts/set-admin-by-uid.js <UID>
 * 
 * Example:
 *   node scripts/set-admin-by-uid.js vdgv3a3otBYh0UkXpbhzBOrUcN33
 * 
 * This will:
 * 1. Set Firebase custom claims { admin: true }
 * 2. Update Firestore users/{uid} with role: "admin"
 * 
 * After running, the user MUST sign out and sign back in for the claims to take effect.
 */

// Load environment variables
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'convergepanel';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error('❌ Missing Firebase Admin credentials. Required:');
    console.error('   FIREBASE_CLIENT_EMAIL');
    console.error('   FIREBASE_PRIVATE_KEY');
    console.error('\nGet these from Firebase Console > Project Settings > Service Accounts > Generate new private key');
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

async function main() {
  try {
    const uid = process.argv[2];
    
    if (!uid) {
      console.error('❌ UID is required');
      console.error('Usage: node scripts/set-admin-by-uid.js <UID>');
      console.error('Example: node scripts/set-admin-by-uid.js vdgv3a3otBYh0UkXpbhzBOrUcN33');
      process.exit(1);
    }

    console.log(`🔎 Looking up user by UID: ${uid}...`);

    const auth = admin.auth();
    const db = admin.firestore();

    // Get user by UID
    let user;
    try {
      user = await auth.getUser(uid);
    } catch (error) {
      console.error(`❌ Failed to find user with UID ${uid}:`, error.message);
      console.error('\n💡 Tips:');
      console.error('   - Make sure the UID is correct');
      console.error('   - Check that the user exists in Firebase Authentication');
      process.exit(1);
    }

    console.log(`✅ Found user:`);
    console.log(`   UID: ${user.uid}`);
    console.log(`   Email: ${user.email || '(no email)'}`);
    console.log(`   Current claims:`, user.customClaims || '(none)');

    // Set custom claims
    console.log('\n🔐 Setting custom claims { admin: true }...');
    await auth.setCustomUserClaims(uid, { 
      admin: true,
      ...user.customClaims, // Preserve existing claims
    });

    // Update Firestore user document
    console.log('📝 Updating Firestore users/{uid}...');
    await db.collection('users').doc(uid).set(
      {
        role: 'admin',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log('\n🎉 Success! Admin privileges set:');
    console.log(`   ✅ Custom claims: { admin: true }`);
    console.log(`   ✅ Firestore users/${uid}: { role: "admin" }`);

    console.log('\n⚠️  IMPORTANT: The user must sign out and sign back in for the admin claim to take effect.');
    console.log('   The ID token is cached client-side and won\'t refresh until the user re-authenticates.');
    console.log('\n   Steps:');
    console.log('   1. Sign out in the app');
    console.log('   2. Clear browser cookies/local storage (optional but recommended)');
    console.log('   3. Sign back in');
    console.log('   4. Admin features should now be available');

    // Verify claims were set
    const updatedUser = await auth.getUser(uid);
    console.log('\n✅ Verification: Current custom claims:', updatedUser.customClaims);

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to set admin:', error);
    process.exit(1);
  }
}

main();

