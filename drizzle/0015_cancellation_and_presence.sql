ALTER TABLE bookings ADD COLUMN cancelled_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN cancelled_by TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN refund_amount INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN teacher_compensation INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN platform_fee INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN teacher_joined_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN student_joined_at INTEGER NOT NULL DEFAULT 0;
