-- Supabase Schema for Gutachtenprüfung Phase 2
-- Run this in the Supabase SQL Editor to create the required tables

-- ── Gutachten Table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gutachten (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fillout_submission_id TEXT UNIQUE NOT NULL,

  -- AG (Auftraggeber) Info
  vorname TEXT,
  nachname TEXT,
  email TEXT,
  unternehmensname TEXT,
  adresse JSONB,

  -- PDF Info
  pdf_url TEXT,
  pdf_filename TEXT,

  -- Payment Info
  stripe_payment_id TEXT,
  stripe_amount NUMERIC,

  -- Status
  status TEXT DEFAULT 'Empfangen' CHECK (status IN ('Empfangen', 'Wird geprüft', 'Geprüft', 'Abgeschlossen', 'Fehler')),
  fehler_details TEXT,

  -- Evaluation Results: Objektbeschreibung
  objektbeschreibung TEXT,

  -- KO-Kriterien
  formalia_erfuellt TEXT,
  formalia_kommentar TEXT,
  recht_erfuellt TEXT,
  recht_kommentar TEXT,
  lage_erfuellt TEXT,
  lage_kommentar TEXT,
  baurecht_erfuellt TEXT,
  baurecht_kommentar TEXT,
  boden_erfuellt TEXT,
  boden_kommentar TEXT,
  nutzung_erfuellt TEXT,
  nutzung_kommentar TEXT,
  gebaeude_erfuellt TEXT,
  gebaeude_kommentar TEXT,
  verfahren_erfuellt TEXT,
  verfahren_kommentar TEXT,
  merkmale_erfuellt TEXT,
  merkmale_kommentar TEXT,
  plausi_erfuellt TEXT,
  plausi_kommentar TEXT,

  -- Prüfkriterien (Text + Score)
  formaler_aufbau TEXT,
  formaler_aufbau_score NUMERIC,
  darstellung_befund TEXT,
  darstellung_befund_score NUMERIC,
  fachlicher_inhalt TEXT,
  fachlicher_inhalt_score NUMERIC,
  bodenwertermittlung TEXT,
  bodenwertermittlung_score NUMERIC,
  ertragswertberechnung TEXT,
  ertragswertberechnung_score NUMERIC,
  sachwertberechnung TEXT,
  sachwertberechnung_score NUMERIC,
  vergleichswertberechnung TEXT,
  vergleichswertberechnung_score NUMERIC,

  -- Zusammenfassung
  zusammenfassung TEXT,
  zusammenfassung_score NUMERIC,
  gesamtscore NUMERIC,

  -- Ranking
  platzierung INTEGER,

  -- Google Drive Links
  gutachten_drive_link TEXT,
  pruefbericht_drive_link TEXT,

  -- Processing Metadata
  processing_errors JSONB,
  processing_time_seconds NUMERIC,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for AG queries
CREATE INDEX IF NOT EXISTS idx_gutachten_unternehmensname ON gutachten(unternehmensname);
CREATE INDEX IF NOT EXISTS idx_gutachten_status ON gutachten(status);
CREATE INDEX IF NOT EXISTS idx_gutachten_gesamtscore ON gutachten(gesamtscore DESC);

-- ── AG Rankings Table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ag_rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unternehmensname TEXT UNIQUE NOT NULL,
  vorname TEXT,
  nachname TEXT,
  email TEXT,

  -- Score Averages
  anzahl_gutachten INTEGER DEFAULT 0,
  formaler_aufbau_avg NUMERIC,
  darstellung_befund_avg NUMERIC,
  fachlicher_inhalt_avg NUMERIC,
  bodenwertermittlung_avg NUMERIC,
  ertragswertberechnung_avg NUMERIC,
  sachwertberechnung_avg NUMERIC,
  vergleichswertberechnung_avg NUMERIC,
  gesamtscore_avg NUMERIC,

  -- Ranking
  platzierung INTEGER,

  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Auto-update updated_at ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gutachten_updated_at
  BEFORE UPDATE ON gutachten
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER ag_rankings_updated_at
  BEFORE UPDATE ON ag_rankings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
