import site from '../content/site.json';
export const GET = () => new Response(site.adsense_client ? `google.com, ${site.adsense_client.replace('ca-', '')}, DIRECT, f08c47fec0942fa0\n` : '', { headers: { 'Content-Type': 'text/plain' } });
