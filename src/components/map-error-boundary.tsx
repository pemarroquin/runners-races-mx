// A crash in a map must not cost the runner their run.
//
// This app had no error boundary anywhere, so ANY throw unmounted the whole
// React tree and left a blank white page. That is not theoretical: a Mapbox
// teardown call in track-map.web.tsx's shimmer cleanup threw on every single
// session end, and because the throw happened above the tab layout, the app
// went blank at the exact moment a finished run was waiting to be saved —
// with the only copy of that run in memory (see index.tsx's save path).
//
// The boundary goes around the MAP, not around the screen, on purpose: the
// run itself lives in useRunTracker() in the parent, so keeping the parent
// mounted is what keeps the run alive. A dead map then costs a map.
//
// It reports rather than swallows — the error is re-thrown to the console so
// a crash is still visible to anyone looking, and the fallback says plainly
// that the map is gone. A silent boundary would turn a loud bug into an
// invisible one, which is how a broken map ships unnoticed.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  children: ReactNode;
  /** Shown in place of the map. Callers pass t('track.mapUnavailable') — the
   *  string already used for a map that fails to load, because from the
   *  runner's side these are the same event. */
  message: string;
  color: string;
  background: string;
}

interface State {
  failed: boolean;
}

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deliberately loud. There is no crash reporting in this app, so the
    // console is the only record that the map died at all.
    console.error('[map] crashed and was replaced by its fallback', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={[StyleSheet.absoluteFill, styles.fallback, { backgroundColor: this.props.background }]}>
        <Text style={[styles.text, { color: this.props.color }]}>{this.props.message}</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
});
