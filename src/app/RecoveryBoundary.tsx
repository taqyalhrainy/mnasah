import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { t } from '../i18n/preferences';

export function lazyWithRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try { return await load(); }
    catch { await new Promise(resolve => setTimeout(resolve, 800)); return load(); }
  });
}

export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="recovery-panel" role="alert" dir="auto"><h2>{t('تعذر عرض هذه الصفحة')}</h2><p>{t('حدث انقطاع أثناء التحميل. أعد المحاولة للمتابعة.')}</p><button className="primary-button" onClick={() => location.reload()}>{t('إعادة المحاولة')}</button></div>;
    return this.props.children;
  }
}
