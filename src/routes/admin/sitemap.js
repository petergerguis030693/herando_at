const express = require('express');
const db = require('../../db');
const {
  ensureSitemapPagesTable,
  normalizeSitemapUrlInput,
  normalizeSitemapLastmodInput,
  normalizeSitemapChangefreqInput,
  normalizeSitemapPriorityInput,
  normalizeSitemapSortOrderInput,
  normalizeSitemapActiveInput,
  formatSitemapDateValue,
  getSitemapPageRows,
  CHANGEFREQ_VALUES
} = require('../../service/sitemap-xml');

const router = express.Router();

function parseId(input) {
  const id = Number.parseInt(String(input || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeRowInput(body) {
  const url = normalizeSitemapUrlInput(body?.url);
  if (!url) return { error: 'invalid_url' };

  return {
    data: {
      url,
      lastmod: normalizeSitemapLastmodInput(body?.lastmod),
      changefreq: normalizeSitemapChangefreqInput(body?.changefreq),
      priority: normalizeSitemapPriorityInput(body?.priority),
      sort_order: normalizeSitemapSortOrderInput(body?.sort_order),
      is_active: normalizeSitemapActiveInput(body?.is_active)
    }
  };
}

function getFlashSuccess(code) {
  if (code === 'created') return 'Sitemap-Link wurde angelegt.';
  if (code === 'updated') return 'Sitemap-Link wurde aktualisiert.';
  if (code === 'deleted') return 'Sitemap-Link wurde gelöscht.';
  return null;
}

function getFlashError(code) {
  if (code === 'invalid_url') return 'Ungültige URL. Bitte relative URL (z. B. /kontakt) oder vollständige http(s)-URL verwenden.';
  if (code === 'invalid_id') return 'Ungültige ID.';
  if (code === 'not_found') return 'Eintrag nicht gefunden.';
  if (code === 'db') return 'Datenbankfehler beim Speichern.';
  return null;
}

function mapViewRow(row) {
  return {
    id: row.id,
    url: row.url || '',
    lastmod: formatSitemapDateValue(row.lastmod) || '',
    changefreq: row.changefreq || '',
    priority: row.priority == null ? '' : Number(row.priority).toFixed(1),
    sort_order: Number(row.sort_order) || 0,
    is_active: Number(row.is_active) === 1
  };
}

router.get('/', async (req, res, next) => {
  try {
    await ensureSitemapPagesTable();
    const rows = await getSitemapPageRows();

    res.render('admin/sitemap/list', {
      active: 'sitemap-xml',
      role: req.session?.role,
      items: rows.map(mapViewRow),
      flashSuccess: getFlashSuccess(req.query?.msg),
      flashError: getFlashError(req.query?.err),
      changefreqValues: Array.from(CHANGEFREQ_VALUES)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/new', async (req, res, next) => {
  try {
    const { error, data } = normalizeRowInput(req.body);
    if (error) return res.redirect(`/admin/sitemap?err=${error}`);

    await ensureSitemapPagesTable();
    await db.query(
      `
        INSERT INTO sitemap_pages (url, lastmod, changefreq, priority, sort_order, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [data.url, data.lastmod, data.changefreq, data.priority, data.sort_order, data.is_active]
    );

    return res.redirect('/admin/sitemap?msg=created');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/edit', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.redirect('/admin/sitemap?err=invalid_id');

    const { error, data } = normalizeRowInput(req.body);
    if (error) return res.redirect(`/admin/sitemap?err=${error}`);

    await ensureSitemapPagesTable();
    const [result] = await db.query(
      `
        UPDATE sitemap_pages
        SET url = ?, lastmod = ?, changefreq = ?, priority = ?, sort_order = ?, is_active = ?
        WHERE id = ?
      `,
      [data.url, data.lastmod, data.changefreq, data.priority, data.sort_order, data.is_active, id]
    );

    if (!result?.affectedRows) return res.redirect('/admin/sitemap?err=not_found');
    return res.redirect('/admin/sitemap?msg=updated');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.redirect('/admin/sitemap?err=invalid_id');

    await ensureSitemapPagesTable();
    const [result] = await db.query('DELETE FROM sitemap_pages WHERE id = ?', [id]);

    if (!result?.affectedRows) return res.redirect('/admin/sitemap?err=not_found');
    return res.redirect('/admin/sitemap?msg=deleted');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
