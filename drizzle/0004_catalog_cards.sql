ALTER TABLE catalog ADD description text NOT NULL DEFAULT '';
ALTER TABLE catalog ADD icon text NOT NULL DEFAULT '';
ALTER TABLE catalog ADD position integer NOT NULL DEFAULT 0;
ALTER TABLE catalog ADD levels text NOT NULL DEFAULT '[]';
ALTER TABLE catalog ADD subjects text NOT NULL DEFAULT '[]';
INSERT OR IGNORE INTO catalog (id,kind,name,description,icon,position,levels,subjects,created) VALUES
('jordan','category','المنهاج الأردني','توجيهي وجميع الصفوف المدرسية','📚',0,'["توجيهي","الصف العاشر","الصف التاسع","الصف الثامن","الصف السابع","المرحلة الأساسية"]','["رياضيات","فيزياء","كيمياء","عربي","إنجليزي","أحياء"]',0),
('quran','category','تحفيظ القرآن الكريم','تلاوة، حفظ، وتجويد','☘',1,'[]','["تلاوة","حفظ","تجويد"]',0),
('reading','category','تعليم القراءة والكتابة','تأسيس عربي للأطفال والكبار','✍',2,'[]','["القراءة","الكتابة"]',0),
('english','category','اللغة الإنجليزية','محادثة، مدرسة، واختبارات','EN',3,'[]','["محادثة","إنجليزي","التحضير للاختبارات"]',0),
('university','category','المواد الجامعية','مساندة جامعية متخصصة','🎓',4,'[]','["رياضيات","فيزياء","كيمياء","برمجة"]',0),
('skills','category','مهارات ودورات أخرى','مهارات عملية ودورات قصيرة','✨',5,'[]','["مهارات الحاسوب","مهارات التواصل"]',0);
