// Ticketing / registration platforms, keyed by hostname. `platform` on a race
// is DERIVED from its URLs, never typed by hand, so it can't drift the way
// `organizer` did (Asdeporte was spelled 18 ways because that one field held
// both the ticketing site and the organizer). `organizer` is left as written:
// splitting it needs a source per race, which is a sweep's job, not a regex's.
//
// Add a host here when a sweep finds a new platform that lists 2+ races.
export const PLATFORMS = {
  'asdeporte.com': 'asdeporte',
  'tritour.org': 'tritour',
  'marcate.com.mx': 'marcate',
  'idemsport.com': 'idemsport',
  'khronometraje.com': 'khronometraje',
  'emociondeportiva.com': 'emociondeportiva',
  'chronostart.com.mx': 'chronostart',
  'carrerasmexico.com': 'carrerasmexico',
  'trotime.com.mx': 'trotime',
  'runera.mx': 'runera',
  'dashport.run': 'dashport',
  'running.life': 'runninglife',
  'rockthesport.com': 'rockthesport',
  'tim3.com.mx': 'tim3',
  'hubsports.mx': 'hubsports',
};

/** Platform id for one URL, or null when the host isn't a known platform. */
export function platformOfUrl(url) {
  if (typeof url !== 'string') return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [domain, id] of Object.entries(PLATFORMS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return id;
  }
  return null;
}

/** The registration link names the platform; the source link is the fallback
 *  (a canceled race keeps sourceUrl but has signupUrl: null). */
export function platformOf(race) {
  return platformOfUrl(race.signupUrl) ?? platformOfUrl(race.sourceUrl);
}
