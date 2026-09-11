import type { LucideIcon } from 'lucide-react';

export type SectionId = 'admin' | 'teachers' | 'students' | 'video';

export type Stat = {
  label: string;
  value: string;
  trend: string;
};

export type ActionItem = {
  title: string;
  detail: string;
  icon: LucideIcon;
};
