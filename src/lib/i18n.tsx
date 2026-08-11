// Bilingual i18n (Spanish default, English toggle). Wraps i18n-js in a React
// context so switching locale re-renders the whole tree.
import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getPref, initDb, setPref } from '@/lib/db';

// i18n-js pluralization: a translation value may be a flat string, or an
// object with `one`/`other` (and optionally `zero`) branches selected
// automatically from the `count` option passed at call time.
type PluralForm = { one: string; other: string; zero?: string };

const translations = {
  es: {
    common: {
      today: 'Hoy',
      daysAway: 'faltan %{count} días',
      oneDayAway: 'falta 1 día',
      past: 'Finalizada',
      tbd: 'Fecha por confirmar',
      when: 'Cuándo',
      where: 'Dónde',
      distances: 'Distancias',
      organizer: 'Organiza',
      notes: 'Notas',
      route: 'Ruta',
      changed: 'Cambio anunciado',
      canceled: 'Cancelada',
      lastVerified: 'Verificada el',
      more: 'Ver más',
      less: 'Ver menos',
      notFound: 'No encontramos esta carrera',
      back: 'Volver',
      unconfirmed: 'Sin confirmar',
      retry: 'Reintentar',
    },
    tabs: { feed: 'Carreras', myRaces: 'Mis carreras', settings: 'Ajustes' },
    feed: {
      title: 'Carreras',
      search: 'Buscar carrera o ciudad…',
      empty: 'No se encontraron carreras.',
      showPast: 'Ver anteriores',
      hidePast: 'Ocultar anteriores',
      otherCities: {
        one: '1 carrera en otra ciudad',
        other: '%{count} carreras en otras ciudades',
      } as PluralForm,
      updated: 'Datos actualizados',
      updateFailed: 'No pudimos actualizar los datos',
    },
    filters: {
      '3K': '3K',
      '5K': '5K',
      '10K': '10K',
      '15K': '15K',
      half: '21K',
      '30K': '30K',
      full: '42K',
      ultra: 'Ultra',
      tbd: 'Por confirmar',
      title: 'Filtros',
      distance: 'Distancia',
      date: 'Fecha',
      reset: 'Limpiar',
      clearAll: 'Limpiar todo',
      done: 'Listo',
      presetThisMonth: 'Este mes',
      presetNext3: 'Próximos 3 meses',
      presetAll: 'Todos',
    },
    detail: {
      buy: 'Comprar boleto',
      noLink: 'Registro próximamente',
      canceled: 'Carrera cancelada',
      viewRegistration: 'Ver registro',
      save: 'Guardar',
      saved: 'Guardada',
      saveFailed: 'No pudimos guardar la carrera en este dispositivo. Vuelve a intentarlo.',
      addCalendar: 'Agregar al calendario',
      calendarAdded: 'Agregada a tu calendario',
      calendarNoDate: 'Esta carrera aún no tiene fecha confirmada.',
      permission: 'Necesitamos permiso para acceder a tu calendario.',
      viewSource: 'Ver fuente',
      close: 'Cerrar',
      openBrowser: 'Abrir en el navegador',
      openMaps: 'Abrir en Mapas',
      approxLocation: 'Ubicación aproximada del punto de salida',
      share: 'Compartir',
      shareMessage: '%{name} — %{date}',
    },
    myraces: {
      title: 'Mis carreras',
      empty: 'Aún no has guardado carreras.\nExplora y guarda las que te interesen.',
      pastSection: 'Anteriores',
      upcomingSection: 'Próximas',
    },
    city: {
      title: 'Elige tu ciudad',
      useLocation: 'Usar mi ubicación',
      detectFailed: 'No pudimos detectar tu ubicación — elige tu ciudad manualmente.',
      mxOnly: 'Disponible en México por ahora.',
      emptyRegion: 'Aún no tenemos carreras en %{city}.\nEstamos trabajando en ello — por ahora explora Monterrey.',
      locationOn: 'usando tu ubicación',
    },
    settings: {
      title: 'Ajustes',
      version: 'Versión',
      support: 'Soporte',
      theme: 'Apariencia',
      themeSystem: 'Sistema',
      themeLight: 'Claro',
      themeDark: 'Oscuro',
    },
    privacy: {
      title: 'Privacidad',
      collectedTitle: 'Qué recopilamos',
      collectedLocation:
        'Ubicación aproximada: si das permiso de GPS, la usamos solo en este dispositivo para mostrarte carreras cercanas. Nunca sale de tu teléfono.',
      collectedIp:
        'Si el GPS no está disponible o no diste permiso, calculamos tu ciudad aproximada a partir de tu dirección IP con el servicio ipapi.co. Tu IP se envía a ipapi.co en ese momento — es lo único que sale de tu dispositivo, y solo pasa cuando no hay GPS.',
      collectedSaved:
        'Carreras guardadas: los IDs de las carreras que guardas quedan solo en este dispositivo (SQLite en iOS/Android, almacenamiento local en la versión web). No se sincronizan a ningún servidor.',
      notTitle: 'Qué no hacemos',
      notAccounts: 'No hay cuentas ni inicio de sesión.',
      notTracking: 'No rastreamos tu actividad ni usamos analítica.',
      notSharing: 'No vendemos ni compartimos tus datos con nadie.',
      notServer: 'No guardamos nada en un servidor propio: no existe una base de datos de usuarios.',
      deleteTitle: 'Borrar tus datos',
      deleteBody:
        'Como no guardamos nada en un servidor, no hay un trámite de "solicitar borrado" que ofrecer. Borrar la app de tu teléfono (o los datos del sitio en tu navegador, en la versión web) elimina todo lo guardado localmente.',
      ipapiLink: 'Política de privacidad de ipapi.co',
    },
  },
  en: {
    common: {
      today: 'Today',
      daysAway: '%{count} days away',
      oneDayAway: '1 day away',
      past: 'Finished',
      tbd: 'Date To Be Defined Yet',
      when: 'When',
      where: 'Where',
      distances: 'Distances',
      organizer: 'Organizer',
      notes: 'Notes',
      route: 'Route',
      changed: 'Change announced',
      canceled: 'Canceled',
      lastVerified: 'Verified on',
      more: 'Show more',
      less: 'Show less',
      notFound: 'We could not find this race',
      back: 'Back',
      unconfirmed: 'Unconfirmed',
      retry: 'Retry',
    },
    tabs: { feed: 'Races', myRaces: 'My races', settings: 'Settings' },
    feed: {
      title: 'Races',
      search: 'Search race or city…',
      empty: 'No races found.',
      showPast: 'Show past',
      hidePast: 'Hide past',
      otherCities: {
        one: '1 race in another city',
        other: '%{count} races in other cities',
      } as PluralForm,
      updated: 'Data updated',
      updateFailed: 'We could not update the data',
    },
    filters: {
      '3K': '3K',
      '5K': '5K',
      '10K': '10K',
      '15K': '15K',
      half: 'Half',
      '30K': '30K',
      full: 'Full',
      ultra: 'Ultra',
      tbd: 'TBD',
      title: 'Filters',
      distance: 'Distance',
      date: 'Date',
      reset: 'Reset',
      clearAll: 'Clear all',
      done: 'Done',
      presetThisMonth: 'This month',
      presetNext3: 'Next 3 months',
      presetAll: 'All',
    },
    detail: {
      buy: 'Buy ticket',
      noLink: 'Registration coming soon',
      canceled: 'Race canceled',
      viewRegistration: 'View registration',
      save: 'Save',
      saved: 'Saved',
      saveFailed: "We couldn't save this race on this device. Please try again.",
      addCalendar: 'Add to calendar',
      calendarAdded: 'Added to your calendar',
      calendarNoDate: 'This race has no confirmed date yet.',
      permission: 'We need permission to access your calendar.',
      viewSource: 'View source',
      close: 'Close',
      openBrowser: 'Open in browser',
      openMaps: 'Open in Maps',
      approxLocation: 'Approximate start location',
      share: 'Share',
      shareMessage: '%{name} — %{date}',
    },
    myraces: {
      title: 'My races',
      empty: "You haven't saved any races yet.\nBrowse and save the ones you like.",
      pastSection: 'Past',
      upcomingSection: 'Upcoming',
    },
    city: {
      title: 'Choose your city',
      useLocation: 'Use my location',
      detectFailed: "We couldn't detect your location — pick your city manually.",
      mxOnly: 'Available in Mexico for now.',
      emptyRegion: "No races in %{city} yet.\nWe're working on it — explore Monterrey meanwhile.",
      locationOn: 'using your location',
    },
    settings: {
      title: 'Settings',
      version: 'Version',
      support: 'Support',
      theme: 'Appearance',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
    },
    privacy: {
      title: 'Privacy',
      collectedTitle: 'What we collect',
      collectedLocation:
        "Approximate location: if you grant GPS permission, we use it only on this device to show nearby races. It never leaves your phone.",
      collectedIp:
        "If GPS isn't available or you didn't grant permission, we estimate your city from your IP address using the ipapi.co service. Your IP is sent to ipapi.co at that point — it's the only thing that ever leaves your device, and only when GPS isn't available.",
      collectedSaved:
        'Saved races: the IDs of races you save stay on this device only (SQLite on iOS/Android, local storage on the web version). Nothing syncs to any server.',
      notTitle: "What we don't do",
      notAccounts: 'No accounts, no login.',
      notTracking: 'No tracking your activity, no analytics.',
      notSharing: "We don't sell or share your data with anyone.",
      notServer: "Nothing is stored on a server we run — there's no database of users.",
      deleteTitle: 'Deleting your data',
      deleteBody:
        'Since nothing is stored on a server, there\'s no "request deletion" process to offer. Deleting the app from your phone (or clearing the site\'s data in your browser, on the web version) removes everything stored locally.',
      ipapiLink: 'ipapi.co privacy policy',
    },
  },
};

const i18n = new I18n(translations);
i18n.enableFallback = true;
i18n.defaultLocale = 'es';

type Locale = 'es' | 'en';
const deviceLocale: Locale = getLocales()[0]?.languageCode === 'en' ? 'en' : 'es';
// Keep the singleton consistent with the initial provider state from the
// very first render — it is otherwise only ever mutated from an effect or
// an event handler (see LocaleProvider below), never during render.
i18n.locale = deviceLocale;

const PREF_LOCALE = 'locale';

interface I18nValue {
  t: (key: string, options?: Record<string, unknown>) => string;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(deviceLocale);

  // Rehydrate a previously persisted locale choice on mount. initDb() is
  // idempotent, so calling it here removes any dependency on provider
  // ordering elsewhere in the tree. Never read prefs at module scope — on
  // native that would run before the database is open.
  useEffect(() => {
    try {
      initDb();
    } catch {
      // Ignore — getPref below degrades to null when the db isn't open.
    }
    try {
      const stored = getPref(PREF_LOCALE);
      if (stored === 'es' || stored === 'en') {
        i18n.locale = stored;
        setLocaleState(stored);
      }
    } catch {
      // Storage failure — keep the device-derived locale already in state.
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    i18n.locale = l;
    setLocaleState(l);
    try {
      setPref(PREF_LOCALE, l);
    } catch {
      // A storage failure must never crash the language toggle.
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ t: (key, options) => i18n.t(key, options), locale, setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within a LocaleProvider');
  return ctx;
}

/** Human countdown label for a race date, localized. */
export function useCountdown() {
  const { t } = useI18n();
  return useCallback(
    (days: number | null): string => {
      if (days === null) return t('common.tbd');
      if (days < 0) return t('common.past');
      if (days === 0) return t('common.today');
      if (days === 1) return t('common.oneDayAway');
      return t('common.daysAway', { count: days });
    },
    [t],
  );
}
