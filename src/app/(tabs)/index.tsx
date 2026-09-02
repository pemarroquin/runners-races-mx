// Territory Mode's main screen: record a run, close it into a fence, save it.
// Phase 1 of the feature plan — no leaderboard and no cross-user overlap yet,
// but every saved run already lands in Supabase, so those read from real data
// when they land.
//
// The map is the screen, not a card on it: streets are visible from the
// moment the tab opens, and the controls sit over them. See track-map.tsx
// for why the route is baked into the Mapbox image rather than overlaid.
import { useIsFocused } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FenceMap } from '@/components/fence-map';
import { TrackMap } from '@/components/track-map';
import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { FENCE_MAP_ASPECT } from '@/lib/mapbox';
import { getHomeZone } from '@/lib/home-point';
import { saveLastRunDebug } from '@/lib/last-run-debug';
import { maskPath, type MaskResult } from '@/lib/privacy-zone';
import { incrementPilotCounter } from '@/lib/pilot-instrumentation';
import { clearCheckpoint, loadCheckpoint, type RunCheckpoint } from '@/lib/run-checkpoint';
import { buildFence, type FenceResult } from '@/lib/territory';
import {
  deleteRun as deleteRunRequest,
  fetchMyFences,
  fetchRunSpoils,
  uploadRun,
  type DeleteOutcome,
  type MyFence,
  type RunSpoils,
  type SyncOutcome,
} from '@/lib/territory-sync';
import { formatArea, formatDistance, formatDuration, useRunTracker } from '@/lib/tracking';
import { enqueueRun, flushQueue, queuedCount, removeQueued } from '@/lib/upload-queue';
import { useCurrentLocation } from '@/lib/use-current-location';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

// Not in constants/theme.ts: these are traffic-light semantics for one
// control pair, not part of the app's palette.
const PAUSE_COLOR = '#F5C518';
const STOP_COLOR = '#E5484D';

export default function TrackScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const tracker = useRunTracker();
  const isFocused = useIsFocused();

  const running = tracker.status === 'running';
  const starting = tracker.status === 'starting';
  const paused = tracker.status === 'paused';
  // Local, not derived from tracker.status: status stays 'paused' for the
  // ENTIRE resume() async gap (beginRecording() awaits the watcher before
  // flipping to 'running'). The duplicate-watch race that gap used to open
  // is already closed (65d8f3d's epoch guard), so a double-tap here is
  // harmless — but nothing told the runner a tap had registered, so nothing
  // stopped one anyway (2026-09-01 review finding, the remaining UX half).
  const [resuming, setResuming] = useState(false);
  const toggleRun = useCallback(() => {
    if (paused) {
      setResuming(true);
      void tracker.resume().finally(() => setResuming(false));
    } else {
      tracker.pause();
    }
  }, [paused, tracker]);
  // A session "owns" the screen from the moment Start is pressed: the map
  // goes full-bleed 3D, and the idle chrome (scrim + title + Start) gets out
  // of the way rather than sitting on top of the run.
  const inSession = running || starting || paused;

  // The tracker's own subscription supplies positions once a session is
  // live, so the standalone watcher only runs when it's the sole source:
  // this tab is on screen AND no session is recording. Without the focus
  // gate it would hold the GPS on from another tab; without the session
  // gate two subscriptions would run at once.
  const location = useCurrentLocation({ watch: isFocused && !inSession });

  // Where the map should say the runner is. During a session the standalone
  // watcher above is off, so the tracker's RAW fix stream takes over — using
  // its filtered point list instead froze the pin on the first fix whenever
  // the accuracy filter was rejecting everything after it.
  const here = inSession ? (tracker.lastFix ?? location.coords) : location.coords;

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failure, setFailure] = useState<SyncOutcome | null>(null);
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  // What this run took from other runners. Null until the upload lands —
  // the Phase 3 trigger runs during the insert, so the answer exists by the
  // time uploadRun returns, but only a read can tell us what it was.
  const [spoils, setSpoils] = useState<RunSpoils | null>(null);
  const [pastFences, setPastFences] = useState<MyFence[]>([]);
  const [pastFencesFailed, setPastFencesFailed] = useState(false);
  // Runs that failed to upload and are waiting on the device. Read on mount
  // and kept in sync locally so the screen can say a run is safe rather than
  // leaving the runner to guess.
  const [pending, setPending] = useState(0);
  // The queue id of this run once it has been written to disk, or null.
  // An ID rather than a boolean because the run has to be REMOVABLE: a
  // manual retry that succeeds, or a discard, must take it back out. With
  // only a flag there was no handle, so a discarded run uploaded itself
  // later and a successful retry uploaded the same run twice.
  const [queuedId, setQueuedId] = useState<string | null>(null);
  // Guards save() against a discard() that lands while its upload is still
  // in flight. discard() bumps this; save() captures the value BEFORE
  // awaiting uploadRun() and checks it's unchanged before applying the
  // outcome. Without this, tapping Discard mid-upload reset the screen
  // immediately, but the suspended save() call still ran to completion on
  // its stale `payload` closure and unconditionally enqueued it on failure
  // (or banked spoils on success) — a run the runner explicitly threw away
  // silently re-entered the persistent upload queue and reappeared later
  // (2026-09-01 review finding). A ref, not state: needs to be read
  // synchronously inside the async continuation, never a stale closure.
  const saveTokenRef = useRef(0);

  // Task 1 — the one-shot guard for auto-save. A ref, not state: state would
  // still be `false` on the SAME render that flips tracker.status/masked/
  // fence to their post-finish values (state updates from an effect aren't
  // visible until the next render), so an effect gated on state alone can
  // read a stale `false` and fire save() twice across fast re-renders. A
  // ref is written synchronously the instant the effect body runs, closing
  // that window. Reset to false only when the summary screen is fully torn
  // down (resetLocal, below) — that's what lets the NEXT run auto-save too.
  const autoSavedRef = useRef(false);

  // Task 2 — deleteRun() outcome. Separate from saveState/failure: a run
  // can be successfully SAVED and then fail to DELETE — two different
  // network calls, two different failure surfaces, and conflating them
  // would show "your save failed" copy for a delete that failed instead.
  const [deleteState, setDeleteState] = useState<'idle' | 'deleting' | 'failed'>('idle');
  const [deleteFailure, setDeleteFailure] = useState<DeleteOutcome | null>(null);
  // One tap arms the honest confirmation copy (deleteRun does not undo
  // territory already taken from other runners); a second tap actually
  // deletes. Inline rather than a native Alert.alert — react-native-web's
  // Alert.alert is a documented no-op (`static alert() {}`), which would
  // make "Delete run" silently do nothing on the web build.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // An in-progress run recovered from run-checkpoint.ts after a reload —
  // see that file's header. Read once on mount, not on every focus: a
  // checkpoint only ever appears from a dead tab reloading, never while this
  // component stays mounted, so re-checking on refocus would just find the
  // same value or (worse) the one the runner already dismissed.
  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  useEffect(() => {
    // Deferred by a tick, not called straight from the effect body — the
    // React Compiler's lint rule traces a call through and flags any
    // setState it can reach as a synchronous effect update. Same pattern as
    // the queue-drain effect below and use-current-location.ts's
    // autoRequest.
    const id = setTimeout(() => {
      setCheckpoint(loadCheckpoint());
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const resumeCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    const cp = checkpoint;
    setCheckpoint(null);
    // A recoverable checkpoint was actually accepted and used — see
    // pilot-instrumentation.ts.
    incrementPilotCounter('runsRecovered');
    void tracker.restoreFromCheckpoint(cp);
  }, [checkpoint, tracker]);

  const discardCheckpoint = useCallback(() => {
    clearCheckpoint();
    setCheckpoint(null);
    // The runner explicitly gave up a recoverable run — see
    // pilot-instrumentation.ts.
    incrementPilotCounter('runsLost');
  }, []);

  // Drain the queue when the Track tab opens. This is the landing route, so
  // in practice it runs at app start — which is exactly when a run that
  // failed on a trail yesterday should quietly go up.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      const before = queuedCount();
      if (before === 0) {
        setPending(0);
        return;
      }
      setPending(before);
      flushQueue(uploadRun).then((result) => {
        if (!stale) setPending(result.remaining);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused]);

  // This run's fence colour — deterministic from startedAt, so the live
  // ribbon, the summary highlight, and the Saved tab all derive the same
  // one. See FENCE_COLOR_SETS.
  const fenceColor = useMemo(
    () => fenceColorForRun(tracker.startedAt ?? 0).color,
    [tracker.startedAt],
  );

  // The finished run, after privacy masking. Computed ONCE when the run
  // ends and held in state — NOT a useMemo. maskPath draws a random cut
  // distance (see privacy-zone.ts), so recomputing would re-roll the jitter
  // and quietly change the fence's shape between render, display and
  // upload. The runner must see exactly what gets uploaded.
  const [masked, setMasked] = useState<MaskResult | null>(null);
  const [fence, setFence] = useState<FenceResult | null>(null);

  useEffect(() => {
    if (tracker.status !== 'finished') return;
    const id = setTimeout(() => {
      const result = maskPath(tracker.points, getHomeZone());
      setMasked(result);
      // The fence is rebuilt from the MASKED path, never clipped from the
      // full one — see privacy-zone.ts for why cutting the finished polygon
      // would draw a circle around the runner's home.
      const builtFence = result.points.length > 0 ? buildFence(result.points) : null;
      setFence(builtFence);
      // Diagnostic escape hatch (last-run-debug.ts) — the RAW, pre-mask
      // points, so a suspicious area report can be re-run through
      // buildFence() against exactly what was recorded, not what got
      // trimmed for upload. Overwrites whatever the previous run left.
      if (tracker.startedAt !== null && tracker.endedAt !== null) {
        saveLastRunDebug({
          points: tracker.points,
          distanceM: tracker.distanceM,
          areaM2: builtFence?.areaM2 ?? null,
          startedAt: tracker.startedAt,
          endedAt: tracker.endedAt,
        });
      }
    }, 0);
    return () => clearTimeout(id);
  }, [tracker.status, tracker.points, tracker.distanceM, tracker.startedAt, tracker.endedAt]);

  // Everything already captured, for the summary map. Fetched when the run
  // finishes (before any save), so the list never contains the run on
  // screen; `savedRunId` guards the refetch-after-save case anyway.
  const finished = tracker.status === 'finished';
  useEffect(() => {
    if (!finished) return;
    let stale = false;
    fetchMyFences().then((outcome) => {
      if (stale) return;
      if (outcome.ok) {
        setPastFences(outcome.fences);
        setPastFencesFailed(false);
      } else {
        // 'disabled' is a configuration state, not a failure — nothing to
        // load, nothing to apologise for.
        setPastFencesFailed(outcome.reason !== 'disabled');
      }
    });
    return () => {
      stale = true;
    };
  }, [finished]);

  const save = useCallback(async () => {
    if (!fence || masked === null || tracker.startedAt === null || tracker.endedAt === null) {
      return;
    }
    const token = ++saveTokenRef.current;
    setSaveState('saving');
    setFailure(null);
    // ONE payload, built once, used by BOTH the upload and the retry queue.
    //
    // The two paths must never disagree about what a run contains — most
    // sharply about `points`. `masked.points` is the privacy-trimmed path
    // (privacy-zone.ts); the raw track must never leave this function, and
    // that includes the copy the retry queue persists to disk. Two separate
    // literals here would auto-merge without conflict while quietly
    // diverging, so an upload that SUCCEEDS would send the masked path
    // while one that FAILS persisted the unmasked one and shipped it on the
    // next app open.
    const payload = {
      points: masked.points,
      fence,
      // TRUE distance and duration, not the masked path's — neither reveals
      // where you live, both are the runner's actual achievement, and a
      // future anti-cheat pace check needs the real numbers to be honest.
      distanceM: tracker.distanceM,
      startedAt: tracker.startedAt,
      endedAt: tracker.endedAt,
    };

    const outcome = await uploadRun(payload);
    // A discard() landed while this upload was still in flight — the runner
    // has already moved on and the screen has already reset. Applying this
    // outcome now would resurrect a thrown-away run: enqueue it on failure,
    // or bank stale spoils/saved state over a screen that no longer shows
    // this run. See saveTokenRef's own comment.
    if (token !== saveTokenRef.current) return;
    if (outcome.ok) {
      setSaveState('saved');
      setSavedRunId(outcome.runId);
      // This run may already be queued from an earlier failed attempt. Take
      // it out now that it is safely on the server, or the next app open
      // uploads it a second time — a duplicate row whose fence carves
      // territory off other runners all over again.
      if (queuedId) {
        removeQueued(queuedId);
        setQueuedId(null);
        setPending(queuedCount());
      }
      // The run-checkpoint copy exists ONLY to survive a crash before the
      // run reaches durable storage. It just did — leaving the checkpoint
      // behind would offer "Resume" on a run that's already saved.
      clearCheckpoint();
      // Best-effort: a failed read here just means no "you took territory"
      // line, never a failed save. The run is already banked.
      const taken = await fetchRunSpoils(outcome.runId);
      if (taken.ok && taken.spoils.runsAffected > 0) setSpoils(taken.spoils);
    } else {
      // Keep the run on screen. It only exists in memory, so clearing it on
      // a failed upload would destroy the thing the runner just earned.
      setSaveState('failed');
      setFailure(outcome);
      // AND persist it, so closing the tab no longer destroys it either.
      // Only claim it's queued if the write actually succeeded — blocked
      // storage must not produce a false "your run is safe".
      // 'auth' as well as 'network' — and that is not defensive padding.
      // uploadRun calls ensureSession() BEFORE it does anything it maps to
      // 'network', and ensureSession signs in anonymously, which is itself
      // a network call. So a first run with no signal fails as 'auth', not
      // 'network' — precisely the 10km-on-a-trail case this queue exists
      // for, and it was the one case not being caught.
      // 'disabled' too, as of 2026-08-31 — it used to be excluded on the
      // reasoning that a build with no server configured can never upload,
      // so queuing would just accumulate dead weight. That reasoning missed
      // that the BUILD can change under the runner without them doing
      // anything: a deploy that's missing EXPO_PUBLIC_SUPABASE_* is exactly
      // as recoverable as a dead network once the config lands — the next
      // build simply has TERRITORY_ENABLED=true. Excluding it meant a
      // misconfigured deploy didn't just fail a save, it discarded the run
      // outright — which is precisely what happened, and this queue exists
      // to prevent exactly that. flushQueue's MAX_ATTEMPTS never fires for
      // 'disabled' specifically (see upload-queue.ts) — otherwise the
      // queue's own retry-exhaustion would delete the run before the fix
      // ever landed.
      if (outcome.reason === 'network' || outcome.reason === 'auth' || outcome.reason === 'disabled') {
        const id = enqueueRun(payload);
        setQueuedId(id);
        setPending(queuedCount());
        // Same reasoning as the success branch — but ONLY once the run is
        // actually durable in the upload queue. A failed enqueue write
        // (id === null) leaves the run in memory alone, so the checkpoint
        // is the only thing standing between it and a lost tab.
        if (id) clearCheckpoint();
      }
    }
  }, [fence, masked, queuedId, tracker.distanceM, tracker.startedAt, tracker.endedAt]);

  // Task 1 — fire save() itself, exactly once, the moment the finished run
  // has everything save() needs (fence + masked path). Gated on the REF, not
  // on saveState: saveState starts 'idle' and save() itself flips it to
  // 'saving' synchronously, so a state-only guard would race a fast
  // re-render between "fence just became non-null" and "saveState just
  // became 'saving'" and could invoke save() twice. The ref closes that
  // window because it's set before save() is even called, in the same
  // synchronous effect body.
  //
  // autoSavedRef is reset to false only inside resetLocal (below), which
  // only runs once the summary is torn down — so a manual retry (tapping
  // "Reintentar", which calls save() directly, not through this effect) and
  // a failed-then-later-successful delete both leave the ref untouched and
  // this effect correctly never fires again for the SAME run.
  useEffect(() => {
    if (tracker.status !== 'finished') return;
    if (!fence || masked === null) return;
    if (autoSavedRef.current) return;
    autoSavedRef.current = true;
    void save();
  }, [tracker.status, fence, masked, save]);

  // Shared local teardown for both "close the summary" (X, always safe —
  // never deletes anything, the server row if any stays exactly as saved)
  // and "delete finished/failed" (handleDeleteRun, below — only reached
  // once the server side of a delete has either succeeded or was never
  // needed in the first place). Renamed from the pre-auto-save `discard`:
  // this function itself no longer decides whether anything is thrown
  // away, it only resets the SCREEN once that decision has already been
  // made and (if needed) already carried out against the server.
  const resetLocal = useCallback(() => {
    // Invalidate any in-flight save FIRST — see saveTokenRef's own comment.
    saveTokenRef.current++;
    // Let the NEXT run auto-save too.
    autoSavedRef.current = false;
    setSaveState('idle');
    setFailure(null);
    setSavedRunId(null);
    setSpoils(null);
    setMasked(null);
    setFence(null);
    // A run that never made it past 'failed' only exists in the queue, not
    // on the server — take it out so a later app-open doesn't upload a run
    // the runner just walked away from.
    if (queuedId) {
      removeQueued(queuedId);
      setPending(queuedCount());
    }
    setQueuedId(null);
    setPastFencesFailed(false);
    setDeleteState('idle');
    setDeleteFailure(null);
    setConfirmingDelete(false);
    tracker.reset();
  }, [tracker, queuedId]);

  // Task 2 — replaces the old unconditional discard(). By the time this is
  // reachable the run has usually already auto-saved, so "throwing it away"
  // now means actually deleting the server row, not just forgetting local
  // state. Only calls deleteRun() when there IS a server row (saveState
  // 'saved' with a savedRunId) — a run still 'saving', or one that only ever
  // reached 'failed' (nothing was ever inserted), has nothing to delete and
  // goes straight to the same local cleanup discard() always did.
  const handleDeleteRun = useCallback(async () => {
    if (saveState === 'saved' && savedRunId) {
      setDeleteState('deleting');
      setDeleteFailure(null);
      const outcome = await deleteRunRequest(savedRunId);
      if (!outcome.ok) {
        // Keep the run on screen exactly like a failed save does — it is
        // still safely on the server, and closing this screen now would
        // just make it harder to find, never actually lose it.
        setDeleteState('failed');
        setDeleteFailure(outcome);
        setConfirmingDelete(false);
        return;
      }
    }
    resetLocal();
  }, [saveState, savedRunId, resetLocal]);

  // The finished run gets its own scrolling layout: there's a fence image,
  // three stats and two actions to fit, which is more than can sit legibly
  // over a live map.
  if (tracker.status === 'finished') {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.summaryClose}>
          <RoundButton
            label={t('track.close')}
            onPress={resetLocal}
            background={c.backgroundElement}
            foreground={c.text}
            ios="xmark"
            android="close"
            // Belt-and-suspenders alongside save()'s own token guard: the
            // guard makes a mid-save discard SAFE, this makes it hard to
            // trigger by accident in the first place. Also disabled mid-
            // delete: closing while deleteRun() is in flight is fine
            // correctness-wise (handleDeleteRun keeps its own state), but
            // letting it fire mid-tap invites a second delete request.
            disabled={saveState === 'saving' || deleteState === 'deleting'}
          />
        </View>
        <ScrollView contentContainerStyle={styles.summary}>
          <Text style={[styles.summaryTitle, { color: c.text }]}>{t('track.summaryTitle')}</Text>

          {fence && (
            // A real interactive map, not a baked image: pan/zoom over the
            // territory just captured (gradient outline, this run's colour)
            // with every previous fence drawn muted around it.
            <Animated.View entering={FadeIn.duration(400)} style={styles.fenceMapWrap}>
              <FenceMap
                geometry={fence.geometry.geometry}
                // The MASKED path, never tracker.points — privacy-zone
                // trimming exists precisely so start/end aren't exposed, and
                // the summary map is a shareable surface. `masked` is only
                // set once tracker.status is 'finished' (see the effect
                // above), which is exactly when this branch renders.
                path={masked?.points ?? []}
                color={fenceColor}
                others={pastFences}
                excludeId={savedRunId}
              />
            </Animated.View>
          )}
          {pastFencesFailed && (
            <Text style={[styles.noticeSmall, { color: c.textSecondary }]}>
              {t('track.pastFencesFailed')}
            </Text>
          )}

          <View style={styles.stats}>
            <Stat label={t('track.time')} value={formatDuration(tracker.elapsedS)} c={c} />
            <Stat label={t('track.distance')} value={formatDistance(tracker.distanceM)} c={c} />
            <Stat label={t('track.area')} value={fence ? formatArea(fence.areaM2) : '—'} c={c} />
          </View>

          {/* The whole run happened inside the privacy zone, so there is
              nothing that can be uploaded without revealing it. Said plainly
              — silently refusing to save would look like a bug. */}
          {masked?.fullyInsideZone && (
            <Text style={[styles.notice, { color: c.accent }]}>{t('track.allInsideZone')}</Text>
          )}

          {!fence && !masked?.fullyInsideZone && (
            <Text style={[styles.notice, { color: c.textSecondary }]}>{t('track.noFence')}</Text>
          )}

          {/* Distance-gap instrumentation (Task B, 2026-08-31) — background/
              foreground cycles are real but untracked ground, unlike a
              pause, and this is the data that confirms or rules out the
              background-gap hypothesis for a reported distance shortfall.
              Diagnostic, not a claim: gapChordM is NEVER added to
              distanceM above. */}
          {tracker.gapCount > 0 && (
            <Text style={[styles.noticeSmall, { color: c.textSecondary }]}>
              {t('track.gapNotice', {
                count: tracker.gapCount,
                duration: formatDuration(tracker.gapDurationMs / 1000),
                chord: formatDistance(tracker.gapChordM),
              })}
            </Text>
          )}

          {/* Masking changed the shape on screen, so say so rather than
              letting the runner wonder why their loop looks clipped. */}
          {masked?.masked && !masked.fullyInsideZone && (
            <Text style={[styles.noticeSmall, { color: c.textSecondary }]}>
              {t('track.zoneMasked')}
            </Text>
          )}

          {queuedId !== null && saveState !== 'saved' && (
            <Text style={[styles.notice, { color: c.accent }]}>{t('track.queued')}</Text>
          )}
          {saveState === 'failed' && failure && !failure.ok && (
            <Text style={[styles.notice, { color: c.accent }]}>
              {failure.reason === 'disabled'
                ? t('track.syncDisabled')
                : failure.reason === 'auth'
                  ? t('track.syncFailedAuth')
                  : t('track.syncFailedNetwork')}
            </Text>
          )}
          {saveState === 'saved' && deleteState !== 'deleting' && (
            <Animated.Text
              entering={FadeInDown.duration(320)}
              style={[styles.notice, { color: c.accent }]}>
              {t('track.saved')}
            </Animated.Text>
          )}
          {/* Task 2 — deleteRun() failed. This is an honest failure, not a
              placeholder: until the delete-own policy migration is applied
              by hand (supabase/migrations/*_runs_delete_own.sql), it always
              will. The run stays fully intact on screen either way — same
              posture as a failed save. */}
          {deleteState === 'failed' && deleteFailure && !deleteFailure.ok && (
            <Text style={[styles.notice, { color: c.accent }]}>
              {deleteFailure.reason === 'disabled'
                ? t('track.deleteFailedDisabled')
                : deleteFailure.reason === 'auth'
                  ? t('track.deleteFailedAuth')
                  : t('track.deleteFailedNetwork')}
            </Text>
          )}

          {/* Phase 3's payoff. Deliberately its own banner rather than a
              line in the stats row: taking ground off another runner is the
              most interesting thing that can happen in a session, and it
              only appears when it actually happened. */}
          {spoils && (
            <Animated.View
              entering={FadeInDown.duration(400).delay(200)}
              style={[styles.spoils, { borderColor: fenceColor }]}>
              <Text style={[styles.spoilsArea, { color: c.text }]}>
                {t('track.tookArea', { area: formatArea(spoils.areaTakenM2) })}
              </Text>
              <Text style={[styles.spoilsFrom, { color: c.textSecondary }]}>
                {t('track.tookFrom', { count: spoils.runnersAffected })}
              </Text>
            </Animated.View>
          )}

          <View style={styles.summaryActions}>
            {fence && saveState !== 'saved' && (
              // Task 1 — this still exists for the manual-retry path
              // (saveState 'failed') and as a visual fallback for the brief
              // instant before the auto-save effect has fired; it is no
              // longer the runner's only way to save; save() itself already
              // fired automatically the moment the run finished.
              <PrimaryButton
                label={
                  saveState === 'saving'
                    ? t('track.saving')
                    : saveState === 'failed'
                      ? t('track.retry')
                      : t('track.save')
                }
                onPress={save}
                disabled={saveState === 'saving' || deleteState === 'deleting'}
                busy={saveState === 'saving'}
                c={c}
              />
            )}

            {/* Task 2 — "Discard" replaced with "Delete run". Confirms
                inline (never a native Alert.alert — see confirmingDelete's
                own comment) ONLY when there is a real server row to lose;
                a run still 'saving' can't be tapped (disabled below), and
                one that only ever reached 'failed' never reached the
                server, so there's nothing to confirm — it goes straight to
                local cleanup, same as the old unconditional Discard did. */}
            {confirmingDelete ? (
              <Animated.View entering={FadeIn.duration(200)} style={styles.deleteConfirm}>
                <Text style={[styles.noticeSmall, { color: c.textSecondary }]}>
                  {t('track.deleteConfirmBody')}
                </Text>
                <View style={styles.deleteConfirmActions}>
                  <Pressable
                    onPress={() => setConfirmingDelete(false)}
                    accessibilityRole="button"
                    hitSlop={10}>
                    <Text style={[styles.secondary, { color: c.textSecondary }]}>
                      {t('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void handleDeleteRun()}
                    accessibilityRole="button"
                    hitSlop={10}>
                    <Text style={[styles.secondary, { color: c.accent }]}>
                      {t('track.deleteConfirmAction')}
                    </Text>
                  </Pressable>
                </View>
              </Animated.View>
            ) : (
              <Pressable
                onPress={() => {
                  if (saveState === 'saved' && savedRunId) setConfirmingDelete(true);
                  else void handleDeleteRun();
                }}
                disabled={saveState === 'saving' || deleteState === 'deleting'}
                accessibilityRole="button"
                accessibilityState={
                  saveState === 'saving' || deleteState === 'deleting' ? { disabled: true } : {}
                }
                hitSlop={10}>
                <Text
                  style={[
                    styles.secondary,
                    {
                      color: c.textSecondary,
                      opacity: saveState === 'saving' || deleteState === 'deleting' ? 0.5 : 1,
                    },
                  ]}>
                  {deleteState === 'deleting' ? t('track.deleting') : t('track.deleteRun')}
                </Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.stage, { backgroundColor: c.backgroundElement }]}>
      <TrackMap
        points={tracker.points}
        running={running}
        here={here}
        active={inSession}
        fenceColor={fenceColor}
        dark={scheme === 'dark'}
        color={c.accent}
        placeholder={t('track.waiting')}
        placeholderColor={c.textSecondary}
        unavailable={t('track.mapUnavailable')}
        zoomInLabel={t('track.zoomIn')}
        zoomOutLabel={t('track.zoomOut')}
        recenterLabel={t('track.recenter')}
      />

      {/* The map is always dark (MAP_ALWAYS_DARK), so a plain white scrim
          reliably lifts the title/button above it regardless of the app's
          own light/dark setting — this is contrast against the MAP, not
          against the screen's theme. Removed during a session: it exists to
          make the idle title readable, and there is no idle title then. */}
      {!inSession && (
        <LinearGradient
          colors={['rgba(255,255,255,1)', 'rgba(255,255,255,0)']}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}

      {/* Session controls, top-right. Pause is yellow and Stop is red, so
          the destructive one is never the one you hit by muscle memory. */}
      {inSession && (
        <SafeAreaView style={styles.controls} edges={['top']}>
          <Animated.View entering={FadeIn.duration(400)} style={styles.controlRow}>
            <RoundButton
              label={paused ? t('track.resume') : t('track.pause')}
              onPress={toggleRun}
              background={PAUSE_COLOR}
              foreground="#1A1A1A"
              ios={paused ? 'play.fill' : 'pause.fill'}
              android={paused ? 'play_arrow' : 'pause'}
              disabled={resuming}
            />
            <RoundButton
              label={t('track.stop')}
              onPress={tracker.stop}
              background={STOP_COLOR}
              foreground="#FFFFFF"
              ios="stop.fill"
              android="stop"
            />
          </Animated.View>
        </SafeAreaView>
      )}

      <SafeAreaView style={styles.overlay} edges={['top']}>
        <View style={[styles.overlayInner, inSession && styles.overlayInnerSession]}>
          {inSession ? (
            <Animated.View entering={FadeInDown.duration(400)} style={styles.liveStats}>
              <Text style={[styles.liveTime, { color: '#FFFFFF' }]}>
                {formatDuration(tracker.elapsedS)}
              </Text>
              <Text style={[styles.liveDistance, { color: 'rgba(255,255,255,0.75)' }]}>
                {formatDistance(tracker.distanceM)}
                {paused ? `  ·  ${t('track.paused')}` : ''}
              </Text>
              {/* GPS state, shown plainly. Without this, "no permission",
                  "still acquiring" and "every fix rejected as inaccurate"
                  all look identical — a blank 0 — which is exactly how a
                  too-strict accuracy filter went unnoticed on device. */}
              {tracker.points.length === 0 && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t('track.searching')}
                  {tracker.lastAccuracyM !== null
                    ? `  ·  ${t('track.accuracy', { m: Math.round(tracker.lastAccuracyM) })}`
                    : ''}
                </Text>
              )}
              {/* Gated on the SIGNAL, not on points.length. It used to
                  require points.length === 0, which the cached-position
                  seed made almost impossible — so the one warning that
                  explains a stalled route was unreachable in exactly the
                  case it exists for (device report, 2026-08-27). */}
              {tracker.degradedSignal && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t('track.degradedSignal')}
                  {tracker.lastAccuracyM !== null
                    ? `  ·  ${t('track.accuracy', { m: Math.round(tracker.lastAccuracyM) })}`
                    : ''}
                </Text>
              )}
              {!tracker.degradedSignal && tracker.points.length < 2 && tracker.rejectedFixes > 2 && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t('track.weakSignal')}
                </Text>
              )}
              {/* A denied or dead watch, surfaced mid-run instead of quietly
                  looking like a working (if quiet) recording — see
                  geolocation.web.ts's header for the web watch-id bug this
                  guards against. Reuses the same copy as the pre-start
                  permission/unavailable notices; the difference is WHEN it
                  can now fire — a watch that dies after start() succeeded
                  used to have nowhere to surface at all. */}
              {tracker.error && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t(tracker.error === 'permission' ? 'track.permission' : 'track.unavailable')}
                </Text>
              )}
              {/* navigator.wakeLock.request() rejects when the document
                  isn't visible — a swallowed rejection here used to look
                  identical to a held lock, and the screen just dimmed with
                  nothing on screen explaining why. */}
              {tracker.keepAwakeFailed && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t('track.keepAwakeFailed')}
                </Text>
              )}
              {/* Set once the run has survived a background/foreground
                  cycle — see the visibilitychange handler in tracking.ts.
                  Sticky for the rest of the session rather than
                  self-clearing: it happened, and the route now has a real
                  gap in it, which is worth knowing even after the app is
                  back in focus. */}
              {tracker.gapCount > 0 && (
                <Text style={[styles.gpsState, { color: '#FFD166' }]}>
                  {t('track.backgroundGap')}
                </Text>
              )}

              {/* Recording is foreground-only, so locking the phone ends the
                  run. Saying so is not optional: the failure is silent and
                  costs the runner the whole session. */}
              <Text style={[styles.keepOpen, { color: 'rgba(255,255,255,0.6)' }]}>
                {t('track.keepOpen')}
              </Text>
            </Animated.View>
          ) : checkpoint ? (
            // An in-progress run recovered from run-checkpoint.ts after a
            // reload (see that file's header). Resume/Discard only — no
            // Start button here, so the runner can't accidentally abandon
            // recoverable progress by starting a fresh session over it.
            <>
              <Text style={[styles.stageTitle, { color: c.text }]}>
                {t('track.checkpointFound')}
              </Text>
              <View style={styles.summaryActions}>
                <PrimaryButton label={t('track.resume')} onPress={resumeCheckpoint} c={c} />
                <Pressable onPress={discardCheckpoint} accessibilityRole="button" hitSlop={10}>
                  <Text style={[styles.secondary, { color: c.textSecondary }]}>
                    {t('track.discard')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.stageTitle, { color: c.text }]}>{t('track.newSession')}</Text>
              {pending > 0 && (
                <Text style={[styles.overlayNotice, { color: c.text }]}>
                  {t('track.pendingUploads', { count: pending })}
                </Text>
              )}
              {tracker.error === 'permission' && (
                <Text style={[styles.overlayNotice, { color: c.text }]}>{t('track.permission')}</Text>
              )}
              {tracker.error === 'unavailable' && (
                <Text style={[styles.overlayNotice, { color: c.text }]}>{t('track.unavailable')}</Text>
              )}
              <PrimaryButton label={t('track.start')} onPress={tracker.start} c={c} />
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function RoundButton({
  label,
  onPress,
  background,
  foreground,
  ios,
  android,
  disabled,
}: {
  label: string;
  onPress: () => void;
  background: string;
  foreground: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={disabled ? { disabled: true } : {}}
      hitSlop={8}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: background, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      <Icon ios={ios} android={android} size={20} color={foreground} />
    </Pressable>
  );
}

function Stat({ label, value, c }: { label: string; value: string; c: Record<ThemeColor, string> }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.textSecondary }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  c,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  c: Record<ThemeColor, string>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : {}}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: c.accent, opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },
      ]}>
      {busy && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  stage: { flex: 1 },

  // box-none in style, not as a prop: the prop form is deprecated in
  // this RN version and warns on every render.
  overlay: { ...StyleSheet.absoluteFill, pointerEvents: 'box-none' },
  overlayInner: {
    flex: 1,
    pointerEvents: 'box-none',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    // Balances the floating tab bar so "centred" means centred in what the
    // eye actually sees, plus a small optical lift.
    paddingBottom: BottomTabInset + Spacing.three,
  },
  stageTitle: { fontSize: 30, fontWeight: '700', textAlign: 'center' },
  controls: { position: 'absolute', top: 0, right: 0, zIndex: 2 },
  controlRow: { flexDirection: 'row', gap: Spacing.two, padding: Spacing.three },
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  summaryClose: { position: 'absolute', top: 0, right: 0, zIndex: 2, padding: Spacing.three },
  // During a session the stats sit high rather than centred: the lower half
  // of the screen is where the 3D route and fence are, and centring the
  // numbers would park them right on top of it.
  overlayInnerSession: { justifyContent: 'flex-start', paddingTop: Spacing.six },
  overlayNotice: { fontSize: 14, lineHeight: 20, textAlign: 'center' },

  liveStats: { alignItems: 'center', gap: Spacing.one },
  liveTime: { fontSize: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  liveDistance: { fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  keepOpen: { fontSize: 12, textAlign: 'center', marginTop: Spacing.two, maxWidth: 260 },
  gpsState: { fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: Spacing.two, maxWidth: 280 },

  summary: { padding: Spacing.three, gap: Spacing.three, paddingBottom: BottomTabInset },
  summaryTitle: { fontSize: 28, fontWeight: '700' },
  fenceMapWrap: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
    aspectRatio: FENCE_MAP_ASPECT,
  },
  summaryActions: { gap: Spacing.three, alignItems: 'center', marginTop: Spacing.two },
  deleteConfirm: { gap: Spacing.two, alignItems: 'center', maxWidth: 300 },
  deleteConfirmActions: { flexDirection: 'row', gap: Spacing.four },

  stats: { flexDirection: 'row', gap: Spacing.three },
  stat: { flex: 1, gap: Spacing.half },
  statLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  statValue: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },

  notice: { fontSize: 14, lineHeight: 20 },
  noticeSmall: { fontSize: 12, lineHeight: 17 },
  spoils: {
    borderWidth: 2,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
  },
  spoilsArea: { fontSize: 20, fontWeight: '700' },
  spoilsFrom: { fontSize: 14, fontWeight: '600' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.five,
    borderRadius: 999,
    minWidth: 220,
  },
  primaryLabel: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  spinner: { marginRight: Spacing.one },
  secondary: { fontSize: 15, fontWeight: '600' },
});
