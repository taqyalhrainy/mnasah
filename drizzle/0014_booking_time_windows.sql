ALTER TABLE bookings ADD COLUMN start INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN minutes INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN price INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bookings ADD COLUMN subject TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE bookings
SET start = COALESCE((SELECT slots.start FROM slots WHERE slots.id = bookings.slot_id), 0),
    minutes = COALESCE((SELECT slots.minutes FROM slots WHERE slots.id = bookings.slot_id), 0),
    price = COALESCE((SELECT slots.price FROM slots WHERE slots.id = bookings.slot_id), 0),
    subject = COALESCE((SELECT slots.subject FROM slots WHERE slots.id = bookings.slot_id), '');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bookings_slot_start ON bookings (slot_id, start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bookings_student_start ON bookings (student_id, start);
