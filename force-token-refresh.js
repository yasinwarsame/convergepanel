/**
 * Browser Console Script to Force Token Refresh
 * 
 * Copy and paste this into your browser console while logged into ConvergePanel
 * to force refresh your ID token and get the new admin claim.
 * 
 * This will:
 * 1. Force refresh the Firebase ID token
 * 2. Log the token claims to verify admin status
 * 3. Reload the page to use the new token
 */

(async function() {
  try {
    // Import Firebase Auth (adjust path if needed)
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
    
    // Get current user
    const auth = getAuth();
    const user = auth.currentUser;
    
    if (!user) {
      console.log('❌ No user logged in. Please sign in first.');
      return;
    }
    
    console.log('🔄 Forcing ID token refresh...');
    
    // Force refresh the token (true = force refresh)
    const token = await user.getIdToken(true);
    const tokenResult = await user.getIdTokenResult(true);
    
    console.log('✅ Token refreshed!');
    console.log('📋 Token claims:', tokenResult.claims);
    console.log('🔐 Admin claim:', tokenResult.claims.admin);
    
    if (tokenResult.claims.admin) {
      console.log('✅ Admin claim is present! Refreshing page...');
      window.location.reload();
    } else {
      console.log('⚠️ Admin claim not found. Make sure you ran the set-admin script and wait a moment, then try again.');
    }
  } catch (error) {
    console.error('❌ Error refreshing token:', error);
    console.log('💡 Try signing out and signing back in instead.');
  }
})();

