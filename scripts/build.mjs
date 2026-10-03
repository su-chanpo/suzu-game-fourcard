import { cp, mkdir, rm } from 'node:fs/promises';

const publicFiles = ['index.html', 'styles.css', 'online.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'sw.js'];
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for (const file of publicFiles) {
  await cp(new URL(`../public/${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
