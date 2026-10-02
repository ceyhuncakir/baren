-- baren-server schema v3: drop `device_codes`.
--
-- The table backed the browser-approval sign-in, which was removed: accounts sign in with
-- email + password only, so nothing reads or writes it any more. 0001_init.sql still creates
-- it because applied migrations are never edited (sqlx checks their checksums on existing
-- databases). Dropping the table also drops its index, `device_codes_expiry`.
DROP TABLE IF EXISTS device_codes;
