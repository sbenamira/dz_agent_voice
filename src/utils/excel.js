const XLSX = require('xlsx');
const logger = require('./logger');

// Parse un fichier Excel et retourne la liste des contacts
function parseContactsExcel(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const contacts = rows.map((row, index) => {
      const telephone = String(
        row.telephone || row.Telephone || row.phone || row.Phone || row.tel || row.Tel || ''
      ).trim();

      if (!telephone) {
        logger.warn('Ligne sans numéro de téléphone ignorée', { index });
        return null;
      }

      const reserved = new Set(['telephone','Telephone','phone','Phone','tel','Tel','nom','Nom','name','Name']);
      const donnees_custom = Object.fromEntries(
        Object.entries(row).filter(([k]) => !reserved.has(k))
      );

      return {
        telephone,
        nom: String(row.nom || row.Nom || row.name || row.Name || '').trim(),
        donnees_custom: Object.keys(donnees_custom).length > 0 ? donnees_custom : {}
      };
    }).filter(Boolean);

    logger.info('Fichier Excel parsé', { filePath, total: contacts.length });
    return contacts;
  } catch (err) {
    logger.error('Erreur parsing Excel', { filePath, error: err.message });
    throw err;
  }
}

// Valide un numéro de téléphone international
function validatePhoneNumber(phone) {
  const cleaned = phone.replace(/[\s\-().]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(cleaned);
}

module.exports = { parseContactsExcel, validatePhoneNumber };
