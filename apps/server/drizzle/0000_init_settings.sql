CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`scope`, `scope_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `settings_key_idx` ON `settings` (`key`);