#!/usr/bin/env node
// gen-console-images.mjs — imagery for the Onboarding Console. Same proven path as gen-images.mjs
// (OpenAI gpt-image-1, fallback dall-e-3), same brand style, output into console/assets/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'console/assets');
fs.mkdirSync(OUT, { recursive: true });

// Load the key the same way gen-images.mjs does, but tolerate a few env-file locations.
function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const candidates = [process.env.RUVNET_ENV_FILE, path.join(ROOT, '.env'), path.join(process.env.HOME, 'Code/Ask-Ruvnet/.env')].filter(Boolean);
  for (const f of candidates) { try { const m = fs.readFileSync(f, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]; } catch { /* next */ } }
  return '';
}
const KEY = (loadKey().match(/sk-[A-Za-z0-9_\-]+/) || [''])[0];
if (!KEY) { console.error('no OPENAI_API_KEY (env or .env)'); process.exit(2); }
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-***');

const STYLE = ' — Style: deep near-black background (#0a0c10), sophisticated premium editorial-tech aesthetic, restrained warm amber (#f0a830) and warm gold (#ffce6a) glow with cool cyan (#5ad6ff) and calm green (#5fd38a) accents only, cinematic soft volumetric light, generous negative space, refined, calming, screenshot-worthy, high craft. Absolutely NO text, NO words, NO letters, NO numbers, NO UI chrome, NO logos, NO circuit-board cliché.';

const IMAGES = [
  { slug: 'hero', size: '1536x1024', p: 'A warm amber intelligence gently understanding a computer: soft glowing amber and gold neural filaments and threads of light weaving and resolving out of a faint tangle on the left into an elegant, orderly, translucent crystalline lattice of floating glass panels and cards on the right — the feeling of messy machine settings being calmly brought into clear, beautiful order. Lots of soft dark negative space on the right for text.' },
];

async function gen(model, prompt, size) {
  const body = model === 'gpt-image-1'
    ? { model, prompt, size, quality: 'high', n: 1 }
    : { model, prompt, size: size === '1536x1024' ? '1792x1024' : '1024x1024', response_format: 'b64_json', n: 1 };
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${model} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data[0].b64_json;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const im of IMAGES) {
  if (only.length && !only.includes(im.slug)) continue;
  const prompt = im.p + STYLE;
  let b64;
  try { b64 = await gen('gpt-image-1', prompt, im.size); console.log(`✓ ${im.slug} (gpt-image-1)`); }
  catch (e) {
    console.log(`  gpt-image-1 failed for ${im.slug}: ${redact(e.message)} — trying dall-e-3`);
    try { b64 = await gen('dall-e-3', prompt, im.size); console.log(`✓ ${im.slug} (dall-e-3)`); }
    catch (e2) { console.error(`✗ ${im.slug}: ${redact(e2.message)}`); continue; }
  }
  fs.writeFileSync(path.join(OUT, `${im.slug}.png`), Buffer.from(b64, 'base64'));
}
console.log('done →', OUT);
