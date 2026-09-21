ALTER TABLE `users` ADD `academic_level` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_transactions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL,
  `amount` integer NOT NULL,
  `reference` text DEFAULT '' NOT NULL,
  `created` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wallet_transactions_user_created` ON `wallet_transactions` (`user_id`,`created`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ratings` (
  `id` text PRIMARY KEY NOT NULL,
  `booking_id` text NOT NULL,
  `student_id` text NOT NULL,
  `teacher_id` text NOT NULL,
  `rating` integer NOT NULL,
  `review` text DEFAULT '' NOT NULL,
  `created` integer NOT NULL,
  FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rating_booking_student` ON `ratings` (`booking_id`,`student_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `catalog` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `parent_id` text DEFAULT '' NOT NULL,
  `name` text NOT NULL,
  `created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payouts` (
  `id` text PRIMARY KEY NOT NULL,
  `teacher_id` text NOT NULL,
  `period_start` integer NOT NULL,
  `period_end` integer NOT NULL,
  `amount` integer NOT NULL,
  `status` text NOT NULL,
  `paid_at` integer,
  `created` integer NOT NULL,
  FOREIGN KEY (`teacher_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
