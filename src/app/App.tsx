import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  GraduationCap,
  LayoutDashboard,
  LogIn,
  MonitorPlay,
  Search,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react';
import { SectionId } from './types';
import { DashboardSection } from '../components/DashboardSection';
import { VideoRoom } from '../features/video/VideoRoom';
import {
  adminActions,
  adminStats,
  studentActions,
  studentStats,
  teacherActions,
  teacherStats,
} from '../data/platform';

const navItems: Array<{ id: Exclude<SectionId, 'video'>; href: string; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'admin', href: '/admin', label: 'الأدمن والأونر', icon: Shield },
  { id: 'teachers', href: '/teachers', label: 'الأساتذة', icon: Users },
  { id: 'students', href: '/students', label: 'الطلاب', icon: GraduationCap },
];

const routeToSection: Record<string, SectionId> = {
  '/': 'admin',
  '/admin': 'admin',
  '/teachers': 'teachers',
  '/students': 'students',
  '/video': 'video',
};

function getSectionFromPath(pathname: string): SectionId {
  return routeToSection[pathname] ?? 'admin';
}

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(() => getSectionFromPath(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setActiveSection(getSectionFromPath(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (href: string) => {
    window.history.pushState({}, '', href);
    setActiveSection(getSectionFromPath(href));
  };

  const sectionTitle = useMemo(() => {
    if (activeSection === 'video') return 'مكالمة الفيديو';
    return navItems.find((item) => item.id === activeSection)?.label ?? 'المنصة';
  }, [activeSection]);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="أقسام المنصة">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={20} />
          </div>
          <div>
            <strong>Mansah</strong>
            <span>تعليم خصوصي مباشر</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                className={activeSection === item.id ? 'nav-button active' : 'nav-button'}
                href={item.href}
                key={item.id}
                onClick={(event) => {
                  event.preventDefault();
                  navigateTo(item.href);
                }}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="sidebar-card">
          <MonitorPlay size={22} />
          <strong>جلسة تجريب الاتصال</strong>
          <p>افتح نفس رقم الغرفة من جهازين، واحد أستاذ وواحد طالب، لتجربة الاتصال الحقيقي.</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">لوحة بناء المنتج</span>
            <h1>{sectionTitle}</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={18} />
              <input placeholder="ابحث عن طالب، أستاذ، أو حصة" />
            </label>
            <button className="primary-button" type="button" onClick={() => navigateTo('/video')}>
              <LogIn size={18} />
              دخول حصة
            </button>
          </div>
        </header>

        {activeSection === 'admin' && (
          <DashboardSection
            accent="ink"
            actions={adminActions}
            ctaIcon={BarChart3}
            ctaText="فتح مركز التحكم"
            imageUrl="https://images.unsplash.com/photo-1553877522-43269d4ea984?auto=format&fit=crop&w=900&q=80"
            intro="هنا يبدأ التحكم الحقيقي بالمنصة: قبول الأساتذة، متابعة الجودة، المدفوعات، الصلاحيات، والبلاغات."
            stats={adminStats}
            title="مركز الأونر والأدمن"
          />
        )}

        {activeSection === 'teachers' && (
          <DashboardSection
            accent="green"
            actions={teacherActions}
            ctaIcon={CalendarDays}
            ctaText="إدارة جدول الأستاذ"
            imageUrl="https://images.unsplash.com/photo-1544717305-2782549b5136?auto=format&fit=crop&w=900&q=80"
            intro="مساحة الأستاذ لإدارة الحجوزات، تجهيز المواد، دخول الحصص المباشرة، ومتابعة الطلاب."
            stats={teacherStats}
            title="بوابة الأساتذة"
          />
        )}

        {activeSection === 'students' && (
          <DashboardSection
            accent="blue"
            actions={studentActions}
            ctaIcon={GraduationCap}
            ctaText="استكشاف الأساتذة"
            imageUrl="https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=900&q=80"
            intro="تجربة الطالب من البحث عن أستاذ مناسب إلى حضور الحصة ومتابعة الخطة الدراسية خطوة بخطوة."
            stats={studentStats}
            title="بوابة الطلاب"
          />
        )}

        {activeSection === 'video' && <VideoRoom />}
      </section>
    </main>
  );
}
