-- Demo data. Run ONCE, after schema.sql. Sessions are generated for the next 7 days.

insert into public.branches (branch_name, address, phone_number) values
  ('Downtown',  '12 Abay Ave, Almaty',   '+77270000001'),
  ('Riverside', '85 Dostyk Ave, Almaty', '+77270000002');

insert into public.rooms (branch_id, room_name, max_capacity) values
  (1, 'Studio A',  25),
  (1, 'Studio B',  15),
  (2, 'Main Hall', 30);

insert into public.trainers (trainer_name, phone, email) values
  ('Aigerim S.', '+77010000011', 'aigerim@pulsegym.example'),
  ('Daniyar K.', '+77010000012', 'daniyar@pulsegym.example'),
  ('Elena P.',   '+77010000013', 'elena@pulsegym.example');

insert into public.classes (class_name, description, duration_min) values
  ('Yoga',     'Slow flow focused on flexibility, balance and breathing.', 60),
  ('Pilates',  'Core strength and posture, low impact.',                   55),
  ('HIIT',     'High-intensity intervals. Bring water and a towel.',       45),
  ('Spinning', 'Indoor cycling set to music, all levels.',                 45),
  ('Zumba',    'Dance-based cardio workout.',                              60);

insert into public.readers (reader_id, branch_id, location_note) values
  ('NFC-DT-01', 1, 'Downtown front desk'),
  ('NFC-RS-01', 2, 'Riverside entrance');

-- Sessions for each of the next 7 days (times are Asia/Almaty)
do $$
declare d int;
begin
  for d in 1..7 loop
    insert into public.class_sessions (class_id, trainer_id, branch_id, room_id, start_time, end_time, capacity) values
      (1, 1, 1, 1, ((current_date + d) + time '10:00') at time zone 'Asia/Almaty', ((current_date + d) + time '11:00') at time zone 'Asia/Almaty', 20),
      (2, 2, 1, 1, ((current_date + d) + time '18:00') at time zone 'Asia/Almaty', ((current_date + d) + time '18:55') at time zone 'Asia/Almaty', 15),
      (3, 3, 1, 2, ((current_date + d) + time '12:00') at time zone 'Asia/Almaty', ((current_date + d) + time '12:45') at time zone 'Asia/Almaty', 12),
      (4, 3, 1, 2, ((current_date + d) + time '19:00') at time zone 'Asia/Almaty', ((current_date + d) + time '19:45') at time zone 'Asia/Almaty', 10),
      (5, 2, 2, 3, ((current_date + d) + time '09:00') at time zone 'Asia/Almaty', ((current_date + d) + time '10:00') at time zone 'Asia/Almaty', 25),
      (1, 1, 2, 3, ((current_date + d) + time '17:30') at time zone 'Asia/Almaty', ((current_date + d) + time '18:30') at time zone 'Asia/Almaty', 25);
  end loop;
end $$;

-- After you register in the app, make yourself Admin (use your phone as stored, e.g. +77011234567):
--   update public.members set role = 'Admin' where phone_number = '+77011234567';
-- After that, assign Trainer/Admin roles from the app: Admin panel -> Members.
