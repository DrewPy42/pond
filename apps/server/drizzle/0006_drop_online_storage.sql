-- Online backups through rclone were removed (docs/simple-setup-design.md). These two settings
-- held the sign-in details (encrypted) and the folder; nothing reads them any more.
DELETE FROM `settings` WHERE `key` IN ('backup.remote', 'backup.remoteInfo');
