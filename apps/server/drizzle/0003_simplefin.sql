CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`access_url_enc` text,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `connection_id` text REFERENCES connections(id);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_connection_external_unique` ON `accounts` (`connection_id`,`external_id`) WHERE "accounts"."external_id" is not null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `user_edited` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `superseded_by` text;