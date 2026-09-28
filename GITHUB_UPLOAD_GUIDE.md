# دليل رفع المشروع على GitHub

تم فصل الملفات المحلية والحساسة داخل مجلد `DO_NOT_UPLOAD/`. لا ترفع هذا المجلد إلى GitHub. بعض المسارات في جذر المشروع مثل `.dev.vars`, `.openai/`, `.wrangler/`, `dist/`, و`node_modules/` قد تظهر كروابط محلية حتى يظل التشغيل يعمل طبيعيًا.

## ارفع هذه الملفات

- ملفات الكود: `src/`, `worker/`, `server/`, `db/`, `scripts/`, `tests/`
- ملفات الواجهة العامة الآمنة: `public/` باستثناء ملفات التحميل المولدة مثل APK
- إعدادات البناء العامة: `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `capacitor.config.ts`, `drizzle.config.ts`, `wrangler.jsonc`
- هجرة قاعدة البيانات: `drizzle/`
- ملفات Android المصدرية: `android/app/src/`, `android/build.gradle`, `android/settings.gradle`, `android/app/build.gradle`
- التوثيق: `README.md`, `GITHUB_UPLOAD_GUIDE.md`
- أمثلة الإعدادات فقط: `.dev.vars.example`, `.env.example` إن وجد

## لا ترفع هذه الملفات

- مجلد الفصل المحلي: `DO_NOT_UPLOAD/`
- الأسرار والتوكنات: `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`
- بيانات النشر المحلية: `.openai/`, `.wrangler/`
- ملفات خاصة أو لقطات وتجارب: `.private/`
- الاعتماديات والكاش: `node_modules/`, `.gradle/`, `build/`
- ملفات البناء النهائية: `dist/`, `android/app/build/`
- قواعد البيانات المحلية: `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db`
- تطبيقات مبنية أو موقعة: `*.apk`, `*.aab`, `*.ipa`, `public/downloads/`
- مفاتيح التوقيع والشهادات: `*.pem`, `*.key`, `*.p12`, `*.jks`, `*.keystore`
- النسخ الاحتياطية والأرشيفات: `*.tar`, `*.tar.gz`, `*.tgz`, `*.zip`, `*.rar`
- اللوجات وتقارير الاختبار: `*.log`, `playwright-report/`, `test-results/`

## قبل أول رفع

شغل:

```bash
git status --short
git add .
git status --short
```

راجع القائمة الثانية جيدًا. إذا ظهر ملف من قسم "لا ترفع"، لا تعمل commit قبل حذفه من التتبع أو إضافته إلى `.gitignore`.
