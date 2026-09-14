ALTER TABLE `users` ADD `must_change_password` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `temporary_password_expires` integer;