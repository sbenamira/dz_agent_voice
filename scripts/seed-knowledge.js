#!/usr/bin/env node
// Usage:
//   node scripts/seed-knowledge.js          → compte + insère les chunks de test
//   node scripts/seed-knowledge.js --check  → compte seulement, sans insérer

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Catalogue fictif Konfident (visas) pour tester le RAG
const PRODUITS = [
  'تسياف كندا السياحي: السعر 2500 دينار جزائري، المدة من 3 إلى 5 أسابيع. الوثائق المطلوبة: جواز السفر، كشف الحساب البنكي 3 أشهر، عقد العمل أو شهادة الدراسة.',
  'تسياف فرنسا السياحي: السعر 3200 دينار جزائري، المدة من 2 إلى 3 أسابيع. الوثائق: جواز السفر، فاتورة الفندق أو دعوة معتمدة، كشف الحساب 3 أشهر.',
  'تسياف إسبانيا: السعر 2800 دينار جزائري، المدة 3 أسابيع. الوثائق: جواز السفر، حجز الطائرة، فاتورة الفندق.',
  'تسياف المملكة المتحدة: السعر 4500 دينار جزائري، المدة من 4 إلى 6 أسابيع. الوثائق: جواز السفر، كشف الحساب 6 أشهر، عقد العمل أو شهادة الدراسة.',
  'تسياف ألمانيا: السعر 3000 دينار جزائري، المدة من 3 إلى 4 أسابيع. الوثائق: جواز السفر، حجز الفندق، تأمين السفر، كشف الحساب.',
  'باقة الخدمات الكاملة تاع Konfident: تجهيز الملف، الترجمة المعتمدة، حجز الموعد القنصلي، متابعة حتى القرار. السعر يبدأ من 5000 دينار حسب البلد.',
  'أوقات العمل: من الأحد إلى الخميس 8 صباحًا حتى 5 مساءً. مكتبنا في الجزائر العاصمة، حي باب الزوار، الطابق الثالث.',
  'Konfident وكالة تأشيرات معتمدة تأسست 2018. خدمنا أكثر من 5000 زبون. معدل نجاح التسيافات 94٪.',
];

async function countChunks() {
  const { count, error } = await supabase
    .from('subject_documents')
    .select('*', { count: 'exact', head: true });
  if (error) { console.error('[count error]', error.message); return null; }
  return count;
}

async function embed(text) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  const total = await countChunks();
  console.log(`[RAG] Chunks existants dans subject_documents: ${total ?? 'erreur de connexion'}`);

  if (checkOnly) {
    if (total === 0) console.log('→ Table vide — relancer sans --check pour insérer les données de test');
    process.exit(0);
  }

  // Créer workspace de test
  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .insert({ nom: 'Konfident', email: 'admin@konfident.dz' })
    .select().single();
  if (wsErr) { console.error('[workspace error]', wsErr.message); process.exit(1); }
  console.log('[workspace] créé:', workspace.id);

  // Créer subject lié
  const { data: subject, error: subErr } = await supabase
    .from('subjects')
    .insert({ workspace_id: workspace.id, nom: 'Catalogue Produits', langue: 'ar' })
    .select().single();
  if (subErr) { console.error('[subject error]', subErr.message); process.exit(1); }
  console.log('[subject] créé:', subject.id);

  // Insérer chaque chunk avec son embedding OpenAI
  for (const chunk of PRODUITS) {
    process.stdout.write('  → ' + chunk.slice(0, 45) + '...');
    const embedding = await embed(chunk);
    const { error: docErr } = await supabase
      .from('subject_documents')
      .insert({ subject_id: subject.id, fichier_nom: 'seed.txt', fichier_type: 'txt', contenu_chunk: chunk, embedding });
    if (docErr) { console.log(' ✗ ' + docErr.message); }
    else { console.log(' ✓'); }
  }

  console.log('\n=== DONE ===');
  console.log('Ajouter dans .env (et dans les variables Render) :');
  console.log(`DEFAULT_SUBJECT_ID=${subject.id}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
