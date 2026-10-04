# Appearance backup

The original design from `b23fdca` is preserved in the Git tag
`design-before-purple-2026-10-04`.

The purple experiment is isolated in `src/styles/purple.css`. To restore the
previous colors while keeping the new messaging feature, remove only the import
of that stylesheet from `src/main.tsx`. The original `design.css`, fonts, images,
and page layout are unchanged. Do not reset the application to the tag unless
you also intend to discard features added after the backup.
