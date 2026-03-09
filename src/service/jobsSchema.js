const db = require('../db');

let schemaReady = false;
let schemaPromise = null;

async function columnExists(tableName, columnName) {
  const [[row]] = await db.query(
    `
    SELECT COUNT(*) AS cnt
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
    `,
    [tableName, columnName]
  );
  return Number(row?.cnt || 0) > 0;
}

async function addColumnIfMissing(tableName, columnName, definitionSql) {
  if (await columnExists(tableName, columnName)) return;
  await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
}

async function ensureJobsSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        location VARCHAR(255) DEFAULT NULL,
        department VARCHAR(255) DEFAULT NULL,
        employment_type VARCHAR(100) DEFAULT NULL,
        workplace_type VARCHAR(100) DEFAULT NULL,
        short_description TEXT DEFAULT NULL,
        description LONGTEXT DEFAULT NULL,
        requirements LONGTEXT DEFAULT NULL,
        benefits LONGTEXT DEFAULT NULL,
        image_url VARCHAR(512) DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_by INT UNSIGNED DEFAULT NULL,
        updated_by INT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ux_jobs_slug (slug),
        KEY idx_jobs_active_sort (is_active, sort_order, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await addColumnIfMissing('jobs', 'source_lang', 'source_lang VARCHAR(8) DEFAULT NULL AFTER benefits');

    await db.query(`
      CREATE TABLE IF NOT EXISTS job_applications (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        job_id INT UNSIGNED NOT NULL,
        first_name VARCHAR(120) NOT NULL,
        last_name VARCHAR(120) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(80) DEFAULT NULL,
        message TEXT DEFAULT NULL,
        resume_path VARCHAR(512) NOT NULL,
        resume_name VARCHAR(255) NOT NULL,
        resume_mime VARCHAR(120) DEFAULT NULL,
        resume_size INT UNSIGNED DEFAULT NULL,
        cover_letter_path VARCHAR(512) DEFAULT NULL,
        cover_letter_name VARCHAR(255) DEFAULT NULL,
        cover_letter_mime VARCHAR(120) DEFAULT NULL,
        cover_letter_size INT UNSIGNED DEFAULT NULL,
        certificates_json LONGTEXT DEFAULT NULL,
        status ENUM('new','in_review','interview','accepted','rejected') NOT NULL DEFAULT 'new',
        admin_notes TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_job_applications_job_id (job_id),
        KEY idx_job_applications_status (status),
        KEY idx_job_applications_created (created_at),
        CONSTRAINT fk_job_applications_job
          FOREIGN KEY (job_id) REFERENCES jobs(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await addColumnIfMissing(
      'job_applications',
      'country_id',
      'country_id INT(11) DEFAULT NULL AFTER email'
    );
    await addColumnIfMissing(
      'job_applications',
      'phone_prefix',
      'phone_prefix VARCHAR(12) DEFAULT NULL AFTER country_id'
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS job_translations (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        job_id INT UNSIGNED NOT NULL,
        language VARCHAR(8) NOT NULL,
        title VARCHAR(255) NOT NULL,
        short_description TEXT DEFAULT NULL,
        description LONGTEXT DEFAULT NULL,
        requirements LONGTEXT DEFAULT NULL,
        benefits LONGTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ux_job_translations_job_lang (job_id, language),
        KEY idx_job_translations_lang (language),
        CONSTRAINT fk_job_translations_job
          FOREIGN KEY (job_id) REFERENCES jobs(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    schemaReady = true;
  })();

  return schemaPromise;
}

module.exports = {
  ensureJobsSchema
};
