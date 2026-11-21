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
 * CCP's image server only serves type icons at 32 and 64 px — it answers 400 to anything else
 * (size 22 broke every Station Trading icon, Nov 2026). So the requested size is rounded up to one CCP
 * serves; set the on-screen size with the <img> width/height instead.
 *
 * @param typeId  EVE item type ID (the numeric identifier for any in-game item)
 * @param size    Wanted pixel size (default 32); 32 or less fetches 32, larger fetches 64
 */
export function itemIconUrl(
  typeId: number | string,
  size = 32,
  variant: 'icon' | 'bp' | 'bpc' = 'icon',
): string {
  const ccpSize = size <= 32 ? 32 : 64;
  return `/api/icon/${typeId}?size=${ccpSize}&variant=${variant}`;
}
