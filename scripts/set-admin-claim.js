/**
 * Quick script to set admin custom claims for a user by email or UID
 * 
 * Usage:
 *   node scripts/set-admin-claim.js
 * 
 * This will:
 * 1. Look up user by email: ywarsame@convergepanel.com
 * 2. Set Firebase custom claims { admin: true, role: "admin" }
 * 3. Update Firestore users/{uid} with role: "admin", isAdmin: true
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
    const email = 'ywarsame@convergepanel.com';
    console.log(`🔎 Looking up user by email: ${email}...`);

    const auth = admin.auth();
    const db = admin.firestore();

    // Get user by email
    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch (error) {
      console.error(`❌ Failed to find user with email ${email}:`, error.message);
      console.error('\n💡 Tips:');
      console.error('   - Make sure the user exists in Firebase Authentication');
      console.error('   - Check the email spelling');
      console.error('   - If you have the UID instead, modify this script to use getUser(uid)');
      process.exit(1);
    }

    const uid = user.uid;
    console.log(`✅ Found user:`);
    console.log(`   UID: ${uid}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Current claims:`, user.customClaims || '(none)');

    // Set custom claims
    console.log('\n🔐 Setting custom claims { admin: true, role: "admin" }...');
    await auth.setCustomUserClaims(uid, { 
      admin: true,
      role: 'admin',
      ...user.customClaims, // Preserve existing claims
    });

    // Update Firestore user document
    console.log('📝 Updating Firestore users/{uid}...');
    await db.collection('users').doc(uid).set(
      {
        role: 'admin',
        isAdmin: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log('\n🎉 Success! Admin privileges set:');
    console.log(`   ✅ Custom claims: { admin: true, role: "admin" }`);
    console.log(`   ✅ Firestore users/${uid}: { role: "admin", isAdmin: true }`);

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

