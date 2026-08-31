/**
 * Icon URL helper — routes all EVE item type icon requests through the FORGE
 * server's disk-cached proxy instead of hitting CCP's CDN directly.
 *
 * First request per typeId is fetched from CCP and saved to disk on the server.
 * All subsequent requests are served from disk (~0-1ms) with a 1-year cache
 * header, so the browser never needs to go to CCP again.
 *
 * CHARACTER PORTRAITS and CORPORATION LOGOS are NOT proxied here — they can
 * change when a player edits their character or a corp changes their logo.
 * Use the CCP CDN URLs directly for those.
 *
 * @param typeId  EVE item type ID (the numeric identifier for any in-game item)
 * @param size    Icon pixel size — 22, 32, or 64 (default 32)
 */
export function itemIconUrl(
  typeId: number | string,
  size = 32,
  variant: 'icon' | 'bp' | 'bpc' = 'icon',
): string {
  return `/api/icon/${typeId}?size=${size}&variant=${variant}`;
}
