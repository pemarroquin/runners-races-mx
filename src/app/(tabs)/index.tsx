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
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FenceMap } from '@/components/fence-map';
import { NamePrompt } from '@/components/name-prompt';
import { TrackMap } from '@/components/track-map';
import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { getHomeZone } from '@/lib/home-point';
import { saveLastRunDebug } from '@/lib/last-run-debug';
import { maskPath, type MaskResult } from '@/lib/privacy-zone';
import { incrementPilotCounter } from '@/lib/pilot-instrumentation';
import { clearCheckpoint, loadCheckpoint, type RunCheckpoint } from '@/lib/run-checkpoint';
import { notifyRunSaved } from '@/lib/save-events';
import { buildFence, type FenceResult } from '@/lib/territory';
import { fetchRunSpoils, uploadRun, type RunSpoils } from '@/lib/territory-sync';
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
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  // What this run took from other runners. Null until the upload lands —
  // the Phase 3 trigger runs during the insert, so the answer exists by the
  // time uploadRun returns, but only a read can tell us what it was.
  const [spoils, setSpoils] = useState<RunSpoils | null>(null);
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
  // Mirrors queuedId for the background flush effect below, which is
  // deliberately gated on `[isFocused]` alone (it must not re-run on every
  // local state change — see that effect's own comment) and so reads this
  // from a .then() callback rather than a render, same reason autoSavedRef
  // mirrors a ref instead of relying on a state closure.
  const queuedIdRef = useRef<string | null>(null);
  useEffect(() => {
    queuedIdRef.current = queuedId;
  }, [queuedId]);
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

  // Deleting a saved run is no longer an action on THIS screen (2026-09-02
  // redesign) — it moved to the Territories map's per-fence bubble, which
  // keeps its own independent delete state. See myraces.tsx.

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
        // Fires even if this effect has already gone stale (the runner left
        // the Track tab while the flush was still in flight) — the upload
        // itself already happened against the server regardless of whether
        // this screen is still around to react to it, and a screen sitting
        // on Territories needs to hear about exactly that. See
        // save-events.ts; this is the fix for the confirmed "queued run
        // promotes to saved while the runner is on the Territories screen"
        // race. Covers every run this flush drained, not just the one this
        // screen happens to be tracking (see `current` below).
        if (result.resolved.length > 0) notifyRunSaved();
        if (stale) return;
        setPending(result.remaining);
        // Reconcile against whatever THIS screen is currently showing. The
        // flush above runs independently of what's on screen — it drains
        // the whole on-disk queue, not just "the run the summary is
        // currently displaying" — so if the run on screen is the one that
        // just resolved, local state (saveState/savedRunId/queuedId) would
        // otherwise go stale. The session-end screen no longer has any
        // Delete/Retry UI to defend (that moved to the Territories map —
        // see myraces.tsx), but `saveState === 'saved'` still gates the
        // first-save name prompt (NamePrompt, below) — without this, a
        // save that completes in the background while this screen is still
        // open would never trigger it.
        const current = queuedIdRef.current;
        if (!current) return;
        const resolved = result.resolved.find((r) => r.id === current);
        if (resolved) {
          setSaveState('saved');
          setSavedRunId(resolved.runId);
          setQueuedId(null);
          clearCheckpoint();
          // Best-effort, same as save()'s own success path — a failed read
          // here just means no "you took territory" line, never a lost save.
          void fetchRunSpoils(resolved.runId).then((taken) => {
            if (!stale && taken.ok && taken.spoils.runsAffected > 0) setSpoils(taken.spoils);
          });
        } else if (result.abandonedIds.includes(current)) {
          // Retried MAX_ATTEMPTS times and given up — the run genuinely
          // will not upload. Not surfaced with copy on this screen (see the
          // file header above the 'finished' branch); this only stops
          // `queuedId` from pointing at a queue entry that no longer exists.
          setQueuedId(null);
        }
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

  const save = useCallback(async () => {
    if (!fence || masked === null || tracker.startedAt === null || tracker.endedAt === null) {
      return;
    }
    const token = ++saveTokenRef.current;
    setSaveState('saving');
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
    // Fires even if the token below turns out to be stale — the row is
    // genuinely saved on the server the instant uploadRun resolves ok, and
    // any screen showing this runner's territories needs to hear about that
    // regardless of what THIS screen does with the outcome locally. See
    // save-events.ts; this is the fix for the confirmed "Territories tab
    // renders empty right after a real, successful save" race — the runner
    // can reach that screen before this await even resolves.
    if (outcome.ok) notifyRunSaved();
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

  // Local teardown for closing the finished-run map screen (the ✓ button) —
  // always safe, never deletes anything, server OR queue: the server row if
  // any stays exactly as saved, and a still-queued run is left on disk for
  // a later flush to pick up. Renamed from the pre-auto-save `discard`: this
  // function no longer decides whether anything is thrown away (there is no
  // delete action on this screen any more — see below), it only resets the
  // SCREEN so the next run can start.
  //
  // This does NOT touch queuedId/removeQueued — it used to, and that was a
  // bug: closing the screen silently deleted the runner's only copy of a
  // run that hadn't reached the server yet, defeating the whole point of
  // the retry queue (see upload-queue.ts's own header).
  const resetLocal = useCallback(() => {
    // Invalidate any in-flight save FIRST — see saveTokenRef's own comment.
    saveTokenRef.current++;
    // Let the NEXT run auto-save too.
    autoSavedRef.current = false;
    setSaveState('idle');
    setSavedRunId(null);
    setSpoils(null);
    setMasked(null);
    setFence(null);
    setQueuedId(null);
    tracker.reset();
  }, [tracker]);

  // The finished run gets a full-screen map of just what it captured
  // (2026-09-02 redesign, replacing the old scrolling stats-card summary):
  // saving already happens automatically and silently (see the auto-save
  // effect above), so there is nothing left to DECIDE here — this screen
  // only shows what happened and gets out of the way. No Save/Retry/Delete
  // UI: a failed or still-queued upload stays invisible here (it resolves
  // itself via the background flush effect, or is visible with Retry/Delete
  // once the runner reaches the Territories map — see myraces.tsx) and is
  // never surfaced with copy on this screen. The only control is ✓, top
  // right, which tears the screen down and readies the app for a new run —
  // same resetLocal() the old X button called.
  if (tracker.status === 'finished') {
    // Edge case: nothing to put on a map. Either genuinely nothing was
    // recorded, or the whole run fell inside the runner's privacy zone
    // (maskPath trims it to nothing rather than upload a route that would
    // expose home). No FenceMap in either case — just say why, plus ✓.
    if (!fence) {
      return (
        <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
          <View style={styles.summaryClose}>
            <RoundButton
              label={t('track.done')}
              onPress={resetLocal}
              background={c.backgroundElement}
              foreground={c.text}
              ios="checkmark"
              android="check"
            />
          </View>
          <View style={styles.overlayInner}>
            <Text style={[styles.summaryTitle, { color: c.text }]}>{t('track.summaryTitle')}</Text>
            <Text style={[styles.notice, { color: masked?.fullyInsideZone ? c.accent : c.textSecondary }]}>
              {masked?.fullyInsideZone ? t('track.allInsideZone') : t('track.noFence')}
            </Text>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <View style={styles.stage}>
        {/* Top-down (bearing 0, pitch 0), fit to just this fence — only the
            territory THIS session captured, no other saved territories (see
            the Territories map, myraces.tsx, for "all of them at once"). */}
        <FenceMap
          geometry={fence.geometry.geometry}
          // The MASKED path, never tracker.points — privacy-zone trimming
          // exists precisely so start/end aren't exposed, and this map is a
          // shareable surface. `masked` is only set once tracker.status is
          // 'finished' (see the effect above), which is exactly when this
          // branch renders.
          path={masked?.points ?? []}
          color={fenceColor}
          others={[]}
          excludeId={savedRunId}
          controls={{
            zoomInLabel: t('track.zoomIn'),
            zoomOutLabel: t('track.zoomOut'),
            recenterLabel: t('track.recenterFence'),
          }}
        />
        <SafeAreaView style={styles.overlay} edges={['top']} pointerEvents="box-none">
          <View style={styles.sessionEndTopBar} pointerEvents="box-none">
            <View style={[styles.sessionEndStatsBar, { backgroundColor: 'rgba(20,20,20,0.65)' }]}>
              <Stat label={t('track.time')} value={formatDuration(tracker.elapsedS)} c={STATS_ON_DARK} />
              <Stat label={t('track.distance')} value={formatDistance(tracker.distanceM)} c={STATS_ON_DARK} />
              <Stat label={t('track.area')} value={formatArea(fence.areaM2)} c={STATS_ON_DARK} />
            </View>
            <RoundButton
              label={t('track.done')}
              onPress={resetLocal}
              background="rgba(20,20,20,0.65)"
              foreground="#ffffff"
              ios="checkmark"
              android="check"
            />
          </View>
        </SafeAreaView>

        {/* Informational-only notices — none of these are actionable here,
            they just explain the number/shape above. Bottom of the screen,
            above the map's own zoom/recenter controls. */}
        <View style={styles.sessionEndBottomOverlay} pointerEvents="box-none">
          {tracker.gapCount > 0 && (
            <Text style={[styles.noticeSmall, styles.onDarkNotice]}>
              {t('track.gapNotice', {
                count: tracker.gapCount,
                duration: formatDuration(tracker.gapDurationMs / 1000),
                credited: formatDistance(tracker.creditedGapM),
                uncredited: formatDistance(
                  Math.max(0, tracker.gapChordM - tracker.creditedGapM),
                ),
              })}
            </Text>
          )}
          {masked?.masked && !masked.fullyInsideZone && (
            <Text style={[styles.noticeSmall, styles.onDarkNotice]}>{t('track.zoneMasked')}</Text>
          )}

          {/* First-save leaderboard name prompt — fully self-contained,
              decides on its own whether there's anything to ask (see
              name-prompt.tsx). Mounted only once a save has actually
              succeeded, never before or during. */}
          {saveState === 'saved' && <NamePrompt />}

          {/* Phase 3's payoff. Taking ground off another runner is the most
              interesting thing that can happen in a session, so it earns a
              banner even on this stripped-down screen. */}
          {spoils && (
            <Animated.View
              entering={FadeInDown.duration(400).delay(200)}
              style={[styles.spoils, { borderColor: fenceColor, backgroundColor: 'rgba(20,20,20,0.65)' }]}>
              <Text style={[styles.spoilsArea, { color: '#ffffff' }]}>
                {t('track.tookArea', { area: formatArea(spoils.areaTakenM2) })}
              </Text>
              <Text style={[styles.spoilsFrom, { color: 'rgba(255,255,255,0.7)' }]}>
                {t('track.tookFrom', { count: spoils.runnersAffected })}
              </Text>
            </Animated.View>
          )}
        </View>
      </View>
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
        overviewLabel={t('track.overview')}
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

function Stat({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: { text: string; textSecondary: string };
}) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.textSecondary }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

// The session-end map's stats bar always sits over a dark map, regardless
// of the app's own light/dark theme — same reasoning as track-map's
// camera-control icons being hardcoded white (see fence-map's MapButton).
const STATS_ON_DARK = { text: '#ffffff', textSecondary: 'rgba(255,255,255,0.7)' };

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

  summaryTitle: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
  summaryActions: { gap: Spacing.three, alignItems: 'center', marginTop: Spacing.two },

  // Session-end map screen (2026-09-02 redesign) — chrome floating over
  // FenceMap, not a scrolling card. Fixed dark tint regardless of the app's
  // own theme, same reasoning as STATS_ON_DARK above: this always sits over
  // a dark map, never over the app's own background.
  sessionEndTopBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  sessionEndStatsBar: {
    flex: 1,
    flexDirection: 'row',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  sessionEndBottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: Spacing.two,
    padding: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
  },
  onDarkNotice: { color: 'rgba(255,255,255,0.85)' },

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
