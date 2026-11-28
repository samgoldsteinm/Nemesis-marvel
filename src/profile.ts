// Player profile: a name chosen once and stored on this device (localStorage). It is shown on the fight HUD and
// results, and sent to the opponent online (in the lobby 'pick' message). No server account: it lives per device.

export const NAME_MAX = 14;
/** Letters (any script), digits, space, _ - . only, so a name is always safe to drop into markup. */
export function cleanName(v: unknown): string {
  return String(v ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
export let playerName = '';
try { playerName = cleanName(localStorage.getItem('bl.name')); } catch { /* storage optional */ }
export function setPlayerName(v: string): string {
  playerName = cleanName(v);
  try { if (playerName) localStorage.setItem('bl.name', playerName); else localStorage.removeItem('bl.name'); } catch { /* */ }
  return playerName;
}
/** The stored name, or the fallback when none is set. */
export function nameOr(fallback: string) { return playerName || fallback; }
