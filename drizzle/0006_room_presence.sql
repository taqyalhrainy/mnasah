ALTER TABLE bookings ADD COLUMN teacher_present_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN student_present_until INTEGER NOT NULL DEFAULT 0;
