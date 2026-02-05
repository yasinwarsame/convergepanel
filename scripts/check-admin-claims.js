/**
 * Script to check current admin custom claims for a user
 * 
 * Usage:
 *   node scripts/check-admin-claims.js <UID>
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

const admin = require('firebase-admin');

// Initialize Firebase Admin
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

async function main() {
  try {
    const uid = process.argv[2] || 'vdgv3a3otBYh0UkXpbhzBOrUcN33';
    
    console.log(`🔍 Checking custom claims for UID: ${uid}...\n`);

    const auth = admin.auth();
    const user = await auth.getUser(uid);

    console.log(`✅ User found:`);
    console.log(`   Email: ${user.email || '(no email)'}`);
    console.log(`   UID: ${user.uid}\n`);
    
    console.log(`📋 Current custom claims:`);
    if (user.customClaims && Object.keys(user.customClaims).length > 0) {
      console.log(JSON.stringify(user.customClaims, null, 2));
      console.log(`\n🔐 Admin claim: ${user.customClaims.admin === true ? '✅ TRUE' : '❌ FALSE or missing'}`);
    } else {
      console.log('   (no custom claims set)');
      console.log(`\n🔐 Admin claim: ❌ NOT SET`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

