// Settings' account-linking form — lives inside settings.tsx's Profile
// section, replacing the static "no sign-in yet" paragraphs it shipped
// with. See src/lib/account.ts's header for why this exists and what LINK
// vs SIGN IN mean; this component only owns the two-step (email -> code)
// form and the states around it.
//
// Self-contained like NamePrompt: fetches its own status on mount/focus and
// decides everything about what to show. The host only decides WHERE to
// mount it.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  fetchAccountStatus,
  startEmailAuth,
  verifyEmailAuth,
  type AccountStatus,
} from '@/lib/account';
import { useI18n } from '@/lib/i18n';
import { Spacing, type ThemeColor } from '@/constants/theme';

type Step =
  | 'loading' // fetching current status
  | 'hidden' // disabled build, or fetch failed — fail quiet, same as NamePrompt
  | 'linked' // status.linked === true, nothing to do
  | 'email' // idle form: enter email
  | 'sending' // startEmailAuth in flight
  | 'code' // code sent, awaiting entry — carries which flow it is
  | 'verifying' // verifyEmailAuth in flight
  | 'failed'; // a step errored — form stays up so it can be retried

export function AccountLink({ c }: { c: Record<ThemeColor, string> }) {
  const { t } = useI18n();

  const [step, setStep] = useState<Step>('loading');
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'link' | 'signin' | null>(null);
  const [errorKey, setErrorKey] = useState<'invalid' | 'network' | null>(null);

  useEffect(() => {
    let stale = false;
    const id = setTimeout(() => {
      fetchAccountStatus().then((outcome) => {
        if (stale) return;
        if (!outcome.ok) {
          // 'disabled' (no server configured) or 'auth'/'network' (can't
          // tell right now) — same fail-quiet reasoning as NamePrompt: this
          // is a settings screen, not a blocking gate, so an unreadable
          // status just hides the form rather than showing a scary error.
          setStep('hidden');
          return;
        }
        setStatus(outcome.status);
        setStep(outcome.status.linked ? 'linked' : 'email');
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  const sendCode = useCallback(async () => {
    setStep('sending');
    setErrorKey(null);
    const outcome = await startEmailAuth(email.trim());
    if (!outcome.ok) {
      setErrorKey(outcome.reason === 'invalid' ? 'invalid' : 'network');
      setStep('failed');
      return;
    }
    setMode(outcome.mode);
    setCode('');
    setStep('code');
  }, [email]);

  const verify = useCallback(async () => {
    if (!mode) return;
    setStep('verifying');
    setErrorKey(null);
    const outcome = await verifyEmailAuth(email.trim(), code.trim(), mode);
    if (!outcome.ok) {
      setErrorKey(outcome.reason === 'invalid' ? 'invalid' : 'network');
      setStep('failed');
      return;
    }
    setStatus({ linked: true, email: outcome.email });
    setStep('linked');
  }, [email, code, mode]);

  const backToEmail = useCallback(() => {
    setErrorKey(null);
    setMode(null);
    setStep('email');
  }, []);

  if (step === 'loading' || step === 'hidden') return null;

  if (step === 'linked' && status?.linked) {
    return (
      <View style={styles.block}>
        <Text style={[styles.accountTitle, { color: c.text }]}>{t('settings.accountTitle')}</Text>
        <Text style={[styles.paragraph, { color: c.textSecondary }]}>
          {t('settings.accountLinked', { email: status.email })}
        </Text>
      </View>
    );
  }

  const showCodeStep = step === 'code' || step === 'verifying' || (step === 'failed' && mode !== null);
  const busy = step === 'sending' || step === 'verifying';

  return (
    <View style={styles.block}>
      <Text style={[styles.accountTitle, { color: c.text }]}>{t('settings.accountTitle')}</Text>
      <Text style={[styles.paragraph, { color: c.textSecondary }]}>{t('settings.accountBody')}</Text>

      {!showCodeStep ? (
        <>
          <TextInput
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={() => {
              if (email.trim().length > 0 && !busy) void sendCode();
            }}
            editable={!busy}
            placeholder={t('settings.accountEmailPlaceholder')}
            placeholderTextColor={c.textSecondary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel={t('settings.accountEmailPlaceholder')}
            style={[styles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
          />
          {errorKey && (
            <Text style={[styles.error, { color: c.accent }]}>
              {t(errorKey === 'invalid' ? 'settings.accountEmailInvalid' : 'settings.accountFailed')}
            </Text>
          )}
          <Pressable
            onPress={() => void sendCode()}
            disabled={busy || email.trim().length === 0}
            accessibilityRole="button"
            hitSlop={10}
            style={[
              styles.actionButton,
              { backgroundColor: c.accent, opacity: busy || email.trim().length === 0 ? 0.4 : 1 },
            ]}>
            {step === 'sending' && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
            <Text style={styles.actionLabel}>
              {step === 'sending' ? t('settings.accountSending') : t('settings.accountSendCode')}
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.paragraph, { color: c.textSecondary }]}>
            {t('settings.accountCodeSent', { email: email.trim() })}
          </Text>
          {/* Only the sign-in path replaces this device's local identity —
              spelled out before the runner commits to entering the code,
              since it can't be undone from here (see account.ts's header). */}
          {mode === 'signin' && (
            <Text style={[styles.warning, { color: c.accent }]}>{t('settings.accountSwitchWarning')}</Text>
          )}
          <TextInput
            value={code}
            onChangeText={setCode}
            onSubmitEditing={() => {
              if (code.trim().length > 0 && !busy) void verify();
            }}
            editable={!busy}
            placeholder={t('settings.accountCodePlaceholder')}
            placeholderTextColor={c.textSecondary}
            keyboardType="number-pad"
            returnKeyType="done"
            autoFocus
            accessibilityLabel={t('settings.accountCodePlaceholder')}
            style={[styles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
          />
          {errorKey && (
            <Text style={[styles.error, { color: c.accent }]}>
              {t(errorKey === 'invalid' ? 'settings.accountCodeInvalid' : 'settings.accountFailed')}
            </Text>
          )}
          <View style={styles.actions}>
            <Pressable onPress={backToEmail} disabled={busy} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.secondaryLabel, { color: c.textSecondary, opacity: busy ? 0.5 : 1 }]}>
                {t('settings.accountChangeEmail')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void verify()}
              disabled={busy || code.trim().length === 0}
              accessibilityRole="button"
              hitSlop={10}
              style={[
                styles.actionButton,
                { backgroundColor: c.accent, opacity: busy || code.trim().length === 0 ? 0.4 : 1 },
              ]}>
              {step === 'verifying' && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
              <Text style={styles.actionLabel}>
                {step === 'verifying' ? t('settings.accountVerifying') : t('settings.accountVerify')}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Spacing.two, marginTop: Spacing.three },
  accountTitle: { fontSize: 15, fontWeight: '700' },
  paragraph: { fontSize: 13, lineHeight: 18 },
  warning: { fontSize: 12, lineHeight: 17, fontWeight: '600' },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  error: { fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  secondaryLabel: { fontSize: 14, fontWeight: '600' },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  actionLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  spinner: { marginRight: Spacing.one },
});
