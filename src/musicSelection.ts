export interface MusicSelectionCandidate {
  id?: string;
  url: string;
  name: string;
  artists: string[];
}

export function normalizeMusicKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateKey(candidate: MusicSelectionCandidate): string {
  return normalizeMusicKey(candidate.url || candidate.id || candidate.name);
}

function artistMatches(candidate: MusicSelectionCandidate, requestedArtist: string): boolean {
  const needle = normalizeMusicKey(requestedArtist);
  if (!needle) return false;

  return candidate.artists.some(artist => {
    const haystack = normalizeMusicKey(artist);
    return haystack.includes(needle) || needle.includes(haystack);
  });
}

export function rankArtistBoundTracks(
  candidates: MusicSelectionCandidate[],
  requestedArtist: string,
  recentCandidates: Set<string>
): MusicSelectionCandidate[] {
  const matching = candidates.filter(candidate => artistMatches(candidate, requestedArtist));
  if (!matching.length) return [];

  const fresh = matching.filter(candidate => !recentCandidates.has(candidateKey(candidate)));
  const recent = matching.filter(candidate => recentCandidates.has(candidateKey(candidate)));
  return [...fresh, ...recent];
}
