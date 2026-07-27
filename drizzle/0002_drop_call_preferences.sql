-- Remove deprecated call preferences feature.
-- Apply with: npm run db:migrate

DROP INDEX IF EXISTS call_preferences_phone_unique;
DROP TABLE IF EXISTS call_preferences;
