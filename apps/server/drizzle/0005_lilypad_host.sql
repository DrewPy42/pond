CREATE TABLE `lilypad_installs` (
	`pad_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`tier` text DEFAULT 'official' NOT NULL,
	`permissions_granted` text NOT NULL,
	`installed_by` text NOT NULL,
	`installed_at` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`installed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lilypad_job_runs` (
	`pad_id` text NOT NULL,
	`job_name` text NOT NULL,
	`space_id` text NOT NULL,
	`last_run_at` text NOT NULL,
	PRIMARY KEY(`pad_id`, `job_name`, `space_id`)
);
--> statement-breakpoint
CREATE TABLE `lilypad_migrations` (
	`pad_id` text NOT NULL,
	`name` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`pad_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `lilypad_space_enablement` (
	`pad_id` text NOT NULL,
	`space_id` text NOT NULL,
	`enabled_by` text NOT NULL,
	`enabled_at` text NOT NULL,
	PRIMARY KEY(`pad_id`, `space_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enabled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lilypad_enablement_space_idx` ON `lilypad_space_enablement` (`space_id`);