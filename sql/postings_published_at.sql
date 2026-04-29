-- Veröffentlichungsdatum für Postings (Admin: Planung / Entwurf).
-- Mit mysql: mysql -u ... -p ... < sql/postings_published_at.sql

ALTER TABLE postings
  ADD COLUMN published_at DATETIME NULL DEFAULT NULL
    AFTER modified;

UPDATE postings
SET published_at = created
WHERE published_at IS NULL AND created IS NOT NULL;

UPDATE postings SET published_at = NOW() WHERE published_at IS NULL;
