const SCORE_FIELDS = [
  'formaler_aufbau_score',
  'darstellung_befund_score',
  'fachlicher_inhalt_score',
  'bodenwertermittlung_score',
  'ertragswertberechnung_score',
  'sachwertberechnung_score',
  'vergleichswertberechnung_score'
];

// Mapping from snake_case to PascalCase (as used in runEvaluation result)
const PASCAL_SCORE_FIELDS = {
  'formaler_aufbau_score': 'Formaler_Aufbau_Score',
  'darstellung_befund_score': 'Darstellung_Befund_Score',
  'fachlicher_inhalt_score': 'Fachlicher_Inhalt_Score',
  'bodenwertermittlung_score': 'Bodenwertermittlung_Score',
  'ertragswertberechnung_score': 'Ertragswertberechnung_Score',
  'sachwertberechnung_score': 'Sachwertberechnung_Score',
  'vergleichswertberechnung_score': 'Vergleichswertberechnung_Score'
};

/**
 * Calculate Gesamtscore = average of all non-null score fields, rounded to 1 decimal
 */
function calculateGesamtscore(result) {
  const validScores = SCORE_FIELDS
    .map(f => {
      // Support both snake_case (Supabase) and PascalCase (runEvaluation result)
      return result[f] ?? result[PASCAL_SCORE_FIELDS[f]] ?? null;
    })
    .filter(s => s !== null && s !== undefined);

  if (validScores.length === 0) return null;
  return Math.round((validScores.reduce((a, b) => a + b, 0) / validScores.length) * 10) / 10;
}

/**
 * Calculate per-criterion averages across multiple gutachten records for one AG
 * @param {Array} records - Array of gutachten objects from Supabase
 * @returns {Object} Average scores + count
 */
function calculateAverages(records) {
  const averages = {};
  const count = records.length;

  for (const field of SCORE_FIELDS) {
    const values = records
      .map(r => r[field])
      .filter(v => v !== null && v !== undefined);
    averages[field.replace('_score', '_avg')] = values.length > 0
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
      : null;
  }

  // Gesamtscore average
  const gesamtscores = records
    .map(r => r.gesamtscore)
    .filter(v => v !== null && v !== undefined);
  averages.gesamtscore_avg = gesamtscores.length > 0
    ? Math.round((gesamtscores.reduce((a, b) => a + b, 0) / gesamtscores.length) * 10) / 10
    : null;

  averages.anzahl_gutachten = count;
  return averages;
}

/**
 * Calculate rankings for all AGs sorted by gesamtscore_avg (descending)
 * @param {Array} agAverages - Array of { unternehmensname, vorname, nachname, email, ...averages }
 * @returns {Array} Same array with platzierung added
 */
function calculateRankings(agAverages) {
  const sorted = [...agAverages]
    .filter(ag => ag.gesamtscore_avg !== null)
    .sort((a, b) => (b.gesamtscore_avg || 0) - (a.gesamtscore_avg || 0));

  return sorted.map((ag, index) => ({
    ...ag,
    platzierung: index + 1
  }));
}

module.exports = { calculateGesamtscore, calculateAverages, calculateRankings, SCORE_FIELDS };
