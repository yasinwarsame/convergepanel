/**
 * READ-ONLY: verify one user's admin custom claim.
 *
 * This is the same tool as scripts/check-admin-claims.js and takes the same
 * required arguments (no default user, no default project, no .env.local):
 *
 *   node scripts/verify-admin-claims.js \
 *     --confirm-project=<projectId> \
 *     --credentials=<service-account key file, mode 0600> \
 *     --uid=<uid>
 *
 * It never writes anything.
 */

const { runAsCli } = require("./check-admin-claims.js");

if (require.main === module) {
  runAsCli(process.argv.slice(2), process.env);
}
