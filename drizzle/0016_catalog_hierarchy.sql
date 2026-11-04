ALTER TABLE catalog ADD COLUMN level_subjects TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
INSERT OR IGNORE INTO catalog (id,kind,parent_id,name,description,icon,position,levels,subjects,level_subjects,created) VALUES
('curriculum-jordan','group','','المنهاج الأردني','الأساسي والإعدادي والثانوي وفق النظام الجديد','🇯🇴',0,'[]','[]','{}',0),
('curriculum-international','group','','المنهاج البريطاني والدولي','Cambridge Primary وIGCSE وAS & A Level','🌍',1,'[]','[]','{}',0),
('curriculum-other','group','','مجالات تعليمية أخرى','التصنيفات الإضافية التي أعدّتها الإدارة','✨',2,'[]','[]','{}',0);
--> statement-breakpoint
UPDATE catalog SET parent_id='curriculum-jordan' WHERE kind='category' AND (id='jordan' OR id LIKE 'jordan-%');
--> statement-breakpoint
UPDATE catalog SET parent_id='curriculum-international' WHERE kind='category' AND id LIKE 'cambridge-%';
--> statement-breakpoint
UPDATE catalog SET parent_id='curriculum-other' WHERE kind='category' AND parent_id='';
