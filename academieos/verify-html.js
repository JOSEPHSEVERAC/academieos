const fs = require('fs');
const h = fs.readFileSync('public/dashboard.html', 'utf8');
const need = ['<html', '</html>', '<body', '</body>'];
const missing = need.filter(t => !h.includes(t));
if (missing.length) { console.error('FAIL: missing: ' + missing.join(', ')); process.exit(1); }
console.log('HTML OK (' + h.length + ' chars)');
console.log('wc -l:', require('child_process').execSync('wc -l < public/dashboard.html', { encoding: 'utf8' }).trim());