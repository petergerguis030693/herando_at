const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

function getCloudflareConfig() {
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const rawZones = String(process.env.CLOUDFLARE_ZONES || '').trim();

  const zones = rawZones
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, zoneId] = entry.split(':').map((x) => String(x || '').trim());
      if (!name || !zoneId) return null;
      return { name: name.toLowerCase(), zoneId };
    })
    .filter(Boolean);

  return { apiToken, zones };
}

function getFlashSuccess(code) {
  if (code === 'dev_on') return 'Development Mode wurde aktiviert.';
  if (code === 'dev_off') return 'Development Mode wurde deaktiviert.';
  if (code === 'purged') return 'Cloudflare Cache wurde geleert.';
  return null;
}

function getFlashError(code) {
  if (code === 'cfg') return 'Cloudflare ist nicht konfiguriert. Bitte CLOUDFLARE_API_TOKEN und CLOUDFLARE_ZONES in .env setzen.';
  if (code === 'zone') return 'Ungültige Zone.';
  if (code === 'api') return 'Cloudflare API-Fehler.';
  return null;
}

function getApiErrorMessage(err) {
  const raw = String(err?.message || '').trim();
  if (!raw) return 'Cloudflare API-Fehler.';
  return raw.slice(0, 240);
}

function redirectWithApiError(res, err) {
  const detail = encodeURIComponent(getApiErrorMessage(err));
  return res.redirect(`/admin/cloudflare?err=api&detail=${detail}`);
}

async function cfRequest({ apiToken, path, method = 'GET', body = null }) {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.success === false) {
    const errors = Array.isArray(payload?.errors) ? payload.errors.map((e) => e?.message).filter(Boolean) : [];
    const message = errors.length ? errors.join(' | ') : `Cloudflare request failed (${resp.status})`;
    const err = new Error(message);
    err.statusCode = resp.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

async function getZoneDevMode(apiToken, zoneId) {
  const data = await cfRequest({
    apiToken,
    path: `/zones/${encodeURIComponent(zoneId)}/settings/development_mode`
  });
  return data?.result?.value || 'unknown';
}

router.use((req, res, next) => {
  const role = Number(req.session?.role || 0);
  if (role !== 9) return res.redirect('/admin');
  next();
});

router.get('/', async (req, res, next) => {
  try {
    const { apiToken, zones } = getCloudflareConfig();
    const configured = Boolean(apiToken) && zones.length > 0;

    const statuses = await Promise.all(
      zones.map(async (zone) => {
        if (!configured) {
          return { ...zone, devMode: 'unknown', error: 'Nicht konfiguriert' };
        }

        try {
          const devMode = await getZoneDevMode(apiToken, zone.zoneId);
          return { ...zone, devMode, error: null };
        } catch (err) {
          return { ...zone, devMode: 'unknown', error: err?.message || 'API-Fehler' };
        }
      })
    );

    res.render('admin/cloudflare/index', {
      active: 'cloudflare',
      role: req.session?.role,
      configured,
      zones: statuses,
      flashSuccess: getFlashSuccess(req.query?.msg),
      flashError: req.query?.detail ? String(req.query.detail) : getFlashError(req.query?.err)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/dev-mode', async (req, res) => {
  const { apiToken, zones } = getCloudflareConfig();
  if (!apiToken || !zones.length) return res.redirect('/admin/cloudflare?err=cfg');

  const zoneId = String(req.body?.zoneId || '').trim();
  const value = String(req.body?.value || '').trim().toLowerCase();
  const target = zones.find((z) => z.zoneId === zoneId);
  if (!target) return res.redirect('/admin/cloudflare?err=zone');
  if (value !== 'on' && value !== 'off') return res.redirect('/admin/cloudflare?err=api');

  try {
    await cfRequest({
      apiToken,
      path: `/zones/${encodeURIComponent(zoneId)}/settings/development_mode`,
      method: 'PATCH',
      body: { value }
    });
    return res.redirect(`/admin/cloudflare?msg=${value === 'on' ? 'dev_on' : 'dev_off'}`);
  } catch (err) {
    console.error('❌ Cloudflare dev-mode update failed:', err?.message || err);
    return redirectWithApiError(res, err);
  }
});

router.post('/purge-cache', async (req, res) => {
  const { apiToken, zones } = getCloudflareConfig();
  if (!apiToken || !zones.length) return res.redirect('/admin/cloudflare?err=cfg');

  const zoneId = String(req.body?.zoneId || '').trim();
  const target = zones.find((z) => z.zoneId === zoneId);
  if (!target) return res.redirect('/admin/cloudflare?err=zone');

  try {
    await cfRequest({
      apiToken,
      path: `/zones/${encodeURIComponent(zoneId)}/purge_cache`,
      method: 'POST',
      body: { purge_everything: true }
    });
    return res.redirect('/admin/cloudflare?msg=purged');
  } catch (err) {
    console.error('❌ Cloudflare purge failed:', err?.message || err);
    return redirectWithApiError(res, err);
  }
});

module.exports = router;
