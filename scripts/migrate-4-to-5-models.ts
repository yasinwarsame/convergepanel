/**
 * Admin Script: Migrate All Users from Legacy Model Caps (2/4) to New Caps (3/5)
 * 
 * This script migrates all existing users with legacy maxModelsPerRun values:
 * - maxModelsPerRun: 2 → 3
 * - maxModelsPerRun: 4 → 5
 * 
 * Usage:
 *   npx tsx scripts/migrate-4-to-5-models.ts
 * 
 * Or in Node.js:
 *   node -r ts-node/register scripts/migrate-4-to-5-models.ts
 * 
 * WARNING: This queries all users in Firestore. Use with caution in production.
 * Consider running in batches if you have many users.
 */

import { migrateAllUsersToNewModelCaps } from "../lib/migrations/migrate4To5Models";

async function main() {
  console.log("Starting migration of all users from legacy model caps (2/4) to new caps (3/5)...");
  console.log("This may take a while depending on the number of users.");
  
  try {
    const migratedCount = await migrateAllUsersToNewModelCaps();
    console.log(`\n✅ Migration complete! Migrated ${migratedCount} users.`);
    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run the migration
main();

