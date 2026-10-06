import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { parseKpProduct } from '@/lib/spaceWeather';

// Kp is a 3-hour index; refreshing every 15 minutes picks up new values promptly
export const dynamic = 'force-static';
export const revalidate = 900;

const SOURCE_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

export async function GET() {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`SWPC responded ${res.status}`);
    const kp = parseKpProduct(await res.json());
    return Response.json({ available: true, source: 'NOAA SWPC', ...kp });
  } catch (err) {
    // Same policy as the catalog: never fail the build, never overwrite good data at runtime
    const revalidatingInProduction =
      process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD;
    if (revalidatingInProduction) throw err;
    console.error('Kp fetch failed:', err.message);
    return Response.json({ available: false, error: err.message });
  }
}
