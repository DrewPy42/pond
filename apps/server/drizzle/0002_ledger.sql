CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`institution_name` text,
	`name` text NOT NULL,
	`nickname` text,
	`type` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`primary_space_id` text,
	`is_manual` integer DEFAULT true NOT NULL,
	`include_in_net_worth` integer DEFAULT true NOT NULL,
	`sync_enabled` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`last_four` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`primary_space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_space_idx` ON `accounts` (`primary_space_id`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`available_cents` integer,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_account_date_unique` ON `balance_snapshots` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`tax_line` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `categories_space_idx` ON `categories` (`space_id`);--> statement-breakpoint
CREATE TABLE `splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`space_id` text NOT NULL,
	`category_id` text,
	`amount_cents` integer NOT NULL,
	`memo` text,
	`reimbursable` integer DEFAULT false NOT NULL,
	`reimbursed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `splits_txn_idx` ON `splits` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `splits_space_idx` ON `splits` (`space_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`posted_at` text,
	`transacted_at` text,
	`amount_cents` integer NOT NULL,
	`description_raw` text NOT NULL,
	`payee` text,
	`memo` text,
	`pending` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_external_unique` ON `transactions` (`account_id`,`external_id`) WHERE "transactions"."external_id" is not null;--> statement-breakpoint
CREATE TABLE `transfer_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_transaction_id` text NOT NULL,
	`to_transaction_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`from_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_links_from_unique` ON `transfer_links` (`from_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_links_to_unique` ON `transfer_links` (`to_transaction_id`);