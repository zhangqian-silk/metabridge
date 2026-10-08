#!/usr/bin/env node
'use strict';
// Apply the small maintained overlay to the pinned upstream management UI.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const COMMIT = 'ee79a794526a30c03748a8864a9ac6589a31833b';
const checkout = process.argv[2];
if (!checkout || execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== COMMIT) {
  throw new Error(`Requires management UI checkout at ${COMMIT}`);
}
const source = path.resolve(__dirname, '../quota-ui');
const destination = path.join(checkout, 'src/features/quota');
for (const filename of ['factoryQuota.ts', 'FactoryQuotaSection.tsx', 'FactoryQuotaBody.tsx', 'FactoryQuotaSection.module.scss',
  'commandQuota.ts', 'CommandQuotaSection.tsx', 'CommandQuotaBody.tsx']) {
  fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
}
fs.copyFileSync(path.join(source, 'factoryQuota.test.ts.template'), path.join(checkout, 'tests/factoryQuota.test.ts'));
fs.copyFileSync(path.join(source, 'commandQuota.test.ts.template'), path.join(checkout, 'tests/commandQuota.test.ts'));
const page = path.join(destination, 'QuotaPage.tsx');
let text = fs.readFileSync(page, 'utf8');
if (!text.includes("import { FactoryQuotaSection }")) {
  const importTarget = "import styles from './QuotaPage.module.scss';";
  const renderTarget = '      <section className={styles.workbench}>';
  if (text.split(importTarget).length !== 2 || text.split(renderTarget).length !== 2) {
    throw new Error('Upstream quota page changed; review overlay before applying');
  }
  text = text.replace(importTarget,
    "import { FactoryQuotaSection } from './FactoryQuotaSection';\n" + importTarget);
  text = text.replace(renderTarget, '      <FactoryQuotaSection />\n\n' + renderTarget);
  fs.writeFileSync(page, text);
}
if (!text.includes("import { CommandQuotaSection }")) {
  const importTarget = "import styles from './QuotaPage.module.scss';";
  const renderTarget = '      <FactoryQuotaSection />';
  if (text.split(importTarget).length !== 2 || text.split(renderTarget).length !== 2) {
    throw new Error('Quota page changed; review Command Code overlay before applying');
  }
  text = text.replace(importTarget,
    "import { CommandQuotaSection } from './CommandQuotaSection';\n" + importTarget);
  text = text.replace(renderTarget, renderTarget + '\n      <CommandQuotaSection />');
  fs.writeFileSync(page, text);
}
const locales = JSON.parse(fs.readFileSync(path.join(source, 'locales.json'), 'utf8'));
const commandLocales = JSON.parse(fs.readFileSync(path.join(source, 'command-locales.json'), 'utf8'));
for (const [language, strings] of Object.entries(locales)) {
  const filename = path.join(checkout, `src/i18n/locales/${language}.json`);
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  current.factory_quota = strings;
  current.command_quota = commandLocales[language];
  fs.writeFileSync(filename, JSON.stringify(current, null, 2) + '\n');
}
console.log('Applied Factory quota UI overlay to pinned upstream checkout');
