// Bilingual i18n (Spanish default, English toggle). Wraps i18n-js in a React
// context so switching locale re-renders the whole tree.
import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

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
      source: 'Fuente',
      notes: 'Notas',
      route: 'Ruta',
      changed: 'Cambio anunciado',
      canceled: 'Cancelada',
      lastVerified: 'Verificada el',
    },
    tabs: { feed: 'Carreras', myRaces: 'Mis carreras' },
    feed: {
      title: 'Carreras',
      subtitle: 'Monterrey y Nuevo León',
      search: 'Buscar carrera o ciudad…',
      empty: 'No se encontraron carreras.',
    },
    filters: {
      all: 'Todas',
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
      showResults: 'Ver %{count} carreras',
    },
    detail: {
      buy: 'Comprar boleto',
      noLink: 'Registro próximamente',
      save: 'Guardar',
      saved: 'Guardada',
      addCalendar: 'Agregar al calendario',
      calendarAdded: 'Agregada a tu calendario',
      calendarNoDate: 'Esta carrera aún no tiene fecha confirmada.',
      permission: 'Necesitamos permiso para acceder a tu calendario.',
      viewSource: 'Ver fuente',
      close: 'Cerrar',
      openBrowser: 'Abrir en el navegador',
      openMaps: 'Abrir en Mapas',
      approxLocation: 'Ubicación aproximada del punto de salida',
    },
    myraces: {
      title: 'Mis carreras',
      empty: 'Aún no has guardado carreras.\nExplora y guarda las que te interesen.',
    },
    city: {
      title: 'Elige tu ciudad',
      useLocation: 'Usar mi ubicación',
      detectFailed: 'No pudimos detectar tu ubicación — elige tu ciudad manualmente.',
      mxOnly: 'Disponible en México por ahora.',
      emptyRegion: 'Aún no tenemos carreras en %{city}.\nEstamos trabajando en ello — por ahora explora Monterrey.',
      locationOn: 'usando tu ubicación',
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
      source: 'Source',
      notes: 'Notes',
      route: 'Route',
      changed: 'Change announced',
      canceled: 'Canceled',
      lastVerified: 'Verified on',
    },
    tabs: { feed: 'Races', myRaces: 'My races' },
    feed: {
      title: 'Races',
      subtitle: 'Monterrey & Nuevo León',
      search: 'Search race or city…',
      empty: 'No races found.',
    },
    filters: {
      all: 'All',
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
      showResults: 'Show %{count} races',
    },
    detail: {
      buy: 'Buy ticket',
      noLink: 'Registration coming soon',
      save: 'Save',
      saved: 'Saved',
      addCalendar: 'Add to calendar',
      calendarAdded: 'Added to your calendar',
      calendarNoDate: 'This race has no confirmed date yet.',
      permission: 'We need permission to access your calendar.',
      viewSource: 'View source',
      close: 'Close',
      openBrowser: 'Open in browser',
      openMaps: 'Open in Maps',
      approxLocation: 'Approximate start location',
    },
    myraces: {
      title: 'My races',
      empty: "You haven't saved any races yet.\nBrowse and save the ones you like.",
    },
    city: {
      title: 'Choose your city',
      useLocation: 'Use my location',
      detectFailed: "We couldn't detect your location — pick your city manually.",
      mxOnly: 'Available in Mexico for now.',
      emptyRegion: "No races in %{city} yet.\nWe're working on it — explore Monterrey meanwhile.",
      locationOn: 'using your location',
    },
  },
};

const i18n = new I18n(translations);
i18n.enableFallback = true;
i18n.defaultLocale = 'es';

type Locale = 'es' | 'en';
const deviceLocale: Locale = getLocales()[0]?.languageCode === 'en' ? 'en' : 'es';

interface I18nValue {
  t: (key: string, options?: Record<string, unknown>) => string;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(deviceLocale);
  i18n.locale = locale;

  const setLocale = useCallback((l: Locale) => {
    i18n.locale = l;
    setLocaleState(l);
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
