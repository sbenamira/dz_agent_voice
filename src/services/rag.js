const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('./database');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

// Extrait le texte d'un fichier selon son extension
async function extractText(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const buffer = fs.readFileSync(filePath);
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath);
    return workbook.SheetNames.map(name =>
      XLSX.utils.sheet_to_csv(workbook.Sheets[name])
    ).join('\n');
  }

  if (ext === '.txt' || mimeType === 'text/plain') {
    return fs.readFileSync(filePath, 'utf8');
  }

  throw new Error(`Type de fichier non supporté: ${ext}`);
}

// Découpe le texte en chunks de ~500 mots avec chevauchement
function chunkText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];

  for (let i = 0; i < words.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const chunk = words.slice(i, i + CHUNK_SIZE).join(' ');
    if (chunk.trim()) chunks.push(chunk);
    if (i + CHUNK_SIZE >= words.length) break;
  }

  return chunks;
}

// Génère un embedding OpenAI text-embedding-3-small
async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: config.openai.embeddingModel,
      input: text.slice(0, 8000)
    });
    return response.data[0].embedding;
  } catch (err) {
    logger.error('generateEmbedding', { error: err.message });
    throw err;
  }
}

// Indexe un document uploadé pour un subject donné
async function uploadDocument(subjectId, filePath, originalName, mimeType) {
  try {
    logger.info('Indexation document', { subjectId, originalName });

    const text = await extractText(filePath, mimeType);
    const chunks = chunkText(text);
    const fichier_type = path.extname(originalName).replace('.', '');

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk);
      await db.insertDocument({
        subject_id: subjectId,
        fichier_nom: originalName,
        fichier_type,
        contenu_chunk: chunk,
        embedding
      });
    }

    logger.info('Document indexé', { subjectId, originalName, chunks: chunks.length });
    return { chunks: chunks.length };
  } catch (err) {
    logger.error('uploadDocument', { error: err.message, originalName });
    throw err;
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

// Recherche les chunks les plus pertinents pour une requête utilisateur
async function searchContext(subjectId, query, topK = 3) {
  try {
    const queryEmbedding = await generateEmbedding(query);
    const results = await db.searchDocuments(subjectId, queryEmbedding, topK);
    if (!results || results.length === 0) return '';
    return results.map(r => r.contenu_chunk).join('\n\n---\n\n');
  } catch (err) {
    logger.error('searchContext', { error: err.message });
    return '';
  }
}

module.exports = { uploadDocument, searchContext, extractText, chunkText, generateEmbedding };
