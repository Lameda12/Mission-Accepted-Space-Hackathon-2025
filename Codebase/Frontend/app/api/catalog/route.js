import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { FIELDS, compactOmm, tleToOmm } from '@/lib/catalog';
import featured from '@/data/featured.json';

// CelesTrak updates GP data every 2 hours and allows one download per update, so the
// route is statically generated and revalidated on that cadence (one fetch per cycle,
// shared by every visitor).
export const dynamic = 'force-static';
export const revalidate = 7200;

const SOURCE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
const MIN_EXPECTED_OBJECTS = 1000;

async function fetchActiveCatalog() {
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'SatelLocator/1.0 (+https://github.com/Lameda12/Mission-Accepted-Space-Hackathon-2025)' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`CelesTrak responded ${res.status}`);
  // CelesTrak answers throttled requests with a plain-text notice, so check before parsing
  const body = await res.text();
  if (!body.trimStart().startsWith('[')) throw new Error(`CelesTrak returned non-JSON: ${body.slice(0, 120)}`);
  const omms = JSON.parse(body);
  if (omms.length < MIN_EXPECTED_OBJECTS) throw new Error(`CelesTrak returned only ${omms.length} objects`);
  return omms.map(compactOmm);
}

function fallbackCatalog() {
  return featured.map((s) => compactOmm(tleToOmm(s.name, s.tle1, s.tle2)));
}

export async function GET() {
  const generatedAt = new Date().toISOString();
  try {
    const objects = await fetchActiveCatalog();
    return Response.json({ source: 'celestrak', generatedAt, fields: FIELDS, count: objects.length, objects });
  } catch (err) {
    // During production ISR revalidation, throw: Next keeps serving the last good catalog.
    // At build time (and in local dev), ship the bundled snapshot so the app still works.
    const revalidatingInProduction =
      process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD;
    if (revalidatingInProduction) throw err;
    console.error('Catalog fetch failed, using bundled snapshot:', err.message);
    const objects = fallbackCatalog();
    return Response.json({
      source: 'fallback',
      error: err.message,
      generatedAt,
      fields: FIELDS,
      count: objects.length,
      objects,
    });
  }
}
