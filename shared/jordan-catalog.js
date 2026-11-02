const buildCategory = ({ id, name, description, icon, levelSubjects }) => ({
  id,
  name,
  description,
  icon,
  levels: Object.keys(levelSubjects),
  subjects: [...new Set(Object.values(levelSubjects).flat())],
  levelSubjects,
});

const sameSubjects = (levels, subjects) => Object.fromEntries(levels.map(level => [level, subjects]));

const jordanEarlySubjects = ['اللغة العربية', 'اللغة الإنجليزية', 'الرياضيات', 'العلوم', 'التربية الإسلامية', 'التربية الاجتماعية والوطنية'];
const jordanMiddleSubjects = [...jordanEarlySubjects, 'التربية المهنية', 'المهارات الرقمية'];
const jordanUpperSubjects = ['اللغة العربية', 'اللغة الإنجليزية', 'الرياضيات', 'الفيزياء', 'الكيمياء', 'العلوم الحياتية', 'التربية الإسلامية', 'تاريخ الأردن', 'الجغرافيا', 'التربية الوطنية والمدنية', 'المهارات الرقمية', 'التربية المهنية'];

const cambridgePrimarySubjects = ['اللغة الإنجليزية', 'اللغة الإنجليزية كلغة ثانية', 'الرياضيات', 'العلوم', 'الحوسبة', 'المنظورات العالمية', 'الفن والتصميم', 'الموسيقى', 'التربية البدنية', 'الرفاه', 'اللغة العربية', 'التربية الإسلامية'];
const cambridgeLowerSubjects = ['اللغة الإنجليزية', 'اللغة الإنجليزية كلغة ثانية', 'الرياضيات', 'العلوم', 'الحوسبة', 'المواطنة الرقمية', 'المنظورات العالمية', 'الفن والتصميم', 'الموسيقى', 'التربية البدنية', 'الرفاه', 'اللغة العربية', 'التربية الإسلامية'];
const igcseSubjects = ['اللغة الإنجليزية – اللغة الأولى', 'اللغة الإنجليزية – اللغة الثانية', 'الأدب الإنجليزي', 'الرياضيات', 'الرياضيات الإضافية', 'الأحياء', 'الكيمياء', 'الفيزياء', 'العلوم المدمجة', 'علوم الحاسوب', 'تقنية المعلومات والاتصالات (ICT)', 'المحاسبة', 'إدارة الأعمال', 'الاقتصاد', 'الجغرافيا', 'التاريخ', 'علم الاجتماع', 'علم النفس', 'المنظورات العالمية', 'اللغة العربية – اللغة الأولى', 'اللغة العربية – اللغة الثانية', 'التربية الإسلامية'];
const advancedSubjects = ['الرياضيات', 'الرياضيات المتقدمة', 'الأحياء', 'الكيمياء', 'الفيزياء', 'علوم الحاسوب', 'تقنية المعلومات', 'المحاسبة', 'إدارة الأعمال', 'الاقتصاد', 'اللغة الإنجليزية', 'الأدب الإنجليزي', 'الجغرافيا', 'التاريخ', 'علم الاجتماع', 'علم النفس', 'القانون', 'التفكير النقدي', 'المنظورات العالمية والبحث', 'اللغة العربية'];

export const educationCatalog = [
  buildCategory({
    id: 'jordan-basic',
    name: 'المنهاج الأردني | الأساسي',
    description: 'الصفوف من الأول حتى السادس وفق المنهاج الأردني',
    icon: '🇯🇴',
    levelSubjects: {
      ...sameSubjects(['الصف الأول', 'الصف الثاني', 'الصف الثالث'], jordanEarlySubjects),
      ...sameSubjects(['الصف الرابع', 'الصف الخامس', 'الصف السادس'], jordanMiddleSubjects),
    },
  }),
  buildCategory({
    id: 'jordan-preparatory',
    name: 'المنهاج الأردني | الإعدادي',
    description: 'الصفوف من السابع حتى العاشر وفق المنهاج الأردني',
    icon: '📗',
    levelSubjects: {
      ...sameSubjects(['الصف السابع', 'الصف الثامن'], jordanMiddleSubjects),
      ...sameSubjects(['الصف التاسع', 'الصف العاشر'], jordanUpperSubjects),
    },
  }),
  buildCategory({
    id: 'jordan-tawjihi',
    name: 'المنهاج الأردني | الثانوي الجديد',
    description: 'الصفان الحادي عشر والثاني عشر والحقول الأكاديمية الجديدة',
    icon: '🎓',
    levelSubjects: {
      'الصف الحادي عشر – المسار الأكاديمي': ['التربية الإسلامية', 'اللغة العربية', 'اللغة الإنجليزية', 'تاريخ الأردن', 'الرياضيات', 'الفيزياء', 'الكيمياء', 'العلوم الحياتية'],
      'الصف الثاني عشر – الحقل الصحي': ['الكيمياء', 'العلوم الحياتية', 'اللغة الإنجليزية المتقدمة', 'المهارات الرقمية'],
      'الصف الثاني عشر – الحقل الهندسي': ['الرياضيات', 'الفيزياء', 'الكيمياء', 'المهارات الرقمية'],
      'الصف الثاني عشر – حقل العلوم والتكنولوجيا': ['الرياضيات', 'الفيزياء', 'الكيمياء', 'العلوم الحياتية', 'المهارات الرقمية'],
      'الصف الثاني عشر – حقل اللغات والعلوم الاجتماعية': ['اللغة العربية تخصص', 'اللغة الإنجليزية المتقدمة', 'التاريخ', 'الجغرافيا', 'علم الاجتماع', 'المهارات الرقمية'],
      'الصف الثاني عشر – حقل القانون والعلوم الشرعية': ['اللغة العربية تخصص', 'التربية الإسلامية تخصص', 'التاريخ', 'الجغرافيا', 'المهارات الرقمية'],
      'الصف الثاني عشر – حقل الأعمال': ['رياضيات الأعمال', 'الثقافة المالية', 'اللغة الإنجليزية المتقدمة', 'المحاسبة', 'إدارة الأعمال', 'المهارات الرقمية'],
    },
  }),
  buildCategory({
    id: 'cambridge-primary',
    name: 'البريطاني والدولي | Cambridge Primary',
    description: 'المرحلة الابتدائية الدولية من Year 1 إلى Year 6',
    icon: '🌍',
    levelSubjects: sameSubjects(['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5', 'Year 6'], cambridgePrimarySubjects),
  }),
  buildCategory({
    id: 'cambridge-lower-secondary',
    name: 'البريطاني والدولي | Lower Secondary',
    description: 'المرحلة المتوسطة الدولية من Year 7 إلى Year 9',
    icon: '📘',
    levelSubjects: sameSubjects(['Year 7', 'Year 8', 'Year 9'], cambridgeLowerSubjects),
  }),
  buildCategory({
    id: 'cambridge-upper-secondary',
    name: 'البريطاني والدولي | IGCSE / O Level',
    description: 'Cambridge Upper Secondary للصفين Year 10 وYear 11',
    icon: '📚',
    levelSubjects: sameSubjects(['Year 10', 'Year 11'], igcseSubjects),
  }),
  buildCategory({
    id: 'cambridge-advanced',
    name: 'البريطاني والدولي | AS & A Level',
    description: 'Cambridge Advanced للصفين Year 12 وYear 13',
    icon: '⭐',
    levelSubjects: sameSubjects(['Year 12 – AS Level', 'Year 13 – A Level'], advancedSubjects),
  }),
];

// Kept as an alias for older imports and deployments.
export const jordanCatalog = educationCatalog;
