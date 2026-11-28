-- Pond no longer records what is typed as a username. Remove it from earlier failed sign-ins and
-- lockouts that weren't for an account: it may be a password typed in the wrong box. The time
-- and address stay. Entries for a real account (target_id set) are left as they are.
UPDATE `audit_log` SET `meta` = json_remove(`meta`, '$.username') WHERE `action` IN ('auth.login_failed', 'auth.lockout') AND `target_id` IS NULL AND json_valid(`meta`);
--> statement-breakpoint
-- Changing a row can leave the old text in unused parts of the file, which backups would copy.
-- Pond rebuilds the file at the next start when it sees this, then removes it.
INSERT OR REPLACE INTO `settings` (`scope`, `scope_id`, `key`, `value`) VALUES ('global', '', 'system.compactNeeded', 'true');
