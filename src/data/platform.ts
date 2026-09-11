import {
  Banknote,
  BookOpenCheck,
  CalendarCheck,
  ChartNoAxesColumnIncreasing,
  GraduationCap,
  ShieldCheck,
  UserCheck,
  Video,
} from 'lucide-react';
import type { ActionItem, Stat } from '../app/types';

export const adminStats: Stat[] = [
  { label: 'الأساتذة المقبولين', value: '48', trend: '+6 هذا الأسبوع' },
  { label: 'الطلاب النشطين', value: '1,284', trend: '+18%' },
  { label: 'الحصص المكتملة', value: '3,912', trend: '97% بدون مشاكل' },
  { label: 'الإيراد الشهري', value: 'JD 18.4K', trend: '+12.5%' },
];

export const teacherStats: Stat[] = [
  { label: 'حصص اليوم', value: '7', trend: '3 مباشرة' },
  { label: 'متوسط التقييم', value: '4.9', trend: 'من 312 طالب' },
  { label: 'طلبات جديدة', value: '14', trend: 'تحتاج رد' },
];

export const studentStats: Stat[] = [
  { label: 'حصصي القادمة', value: '5', trend: 'هذا الأسبوع' },
  { label: 'الخطة الدراسية', value: '82%', trend: 'إنجاز' },
  { label: 'أساتذتي', value: '4', trend: 'مواد مختلفة' },
];

export const adminActions: ActionItem[] = [
  {
    title: 'مراجعة طلبات الأساتذة',
    detail: 'توثيق الهوية، الخبرة، المواد، وسعر الساعة قبل ظهور الأستاذ للطلاب.',
    icon: ShieldCheck,
  },
  {
    title: 'مراقبة جودة الحصص',
    detail: 'مؤشرات الاتصال، تقييمات الطلاب، البلاغات، ونسب إكمال الجلسات.',
    icon: ChartNoAxesColumnIncreasing,
  },
  {
    title: 'إدارة المدفوعات',
    detail: 'عمولات المنصة، مستحقات الأساتذة، فواتير الطلاب، وسجل العمليات.',
    icon: Banknote,
  },
];

export const teacherActions: ActionItem[] = [
  {
    title: 'جدول الحصص',
    detail: 'تنظيم المواعيد، قبول الحجوزات، وتحديد أوقات التوفر.',
    icon: CalendarCheck,
  },
  {
    title: 'إدارة الطلاب',
    detail: 'متابعة تقدم كل طالب، الملفات، الواجبات، والملاحظات الخاصة.',
    icon: UserCheck,
  },
  {
    title: 'دخول الحصة المباشرة',
    detail: 'مكالمة فيديو عالية الجودة مع تحكم بالكاميرا والمايك والمشاركة.',
    icon: Video,
  },
];

export const studentActions: ActionItem[] = [
  {
    title: 'اختيار أستاذ',
    detail: 'فلترة حسب المادة، السعر، التقييم، اللهجة، وأوقات التوفر.',
    icon: GraduationCap,
  },
  {
    title: 'متابعة التعلم',
    detail: 'خطة واضحة لكل مادة مع واجبات وملخصات بعد كل حصة.',
    icon: BookOpenCheck,
  },
  {
    title: 'دخول الحصة',
    detail: 'غرفة مباشرة مع الأستاذ، ملاحظات، وتسجيل حضور الجلسة.',
    icon: Video,
  },
];
