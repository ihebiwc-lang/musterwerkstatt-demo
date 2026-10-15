// Auto-Werkstatt Demmin — Cloudflare Worker (API + R2 uploads + D1)
// Static frontend (public/) is served via the ASSETS binding (see wrangler.jsonc).
// Secrets: ADMIN_PASSWORD (wrangler secret put ADMIN_PASSWORD)

const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 8;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

function num(v, d = 0) {
  const n = Number(String(v ?? '').replace(/[.\s€]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : d;
}

function parseCarFields(body) {
  const get = (k) => body.get?.(k) ?? body[k] ?? '';
  return {
    titel: String(get('titel') || '').slice(0, 120),
    preis: num(get('preis')),
    km: Math.round(num(get('km'))),
    baujahr: Math.round(num(get('baujahr'))),
    kraftstoff: String(get('kraftstoff') || '—').slice(0, 30),
    getriebe: String(get('getriebe') || '—').slice(0, 40),
    leistung: Math.round(num(get('leistung'))),
    hu: String(get('hu') || '').slice(0, 20),
    beschreibung: String(get('beschreibung') || '').slice(0, 2000),
  };
}

function rowToCar(row) {
  let bilder = [];
  try {
    bilder = JSON.parse(row.bilder || '[]');
    if (!Array.isArray(bilder)) bilder = [];
  } catch { bilder = []; }
  return {
    id: row.id,
    titel: row.titel,
    preis: row.preis,
    km: row.km,
    baujahr: row.baujahr,
    kraftstoff: row.kraftstoff,
    getriebe: row.getriebe,
    leistung: row.leistung,
    hu: row.hu,
    beschreibung: row.beschreibung,
    bilder,
    bilderUrls: bilder.map((f) => '/uploads/' + f),
    erstelltAm: row.erstelltAm,
    status: row.status || 'aktiv',
  };
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

async function storeUploads(env, files) {
  const names = [];
  for (const f of files.slice(0, MAX_FILES)) {
    if (typeof f === 'string') continue;
    if (!/^image\//.test(f.type || '')) throw new Error('Nur Bilder erlaubt');
    if ((f.size || 0) > MAX_FILE) throw new Error('Datei zu gross (max 8MB)');
    const key = Date.now() + '-' + Math.round(Math.random() * 1e6) + extOf(f.name);
    await env.UPLOADS.put(key, await f.arrayBuffer(), {
      metadata: { contentType: f.type || 'image/jpeg' },
    });
    names.push(key);
  }
  return names;
}

function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
}

async function sweepTermine(env) {
  const now = berlinNow();
  const { results } = await env.DB.prepare(
    "SELECT * FROM termine WHERE datum < ? OR (datum = ? AND uhrzeit != '' AND uhrzeit <= ?)"
  ).bind(now.date, now.date, now.time).all();
  const rows = results || [];
  const stamp = new Date().toISOString();
  for (const t of rows) {
    const aid = 'arc-' + Date.now() + '-' + Math.round(Math.random() * 1e6);
    await env.DB.prepare(
      'INSERT INTO archiv (id, typ, titel, payload, erstelltAm, archiviertAm) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(aid, 'termin-abgelaufen', (t.name || '') + ' · ' + (t.datum || '') + ' ' + (t.uhrzeit || ''), JSON.stringify(t), t.erstelltAm || '', stamp).run();
    await env.DB.prepare('DELETE FROM termine WHERE id = ?').bind(t.id).run();
  }
  return rows.length;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // ---- uploads from KV ----
    if (path.startsWith('/uploads/') && method === 'GET') {
      const key = decodeURIComponent(path.slice('/uploads/'.length)).split('/')[0];
      if (!key || key === '.gitkeep') return new Response('Not found', { status: 404 });
      const stored = await env.UPLOADS.getWithMetadata(key, 'arrayBuffer');
      if (!stored || !stored.value) return new Response('Not found', { status: 404 });
      return new Response(stored.value, {
        headers: {
          'Content-Type': stored.metadata?.contentType || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ---- /admin alias (as in Express) ----
    if (path === '/admin' && method === 'GET') {
      return env.ASSETS.fetch(new Request(new URL('/admin.html', url), request));
    }

    // ---- API: login ----
    if (path === '/api/login' && method === 'POST') {
      let password = '';
      try {
        password = (await request.json())?.password || '';
      } catch { /* ignore */ }
      if (password === env.ADMIN_PASSWORD) return json({ ok: true, token: env.ADMIN_PASSWORD });
      return json({ error: 'Falsches Passwort' }, 401);
    }

    // ---- API: free/busy slots for a date (public, times only) ----
    if (path === '/api/slots' && method === 'GET') {
      await sweepTermine(env);
      const datum = String(url.searchParams.get('datum') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return json([]);
      const { results } = await env.DB.prepare(
        'SELECT uhrzeit FROM termine WHERE datum = ?'
      ).bind(datum).all();
      return json((results || []).map((r) => r.uhrzeit).filter(Boolean));
    }

    // ---- API: Termine (booking requests) ----
    if (path === '/api/termine' && method === 'POST') {
      await sweepTermine(env);
      let b = null;
      try { b = await request.json(); } catch { b = null; }
      if (!b) return json({ error: 'Ungültige Daten' }, 400);
      const name = String(b.name || '').slice(0, 80).trim();
      const telefon = String(b.telefon || '').slice(0, 40).trim();
      if (!name || !telefon) return json({ error: 'Name und Telefon sind Pflicht' }, 400);
      const id = 'trm-' + Date.now();
      const datum = String(b.datum || '').slice(0, 10);
      const uhrzeit = String(b.uhrzeit || '').slice(0, 5);
      if (/^\d{4}-\d{2}-\d{2}$/.test(datum) && /^\d{2}:\d{2}$/.test(uhrzeit)) {
        const taken = await env.DB.prepare(
          'SELECT id FROM termine WHERE datum = ? AND uhrzeit = ?'
        ).bind(datum, uhrzeit).first();
        if (taken) return json({ error: 'Diese Uhrzeit ist gerade vergeben — bitte eine andere wählen.' }, 409);
      }
      const telDigits = telefon.replace(/\D/g, '');
      const telKey = telDigits.length >= 6 ? telDigits : telefon;
      if (telKey) {
        const dayRows = await env.DB.prepare(
          'SELECT telefon FROM termine WHERE datum = ?'
        ).bind(datum).all();
        const dup = (dayRows.results || []).some((r) => {
          const dd = String(r.telefon || '').replace(/\D/g, '');
          return (dd.length >= 6 ? dd : String(r.telefon || '')) === telKey;
        });
        if (dup) return json({ error: 'Für diese Telefonnummer gibt es an diesem Tag bereits einen Termin.' }, 409);
      }
      await env.DB.prepare(
        'INSERT INTO termine (id, name, telefon, datum, uhrzeit, leistung, nachricht, erstelltAm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(id, name, telefon, datum, uhrzeit, String(b.leistung || '').slice(0, 60), String(b.nachricht || '').slice(0, 500), new Date().toISOString())
        .run();
      return json({ ok: true, id });
    }

    if (path === '/api/termine' && method === 'GET') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await sweepTermine(env);
      const { results } = await env.DB.prepare(
        'SELECT * FROM termine ORDER BY erstelltAm DESC'
      ).all();
      return json(results || []);
    }

    const mt = /^\/api\/termine\/([^/]+)$/.exec(path);
    if (mt && method === 'DELETE') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await env.DB.prepare('DELETE FROM termine WHERE id = ?').bind(decodeURIComponent(mt[1])).run();
      return json({ ok: true });
    }

    // ---- API: list (public: only aktiv) ----
    if (path === '/api/cars' && method === 'GET') {
      const { results } = await env.DB.prepare(
        "SELECT * FROM cars WHERE status = 'aktiv' ORDER BY erstelltAm DESC"
      ).all();
      return json((results || []).map(rowToCar));
    }

    // ---- API: create ----
    if (path === '/api/cars' && method === 'POST') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const form = await request.formData();
      const f = parseCarFields(form);
      if (!f.titel || !f.preis) return json({ error: 'Titel und Preis sind Pflicht' }, 400);
      let names = [];
      try {
        names = await storeUploads(env, form.getAll('bilder'));
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
      const car = {
        id: 'car-' + Date.now(),
        ...f,
        bilder: JSON.stringify(names),
        erstelltAm: new Date().toISOString(),
      };
      await env.DB.prepare(
        'INSERT INTO cars (id, titel, preis, km, baujahr, kraftstoff, getriebe, leistung, hu, beschreibung, bilder, erstelltAm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(car.id, car.titel, car.preis, car.km, car.baujahr, car.kraftstoff, car.getriebe, car.leistung, car.hu, car.beschreibung, car.bilder, car.erstelltAm)
        .run();
      const row = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(car.id).first();
      return json(rowToCar(row));
    }

    // ---- API: one / update / delete ----
    const m = /^\/api\/cars\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const row = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(id).first();
        if (!row || (row.status || 'aktiv') !== 'aktiv') return json({ error: 'Nicht gefunden' }, 404);
        return json(rowToCar(row));
      }
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const row = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'Nicht gefunden' }, 404);

      if (method === 'DELETE') {
        const gone = rowToCar(row);
        await env.DB.prepare(
          'INSERT INTO archiv (id, typ, titel, payload, erstelltAm, archiviertAm) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind('arc-' + Date.now(), 'auto-gelöscht', gone.titel, JSON.stringify(gone), gone.erstelltAm, new Date().toISOString()).run();
        await env.DB.prepare('DELETE FROM cars WHERE id = ?').bind(id).run();
        for (const k of rowToCar(row).bilder) {
          try { await env.UPLOADS.delete(k); } catch { /* ignore */ }
        }
        return json({ ok: true });
      }

      if (method === 'PUT') {
        const form = await request.formData();
        const f = parseCarFields(form);
        const keep = String(form.get('keepBilder') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const oldImgs = rowToCar(row).bilder || [];
        for (const k of oldImgs.filter((x) => !keep.includes(x))) {
          try { await env.UPLOADS.delete(k); } catch { /* ignore */ }
        }
        let names = [];
        try {
          names = await storeUploads(env, form.getAll('bilder'));
        } catch (e) {
          return json({ error: String(e.message || e) }, 400);
        }
        const bilder = JSON.stringify([...keep, ...names].slice(0, MAX_FILES));
        await env.DB.prepare(
          'UPDATE cars SET titel=?, preis=?, km=?, baujahr=?, kraftstoff=?, getriebe=?, leistung=?, hu=?, beschreibung=?, bilder=? WHERE id=?'
        )
          .bind(f.titel, f.preis, f.km, f.baujahr, f.kraftstoff, f.getriebe, f.leistung, f.hu, f.beschreibung, bilder, id)
          .run();
        const updated = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(id).first();
        return json(rowToCar(updated));
      }
    }

    // ---- API: admin cars (all statuses) ----
    if (path === '/api/admin/cars' && method === 'GET') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const { results } = await env.DB.prepare(
        'SELECT * FROM cars ORDER BY erstelltAm DESC'
      ).all();
      return json((results || []).map(rowToCar));
    }

    // ---- API: car status (aktiv / versteckt / verkauft) ----
    const mst = /^\/api\/cars\/([^/]+)\/status$/.exec(path);
    if (mst && method === 'POST') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      let status = '';
      try { status = (await request.json())?.status || ''; } catch { /* ignore */ }
      if (!['aktiv', 'versteckt', 'verkauft'].includes(status)) {
        return json({ error: 'Unbekannter Status' }, 400);
      }
      const srow = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(decodeURIComponent(mst[1])).first();
      if (!srow) return json({ error: 'Nicht gefunden' }, 404);
      if (status === 'verkauft') {
        const car = rowToCar(srow);
        await env.DB.prepare(
          'INSERT INTO archiv (id, typ, titel, payload, erstelltAm, archiviertAm) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind('arc-' + Date.now(), 'auto-verkauft', car.titel, JSON.stringify(car), car.erstelltAm, new Date().toISOString()).run();
      }
      await env.DB.prepare('UPDATE cars SET status = ? WHERE id = ?').bind(status, srow.id).run();
      const updated = await env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(srow.id).first();
      return json(rowToCar(updated));
    }

    // ---- API: archiv / journal ----
    if (path === '/api/archiv' && method === 'GET') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await sweepTermine(env);
      const { results } = await env.DB.prepare(
        'SELECT * FROM archiv ORDER BY archiviertAm DESC'
      ).all();
      return json(results || []);
    }
    if (path === '/api/archiv' && method === 'DELETE') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await env.DB.prepare('DELETE FROM archiv').run();
      return json({ ok: true });
    }
    const marc = /^\/api\/archiv\/([^/]+)$/.exec(path);
    if (marc && method === 'DELETE') {
      if (request.headers.get('x-admin-key') !== env.ADMIN_PASSWORD) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await env.DB.prepare('DELETE FROM archiv WHERE id = ?').bind(decodeURIComponent(marc[1])).run();
      return json({ ok: true });
    }

    // ---- everything else: static frontend ----
    return env.ASSETS.fetch(request);
  },
};
