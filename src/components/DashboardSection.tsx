import type { LucideIcon } from 'lucide-react';
import type { ActionItem, Stat } from '../app/types';

type DashboardSectionProps = {
  accent: 'ink' | 'green' | 'blue';
  actions: ActionItem[];
  ctaIcon: LucideIcon;
  ctaText: string;
  imageUrl: string;
  intro: string;
  stats: Stat[];
  title: string;
};

export function DashboardSection({
  accent,
  actions,
  ctaIcon: CtaIcon,
  ctaText,
  imageUrl,
  intro,
  stats,
  title,
}: DashboardSectionProps) {
  return (
    <div className={`dashboard-section accent-${accent}`}>
      <section className="section-hero">
        <div className="hero-copy">
          <h2>{title}</h2>
          <p>{intro}</p>
          <button className="secondary-button" type="button">
            <CtaIcon size={18} />
            {ctaText}
          </button>
        </div>
        <img alt="" className="hero-image" src={imageUrl} />
      </section>

      <section className="stats-grid" aria-label="إحصائيات">
        {stats.map((stat) => (
          <article className="stat-card" key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.trend}</small>
          </article>
        ))}
      </section>

      <section className="action-grid" aria-label="مهام القسم">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <article className="action-card" key={action.title}>
              <div className="action-icon">
                <Icon size={22} />
              </div>
              <div>
                <h3>{action.title}</h3>
                <p>{action.detail}</p>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
